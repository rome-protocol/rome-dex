// lib/router.ts — the EVM lane through RomeDexRouter (single-leg, custody-less).
//
// Raw CPI.invoke calldata carries ~96B per account meta → a swap is 1540B and
// holder-stages into 4 Solana legs. The router stores each pool's accounts
// on-chain and assembles the metas in EVM memory, so user calldata is ~132B
// and the swap lands in ONE atomic leg (proven: harness/router.test.mjs).
//
// Trust model (proven on-chain, harness/probe-delegate.mjs): the user grants
// the ROUTER's external_auth PDA an SPL delegate allowance on each ATA they
// spend from — the exact ERC-20 approve-once UX. The router derives every
// user ATA from msg.sender on-chain, so an allowance can never be spent to an
// attacker's account. Tokens move user-ATA → user-ATA; the router holds nothing.
//
// Router address + dex program come from the active ChainConfig (cfg.dex.router
// / cfg.dex.dexProgram), no longer a static JSON import.
"use client";

import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  CPI_PRECOMPILE, evmPdaFor, ataFor, poolForTier, type Pool,
} from "./walletActions";
import { resolveGas } from "./gas";
import { requireEvmProvider } from "./evmWallet";
import type { ChainConfig } from "./chains/types";

const ROUTER_IFACE = new ethers.Interface([
  "function swap(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minOut)",
  "function swapExactOut(bytes32 poolId, bool aToB, uint64 amountOut, uint64 maxIn)",
  "function addLiquidity(bytes32 poolId, uint64 lp, uint64 maxA, uint64 maxB)",
  "function removeLiquidity(bytes32 poolId, uint64 lp, uint64 minA, uint64 minB)",
  "function zapIn(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minLp, uint64 maxOther)",
]);
const CPI_IFACE = new ethers.Interface([
  "function invoke(bytes32 program_id, (bytes32 pubkey, bool is_signer, bool is_writable)[] accounts, bytes data)",
]);
const HELPER_ADDRESS = "0xff00000000000000000000000000000000000009";
const HELPER_IFACE = new ethers.Interface([
  "function create_ata(address user, bytes32 mint)",
]);

const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/**
 * Encode an SPL-Token `Approve` (tag 4 + u64 amount). Security: the delegate is
 * scoped to exactly the amount this op needs — never an unbounded (u64-max)
 * grant, which a later router compromise could drain from the user's whole ATA.
 * Each op re-approves what it will spend (the delegate decrements to ~0 on use).
 */
export function buildApproveData(needed: bigint): Buffer {
  const d = Buffer.alloc(9);
  d[0] = 4; // SPL-Token Approve
  d.writeBigUInt64LE(needed, 1);
  return d;
}

const b32 = (pk: PublicKey) => "0x" + Buffer.from(pk.toBuffer()).toString("hex");

const connFor = (chain: ChainConfig) => new Connection(chain.solanaRpc, "confirmed");
export const routerAddress = (chain: ChainConfig): string => chain.dex.router;
export const routerPda = (chain: ChainConfig): PublicKey =>
  evmPdaFor(chain.dex.router, chain.romeEvmProgramId);
export const poolIdOf = (pool: Pool): string => b32(pool.swapState);

async function sendViaEvm(chain: ChainConfig, eoa: string, to: string, data: string, priorityFeeGwei?: number): Promise<string> {
  const provider = new ethers.BrowserProvider(requireEvmProvider(), { chainId: Number(chain.chainId), name: chain.name.toLowerCase() });
  const signer = await provider.getSigner();
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit } = await resolveGas({ from: eoa, to, data, priorityFeeGwei }, chain.evmRpc);
  const tx = await signer.sendTransaction({ to, data, type: 2, maxFeePerGas, maxPriorityFeePerGas, gasLimit, value: 0n });
  await tx.wait(1);
  return tx.hash;
}

/**
 * Ensure the caller's ATA for `mint` exists (owned by their external_auth PDA).
 *
 * ATA creation is now folded INTO the router's swap / addLiquidity /
 * removeLiquidity / zapIn (create+CPI lands in one tx on Rome — verified on
 * Hadrian, harness/probe-crux.mjs), so callers no longer pre-create for those.
 * The ONE case that still needs an up-front create is an ATA the caller must
 * grant an SPL delegate on BEFORE the op runs: SPL Approve requires the token
 * account to already exist. That is zapIn's output side (produced by the swap,
 * pulled by the deposit via the router-PDA delegate). This creates it via the
 * HELPER precompile directly. No-op when the ATA already exists.
 */
