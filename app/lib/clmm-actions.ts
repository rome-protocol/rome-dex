"use client";

// CLMM position actions — Solana lane (⑤b). Open a concentrated position over a
// chosen price band, then increase / decrease / collect / close it. The
// connected Solana wallet is the position owner and signs over its own token
// accounts (the authority-agnostic seam). Instruction bytes + account layouts
// mirror harness/clmm.test.mjs exactly. Pool accounts + endpoints come from the
// active chain's clmm config (clmmConfig(chain)).

import {
  ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getActiveSolWallet } from "./solWallet";
import { clmmConfig, type ClmmConfigFlat } from "./clmm";
import type { ChainConfig } from "./chains/types";
import { decodePosition, tickArrayStartIndex, type ClmmPosition } from "./clmm-quote";

// ── encoders (mirror clmm/src/instruction.rs) ───────────────────────────────
const u64 = (v: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const u128 = (v: bigint): Buffer => { const b = Buffer.alloc(16); b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(v >> 64n, 8); return b; };
const i32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };

const openPositionData = (lower: number, upper: number, bump: number): Buffer =>
  Buffer.concat([Buffer.from([2]), i32(lower), i32(upper), Buffer.from([bump])]);
const increaseData = (liq: bigint, max0: bigint, max1: bigint): Buffer =>
  Buffer.concat([Buffer.from([3]), u128(liq), u64(max0), u64(max1)]);
const decreaseData = (liq: bigint, min0: bigint, min1: bigint): Buffer =>
  Buffer.concat([Buffer.from([4]), u128(liq), u64(min0), u64(min1)]);
const collectData = (): Buffer => Buffer.from([5]);
const closePositionData = (): Buffer => Buffer.from([6]);

const acc = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

// Resolve the flat clmm config for a chain, or throw when absent.
function cfgOf(chain: ChainConfig): ClmmConfigFlat {
  const c = clmmConfig(chain);
  if (!c) throw new Error("no clmm on this chain");
  return c;
}

export function positionPda(chain: ChainConfig, owner: PublicKey, lower: number, upper: number, cfgIn?: ClmmConfigFlat): [PublicKey, number] {
  const cfg = cfgIn ?? cfgOf(chain);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), new PublicKey(cfg.pool).toBuffer(), owner.toBuffer(), i32(lower), i32(upper)],
    new PublicKey(cfg.program),
  );
}

/** The tick-array account for a bound's spacing window, from config; null if
 *  the bound falls outside the pool's initialized arrays (UI disables that). */
export function tickArrayFor(chain: ChainConfig, tick: number, cfgIn?: ClmmConfigFlat): PublicKey | null {
  const cfg = cfgIn ?? cfgOf(chain);
  const start = tickArrayStartIndex(tick, cfg.tickSpacing);
  const key = cfg.tickArrays[String(start)];
  return key ? new PublicKey(key) : null;
}

const ata = (owner: PublicKey, mint: PublicKey): PublicKey => getAssociatedTokenAddressSync(mint, owner, true);

// ── submit (mirror walletActions.solanaSwap: wallet SIGNS, app submits to Rome) ──
async function sendSolana(solanaRpc: string, ixs: TransactionInstruction[], feePayer: PublicKey, onSign?: () => void): Promise<string> {
  const sol = getActiveSolWallet();
  if (!sol) throw new Error("Solana wallet not connected");
  const bh = await fetch(solanaRpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
  }).then((r) => r.json());
  const { blockhash, lastValidBlockHeight } = bh.result.value;
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer });
  // CLMM math runs close to the 200K default CU budget (191,810 measured at
  // tick ~0; real-price ticks exceed it) — always carry an explicit limit.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  for (const ix of ixs) tx.add(ix);
  onSign?.();
  const signed = await sol.signTransaction(tx);
  const send = await fetch(solanaRpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [signed.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }] }),
  }).then((r) => r.json());
  if (send.error) throw new Error(send.error.message || JSON.stringify(send.error));
  const sig = send.result as string;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await fetch(solanaRpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[sig], { searchTransactionHistory: true }] }),
    }).then((r) => r.json());
    const c = st.result?.value?.[0]?.confirmationStatus;
    if (c === "confirmed" || c === "finalized") return sig;
    const h = await fetch(solanaRpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] }) }).then((r) => r.json());
    if (h.result > lastValidBlockHeight) throw new Error("Transaction expired");
  }
  return sig;
}

const liqAccounts = (cfg: ClmmConfigFlat, owner: PublicKey, position: PublicKey, taLower: PublicKey, taUpper: PublicKey) => [
  acc(new PublicKey(cfg.pool), false, true), acc(position, false, true), acc(owner, true, false),
  acc(ata(owner, new PublicKey(cfg.mint0)), false, true), acc(ata(owner, new PublicKey(cfg.mint1)), false, true),
  acc(new PublicKey(cfg.vault0), false, true), acc(new PublicKey(cfg.vault1), false, true), acc(TOKEN_PROGRAM_ID, false, false),
  acc(taLower, false, true), acc(taUpper, false, true),
];

export interface OpenParams {
  owner: PublicKey; tickLower: number; tickUpper: number;
  liquidity: bigint; amount0Max: bigint; amount1Max: bigint;
  onSign?: () => void;
}

/** Open a position over the band AND deposit into it — one signature (OpenPosition
 *  + IncreaseLiquidity in a single tx; both signed by the owner wallet). */
