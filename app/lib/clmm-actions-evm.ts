"use client";

// CLMM position actions — EVM lane (⑤c). An EVM wallet drives the same
// open/increase/decrease/collect/close via the CPI precompile; Rome auto-signs
// the EOA's external_auth PDA as the position owner+payer. Account layouts +
// instruction bytes mirror the Solana lane (clmm-actions.ts) and the proven
// harness/clmm-evm.test.mjs. Liquidity ops are direct-CPI (NOT the router — a
// contract can't sign the user's position PDA). Cold PDA is bootstrapped from
// gas via swap_gas_to_lamports so a brand-new EVM user can open a position.
// Pool accounts + endpoints come from the active chain's clmm config.

import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ethers } from "ethers";
import { CPI_PRECOMPILE, evmPdaFor } from "./walletActions";
import { resolveGas } from "./gas";
import { requireEvmProvider } from "./evmWallet";
import { clmmConfig, type ClmmConfigFlat } from "./clmm";
import type { ChainConfig } from "./chains/types";
import { tickArrayStartIndex } from "./clmm-quote";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const HELPER = "0xff00000000000000000000000000000000000009";
// A cold external_auth PDA below this (lamports) gets a one-time gas→SOL top-up
// so it can pay the position-account rent. Mirrors the orders-lane pattern.
const PDA_RENT_FLOOR = 3_000_000n;
const PDA_RENT_TOPUP = 12_000_000n;

const CPI_IFACE = new ethers.Interface(["function invoke(bytes32 program_id, (bytes32 pubkey, bool is_signer, bool is_writable)[] accounts, bytes data)"]);
const HELPER_IFACE = new ethers.Interface(["function swap_gas_to_lamports(uint64 lamports)", "function create_ata(address user, bytes32 mint)"]);

const u64 = (v: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const u128 = (v: bigint): Buffer => { const b = Buffer.alloc(16); b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(v >> 64n, 8); return b; };
const i32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const b32 = (pk: PublicKey): string => "0x" + Buffer.from(pk.toBuffer()).toString("hex");
const meta = (pk: PublicKey, s: boolean, w: boolean) => [b32(pk), s, w] as const;

const openData = (l: number, u: number, bump: number) => Buffer.concat([Buffer.from([2]), i32(l), i32(u), Buffer.from([bump])]);
const incData = (liq: bigint, m0: bigint, m1: bigint) => Buffer.concat([Buffer.from([3]), u128(liq), u64(m0), u64(m1)]);
const decData = (liq: bigint, m0: bigint, m1: bigint) => Buffer.concat([Buffer.from([4]), u128(liq), u64(m0), u64(m1)]);
const collectData = () => Buffer.from([5]);
const closeData = () => Buffer.from([6]);

function cfgOf(chain: ChainConfig): ClmmConfigFlat {
  const c = clmmConfig(chain);
  if (!c) throw new Error("no clmm on this chain");
  return c;
}
const connFor = (chain: ChainConfig) => new Connection(chain.solanaRpc, "confirmed");

export function positionPda(chain: ChainConfig, owner: PublicKey, lower: number, upper: number, cfgIn?: ClmmConfigFlat): [PublicKey, number] {
  const cfg = cfgIn ?? cfgOf(chain);
  return PublicKey.findProgramAddressSync([Buffer.from("position"), new PublicKey(cfg.pool).toBuffer(), owner.toBuffer(), i32(lower), i32(upper)], new PublicKey(cfg.program));
}
export function tickArrayFor(chain: ChainConfig, tick: number, cfgIn?: ClmmConfigFlat): PublicKey | null {
  const cfg = cfgIn ?? cfgOf(chain);
  const key = cfg.tickArrays[String(tickArrayStartIndex(tick, cfg.tickSpacing))];
  return key ? new PublicKey(key) : null;
}
const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

async function sendEvm(chain: ChainConfig, eoa: string, to: string, data: string): Promise<string> {
  const provider = new ethers.BrowserProvider(requireEvmProvider(), { chainId: Number(chain.chainId), name: chain.name.toLowerCase() });
  const signer = await provider.getSigner();
  const g = await resolveGas({ from: eoa, to, data }, chain.evmRpc);
  const tx = await signer.sendTransaction({ to, data, type: 2, value: 0n, ...g });
  await tx.wait(1);
  return tx.hash;
}
const cpi = (chain: ChainConfig, eoa: string, accounts: readonly (readonly [string, boolean, boolean])[], data: Buffer, cfgIn?: ClmmConfigFlat) =>
  sendEvm(chain, eoa, CPI_PRECOMPILE, CPI_IFACE.encodeFunctionData("invoke", [b32(new PublicKey((cfgIn ?? cfgOf(chain)).program)), accounts, "0x" + data.toString("hex")]));

const liqMetas = (cfg: ClmmConfigFlat, owner: PublicKey, position: PublicKey, taL: PublicKey, taU: PublicKey) => [
  meta(new PublicKey(cfg.pool), false, true), meta(position, false, true), meta(owner, true, false),
  meta(ata(owner, new PublicKey(cfg.mint0)), false, true), meta(ata(owner, new PublicKey(cfg.mint1)), false, true),
  meta(new PublicKey(cfg.vault0), false, true), meta(new PublicKey(cfg.vault1), false, true), meta(TOKEN, false, false),
  meta(taL, false, true), meta(taU, false, true),
];

export interface EvmStage { (s: "setup" | "confirm"): void }

export interface EvmOpenParams {
  eoa: string; tickLower: number; tickUpper: number;
  liquidity: bigint; amount0Max: bigint; amount1Max: bigint;
  onStage?: EvmStage;
}

/** Preview whether the EVM open will need a one-time account-setup prompt
 *  (cold PDA below the rent floor) — for the truthful tracker's prompt count. */
export async function previewEvmOpen(chain: ChainConfig, eoa: string): Promise<{ needsSetup: boolean }> {
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId);
  const lamports = BigInt(await connFor(chain).getBalance(owner));
  return { needsSetup: lamports < PDA_RENT_FLOOR };
}