export async function ensureAtaExists(
  chain: ChainConfig, eoa: string, mint: PublicKey, priorityFeeGwei?: number,
): Promise<string | null> {
  const userPda = evmPdaFor(eoa, chain.romeEvmProgramId);
  const ata = await ataFor(userPda, mint);
  if (await connFor(chain).getAccountInfo(ata)) return null;
  const data = HELPER_IFACE.encodeFunctionData("create_ata", [eoa, b32(mint)]);
  return sendViaEvm(chain, eoa, HELPER_ADDRESS, data, priorityFeeGwei);
}

/** Does `ata` already delegate ≥ `needed` to the router PDA? */
export async function allowanceOk(chain: ChainConfig, ata: PublicKey, needed: bigint): Promise<boolean> {
  try {
    const acct = await getAccount(connFor(chain), ata);
    return !!acct.delegate && acct.delegate.equals(routerPda(chain)) && acct.delegatedAmount >= needed;
  } catch {
    return false;
  }
}

/**
 * Approve the router PDA an SPL delegate on `ata`, scoped to exactly `needed`.
 * Sent via the direct CPI lane (the sender's own PDA signs the approve — the
 * one flow where Rome auto-signs the origin PDA). No-op if already approved.
 * Returns the approve tx hash, or null when no approval was needed.
 */
export async function ensureApproved(
  chain: ChainConfig, eoa: string, ata: PublicKey, needed: bigint, priorityFeeGwei?: number,
): Promise<string | null> {
  if (await allowanceOk(chain, ata, needed)) return null;
  const userPda = evmPdaFor(eoa, chain.romeEvmProgramId);
  const d = buildApproveData(needed);
  const calldata = CPI_IFACE.encodeFunctionData("invoke", [
    b32(SPL_TOKEN),
    [
      [b32(ata), false, true],
      [b32(routerPda(chain)), false, false],
      [b32(userPda), true, false],
    ],
    "0x" + d.toString("hex"),
  ]);
  return sendViaEvm(chain, eoa, CPI_PRECOMPILE, calldata, priorityFeeGwei);
}

export interface RouterSwapParams {
  chain: ChainConfig;
  eoa: string;
  dir: "AtoB" | "BtoA";
  mode: "exactIn" | "exactOut";
  tier?: string;
  pairId?: string;
  amountIn?: bigint;
  minOut?: bigint;
  amountOut?: bigint;
  maxIn?: bigint;
  priorityFeeGwei?: number;
  /** Called when an approve tx is needed, before it is sent (drives UI copy). */
  onApprove?: () => void;
  /** Fine-grained stage callbacks for flow tracking (all optional):
   *  approve → the approval prompt is about to open; approved → the approval
   *  landed; sign → the swap prompt is about to open. */
  onStage?: (stage: "approve" | "approved" | "sign") => void;
}

/** Swap through the router: approve-once (if needed) then a ~132B, 1-leg swap. */
export async function routerSwap(p: RouterSwapParams): Promise<string> {
  const { chain } = p;
  const pool = poolForTier(chain, p.tier, p.pairId);
  const userPda = evmPdaFor(p.eoa, chain.romeEvmProgramId);
  const srcMint = p.dir === "AtoB" ? pool.mintA : pool.mintB;
  const srcAta = await ataFor(userPda, srcMint);
  const spend = p.mode === "exactIn" ? p.amountIn! : p.maxIn!;
  if (!(await allowanceOk(chain, srcAta, spend))) {
    p.onApprove?.();
    p.onStage?.("approve");
    await ensureApproved(chain, p.eoa, srcAta, spend, p.priorityFeeGwei);
    p.onStage?.("approved");
  }
  p.onStage?.("sign");
  const aToB = p.dir === "AtoB";
  const data = p.mode === "exactIn"
    ? ROUTER_IFACE.encodeFunctionData("swap", [poolIdOf(pool), aToB, p.amountIn!, p.minOut ?? 0n])
    : ROUTER_IFACE.encodeFunctionData("swapExactOut", [poolIdOf(pool), aToB, p.amountOut!, p.maxIn!]);
  return sendViaEvm(chain, p.eoa, routerAddress(chain), data, p.priorityFeeGwei);
}

export interface RouterLiquidityParams {
  chain: ChainConfig;
  eoa: string;
  tier?: string;
  pairId?: string;
  lp: bigint;
  a: bigint; // maxA (add) | minA (remove)
  b: bigint; // maxB (add) | minB (remove)
  priorityFeeGwei?: number;
  /** Called when an approve prompt is needed, before it opens (drives UI copy). */
  onApprove?: () => void;
  /** Flow-tracking stage callbacks (all optional): approve → the first approval
   *  prompt is about to open; approved → every approval landed; sign → the
   *  add/remove prompt is about to open. Mirrors routerSwap. */
  onStage?: (stage: "approve" | "approved" | "sign") => void;
}