export async function openPosition(chain: ChainConfig, p: OpenParams, cfgIn?: ClmmConfigFlat): Promise<{ signature: string; position: string }> {
  const cfg = cfgIn ?? cfgOf(chain);
  const program = new PublicKey(cfg.program), pool = new PublicKey(cfg.pool);
  const mint0 = new PublicKey(cfg.mint0), mint1 = new PublicKey(cfg.mint1);
  const taLower = tickArrayFor(chain, p.tickLower, cfg), taUpper = tickArrayFor(chain, p.tickUpper, cfg);
  if (!taLower || !taUpper) throw new Error("Chosen band is outside the pool's active range");
  const [position, bump] = positionPda(chain, p.owner, p.tickLower, p.tickUpper, cfg);
  const ixs: TransactionInstruction[] = [
    // Idempotent: ensure the owner's token ATAs exist (fresh wallet).
    createAssociatedTokenAccountIdempotentInstruction(p.owner, ata(p.owner, mint0), p.owner, mint0),
    createAssociatedTokenAccountIdempotentInstruction(p.owner, ata(p.owner, mint1), p.owner, mint1),
    new TransactionInstruction({
      programId: program,
      keys: [acc(pool, false, false), acc(position, false, true), acc(p.owner, false, false), acc(p.owner, true, true), acc(SystemProgram.programId, false, false)],
      data: openPositionData(p.tickLower, p.tickUpper, bump),
    }),
    new TransactionInstruction({
      programId: program,
      keys: liqAccounts(cfg, p.owner, position, taLower, taUpper),
      data: increaseData(p.liquidity, p.amount0Max, p.amount1Max),
    }),
  ];
  const signature = await sendSolana(chain.solanaRpc, ixs, p.owner, p.onSign);
  return { signature, position: position.toBase58() };
}

export interface ModifyParams {
  owner: PublicKey; tickLower: number; tickUpper: number;
  liquidity: bigint; amount0Bound: bigint; amount1Bound: bigint;
  onSign?: () => void;
}

export async function increaseLiquidity(chain: ChainConfig, p: ModifyParams, cfgIn?: ClmmConfigFlat): Promise<string> {
  const cfg = cfgIn ?? cfgOf(chain);
  const taLower = tickArrayFor(chain, p.tickLower, cfg)!, taUpper = tickArrayFor(chain, p.tickUpper, cfg)!;
  const [position] = positionPda(chain, p.owner, p.tickLower, p.tickUpper, cfg);
  return sendSolana(chain.solanaRpc, [new TransactionInstruction({
    programId: new PublicKey(cfg.program), keys: liqAccounts(cfg, p.owner, position, taLower, taUpper),
    data: increaseData(p.liquidity, p.amount0Bound, p.amount1Bound),
  })], p.owner, p.onSign);
}

export async function decreaseLiquidity(chain: ChainConfig, p: ModifyParams, cfgIn?: ClmmConfigFlat): Promise<string> {
  const cfg = cfgIn ?? cfgOf(chain);
  const taLower = tickArrayFor(chain, p.tickLower, cfg)!, taUpper = tickArrayFor(chain, p.tickUpper, cfg)!;
  const [position] = positionPda(chain, p.owner, p.tickLower, p.tickUpper, cfg);
  return sendSolana(chain.solanaRpc, [new TransactionInstruction({
    programId: new PublicKey(cfg.program), keys: liqAccounts(cfg, p.owner, position, taLower, taUpper),
    data: decreaseData(p.liquidity, p.amount0Bound, p.amount1Bound),
  })], p.owner, p.onSign);
}

export async function collectFees(chain: ChainConfig, owner: PublicKey, tickLower: number, tickUpper: number, onSign?: () => void, cfgIn?: ClmmConfigFlat): Promise<string> {
  const cfg = cfgIn ?? cfgOf(chain);
  const [position] = positionPda(chain, owner, tickLower, tickUpper, cfg);
  return sendSolana(chain.solanaRpc, [new TransactionInstruction({
    programId: new PublicKey(cfg.program),
    keys: [acc(new PublicKey(cfg.pool), false, false), acc(position, false, true), acc(owner, true, false), acc(ata(owner, new PublicKey(cfg.mint0)), false, true), acc(ata(owner, new PublicKey(cfg.mint1)), false, true), acc(new PublicKey(cfg.vault0), false, true), acc(new PublicKey(cfg.vault1), false, true), acc(TOKEN_PROGRAM_ID, false, false)],
    data: collectData(),
  })], owner, onSign);
}

export async function closePosition(chain: ChainConfig, owner: PublicKey, tickLower: number, tickUpper: number, onSign?: () => void, cfgIn?: ClmmConfigFlat): Promise<string> {
  const cfg = cfgIn ?? cfgOf(chain);
  const [position] = positionPda(chain, owner, tickLower, tickUpper, cfg);
  return sendSolana(chain.solanaRpc, [new TransactionInstruction({
    programId: new PublicKey(cfg.program), keys: [acc(position, false, true), acc(owner, true, true)], data: closePositionData(),
  })], owner, onSign);
}

/** Read a position account (or null if it doesn't exist). */
export async function readPosition(chain: ChainConfig, owner: PublicKey, tickLower: number, tickUpper: number, cfgIn?: ClmmConfigFlat): Promise<ClmmPosition | null> {
  const [position] = positionPda(chain, owner, tickLower, tickUpper, cfgIn);
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const info = await conn.getAccountInfo(position);
  return info ? decodePosition(info.data) : null;
}