/** Open a position from the EVM lane: bootstrap the PDA's rent SOL if cold,
 *  ensure its token ATAs, then OpenPosition + IncreaseLiquidity via CPI. */
export async function openPositionEvm(chain: ChainConfig, p: EvmOpenParams, cfgIn?: ClmmConfigFlat): Promise<{ txHash: string; position: string }> {
  const cfg = cfgIn ?? cfgOf(chain);
  const pool = new PublicKey(cfg.pool), mint0 = new PublicKey(cfg.mint0), mint1 = new PublicKey(cfg.mint1);
  const owner = evmPdaFor(p.eoa, chain.romeEvmProgramId);
  const taL = tickArrayFor(chain, p.tickLower, cfg), taU = tickArrayFor(chain, p.tickUpper, cfg);
  if (!taL || !taU) throw new Error("Chosen band is outside the pool's active range");
  const [position, bump] = positionPda(chain, owner, p.tickLower, p.tickUpper, cfg);

  // Setup prompts (only what's needed): cold-PDA rent bootstrap + token ATAs.
  const lamports = BigInt(await connFor(chain).getBalance(owner));
  const setup: { to: string; data: string }[] = [];
  if (lamports < PDA_RENT_FLOOR) setup.push({ to: HELPER, data: HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [PDA_RENT_TOPUP]) });
  for (const mint of [mint0, mint1]) {
    if (!(await connFor(chain).getAccountInfo(ata(owner, mint)))) {
      setup.push({ to: HELPER, data: HELPER_IFACE.encodeFunctionData("create_ata", [p.eoa, b32(mint)]) });
    }
  }
  if (setup.length) { p.onStage?.("setup"); for (const s of setup) await sendEvm(chain, p.eoa, s.to, s.data); }

  // OpenPosition (payer = owner = PDA, auto-signed) then IncreaseLiquidity.
  p.onStage?.("confirm");
  await cpi(chain, p.eoa, [meta(pool, false, false), meta(position, false, true), meta(owner, true, false), meta(owner, true, true), meta(SystemProgram.programId, false, false)], openData(p.tickLower, p.tickUpper, bump), cfg);
  const txHash = await cpi(chain, p.eoa, liqMetas(cfg, owner, position, taL, taU), incData(p.liquidity, p.amount0Max, p.amount1Max), cfg);
  return { txHash, position: position.toBase58() };
}

export async function increaseLiquidityEvm(chain: ChainConfig, eoa: string, tickLower: number, tickUpper: number, liquidity: bigint, max0: bigint, max1: bigint, cfgIn?: ClmmConfigFlat): Promise<string> {
  const cfg = cfgIn ?? cfgOf(chain);
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId);
  const [position] = positionPda(chain, owner, tickLower, tickUpper, cfg);
  return cpi(chain, eoa, liqMetas(cfg, owner, position, tickArrayFor(chain, tickLower, cfg)!, tickArrayFor(chain, tickUpper, cfg)!), incData(liquidity, max0, max1), cfg);
}
export async function decreaseLiquidityEvm(chain: ChainConfig, eoa: string, tickLower: number, tickUpper: number, liquidity: bigint, min0: bigint, min1: bigint, cfgIn?: ClmmConfigFlat): Promise<string> {
  const cfg = cfgIn ?? cfgOf(chain);
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId);
  const [position] = positionPda(chain, owner, tickLower, tickUpper, cfg);
  return cpi(chain, eoa, liqMetas(cfg, owner, position, tickArrayFor(chain, tickLower, cfg)!, tickArrayFor(chain, tickUpper, cfg)!), decData(liquidity, min0, min1), cfg);
}
export async function collectFeesEvm(chain: ChainConfig, eoa: string, tickLower: number, tickUpper: number, cfgIn?: ClmmConfigFlat): Promise<string> {
  const cfg = cfgIn ?? cfgOf(chain);
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId);
  const [position] = positionPda(chain, owner, tickLower, tickUpper, cfg);
  return cpi(chain, eoa, [meta(new PublicKey(cfg.pool), false, false), meta(position, false, true), meta(owner, true, false), meta(ata(owner, new PublicKey(cfg.mint0)), false, true), meta(ata(owner, new PublicKey(cfg.mint1)), false, true), meta(new PublicKey(cfg.vault0), false, true), meta(new PublicKey(cfg.vault1), false, true), meta(TOKEN, false, false)], collectData(), cfg);
}
export async function closePositionEvm(chain: ChainConfig, eoa: string, tickLower: number, tickUpper: number, cfgIn?: ClmmConfigFlat): Promise<string> {
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId);
  const [position] = positionPda(chain, owner, tickLower, tickUpper, cfgIn);
  return cpi(chain, eoa, [meta(position, false, true), meta(owner, true, true)], closeData(), cfgIn);
}