export async function routerAddLiquidity(p: RouterLiquidityParams): Promise<string> {
  const { chain } = p;
  const pool = poolForTier(chain, p.tier, p.pairId);
  const userPda = evmPdaFor(p.eoa, chain.romeEvmProgramId);
  // The router creates the LP output ATA (always new on a first deposit) + both
  // token ATAs in-flow, then deposits — one tx. We only need the two token ATAs
  // approved as delegate sources; they already exist because the user must hold
  // both tokens to deposit them.
  const [ataA, ataB] = [await ataFor(userPda, pool.mintA), await ataFor(userPda, pool.mintB)];
  const pending: [PublicKey, bigint][] = [];
  for (const [ata, needed] of [[ataA, p.a], [ataB, p.b]] as const) {
    if (!(await allowanceOk(chain, ata, needed))) pending.push([ata, needed]);
  }
  if (pending.length) {
    p.onStage?.("approve");
    for (const [ata, needed] of pending) {
      p.onApprove?.();
      await ensureApproved(chain, p.eoa, ata, needed, p.priorityFeeGwei);
    }
    p.onStage?.("approved");
  }
  p.onStage?.("sign");
  const data = ROUTER_IFACE.encodeFunctionData("addLiquidity", [poolIdOf(pool), p.lp, p.a, p.b]);
  return sendViaEvm(chain, p.eoa, routerAddress(chain), data, p.priorityFeeGwei);
}

export async function routerRemoveLiquidity(p: RouterLiquidityParams): Promise<string> {
  const { chain } = p;
  const pool = poolForTier(chain, p.tier, p.pairId);
  const userPda = evmPdaFor(p.eoa, chain.romeEvmProgramId);
  const lpAta = await ataFor(userPda, pool.poolMint);
  if (!(await allowanceOk(chain, lpAta, p.lp))) {
    p.onStage?.("approve");
    p.onApprove?.();
    await ensureApproved(chain, p.eoa, lpAta, p.lp, p.priorityFeeGwei);
    p.onStage?.("approved");
  }
  p.onStage?.("sign");
  const data = ROUTER_IFACE.encodeFunctionData("removeLiquidity", [poolIdOf(pool), p.lp, p.a, p.b]);
  return sendViaEvm(chain, p.eoa, routerAddress(chain), data, p.priorityFeeGwei);
}

export interface RouterZapParams {
  chain: ChainConfig;
  eoa: string;
  tier?: string;
  pairId?: string;
  dir: "AtoB" | "BtoA";
  amountIn: bigint;
  minLp: bigint;
  maxOther: bigint;
  priorityFeeGwei?: number;
  onApprove?: () => void;
}

/** Atomic zap-in via the router: swap + deposit in ONE EVM tx (all-or-nothing). */
export async function routerZapIn(p: RouterZapParams): Promise<string> {
  const { chain } = p;
  const pool = poolForTier(chain, p.tier, p.pairId);
  const userPda = evmPdaFor(p.eoa, chain.romeEvmProgramId);
  // zapIn is the heaviest op (swap + deposit ≈ Rome's atomic CU ceiling), so —
  // unlike swap/addLiquidity — it does NOT fold ATA creation in-contract (that
  // tips it over the ceiling). Provision the two ATAs it needs as separate,
  // lightweight in-flow txs first: the OUTPUT-side ATA (produced by the swap;
  // must exist for its delegate approve) and the LP ATA (the deposit mints into
  // it). The input side already exists (the user holds it). No pre-creation by us.
  const outMint = p.dir === "AtoB" ? pool.mintB : pool.mintA;
  await ensureAtaExists(chain, p.eoa, outMint, p.priorityFeeGwei);
  await ensureAtaExists(chain, p.eoa, pool.poolMint, p.priorityFeeGwei);
  const [ataA, ataB] = [await ataFor(userPda, pool.mintA), await ataFor(userPda, pool.mintB)];
  const spendA = p.dir === "AtoB" ? p.amountIn + p.maxOther : p.maxOther;
  const spendB = p.dir === "AtoB" ? p.maxOther : p.amountIn + p.maxOther;
  for (const [ata, needed] of [[ataA, spendA], [ataB, spendB]] as const) {
    if (!(await allowanceOk(chain, ata, needed))) {
      p.onApprove?.();
      await ensureApproved(chain, p.eoa, ata, needed, p.priorityFeeGwei);
    }
  }
  const data = ROUTER_IFACE.encodeFunctionData("zapIn",
    [poolIdOf(pool), p.dir === "AtoB", p.amountIn, p.minLp, p.maxOther]);
  return sendViaEvm(chain, p.eoa, routerAddress(chain), data, p.priorityFeeGwei);
}
