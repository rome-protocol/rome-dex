// clmm-create.ts — PURE, harness-importable builder for creating a NEW CLMM pool.
// No wallet/window imports (like clmm-quote.ts) so the on-chain harness can import
// it under tsx. Every encoding is byte-identical to the flow PROVEN on both lanes
// in harness/clmm-create-pool.test.mjs (cited inline as file:line).
//
// A pool needs: InitPool (creates the pool PDA + records fee/spacing/price) and
// InitTickArray for each array the initial range spans. Vaults are the pool PDA's
// ATAs. The lane-specific submit (Solana sign / EVM CPI) lives in
// clmm-create-actions.ts; this file only builds lane-agnostic instructions.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getSqrtPriceAtTick, priceToTick, MIN_SQRT_PRICE, MAX_SQRT_PRICE, TICK_ARRAY_SIZE, tickArrayStartIndex,
} from "./clmm-quote";

// Standard fee tiers a user can pick (fee_pips ≤ MAX_FEE_PIPS=100_000, spacing>0 —
// clmm/src/processor.rs check_pool_params). The 0.30%/64 tier matches the seeded
// proof pool; 0.05%/8 and 1.00%/128 mirror UV3-style tiers.
export const CLMM_CREATE_TIERS: ReadonlyArray<{ tier: string; feePips: number; tickSpacing: number }> = [
  { tier: "0.05%", feePips: 500, tickSpacing: 8 },
  { tier: "0.30%", feePips: 3000, tickSpacing: 64 },
  { tier: "1.00%", feePips: 10000, tickSpacing: 128 },
];

// ── little-endian encoders (clmm-create-pool.test.mjs:74-78) ──
const u16 = (v: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u128 = (v: bigint): Buffer => { const b = Buffer.alloc(16); b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(v >> 64n, 8); return b; };
const i32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const acc = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

// ── instruction data (tags per clmm/src/processor.rs; clmm-create-pool.test.mjs:83-87) ──
// InitPool tag 0: [0, bump, fee_pips u32 LE, tick_spacing u16 LE, sqrt_price u128 LE]
export const initPoolData = (bump: number, feePips: number, tickSpacing: number, sqrtPrice: bigint): Buffer =>
  Buffer.concat([Buffer.from([0]), Buffer.from([bump]), u32(feePips), u16(tickSpacing), u128(sqrtPrice)]);
// InitTickArray tag 1: [1, start_index i32 LE, bump]
export const initTickArrayData = (start: number, bump: number): Buffer =>
  Buffer.concat([Buffer.from([1]), i32(start), Buffer.from([bump])]);

// ── PDA derivations (seeds per clmm/src/state.rs:26-30; test:97-100) ──
export function poolPdaFor(program: PublicKey, mint0: PublicKey, mint1: PublicKey, feePips: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), mint0.toBuffer(), mint1.toBuffer(), u32(feePips)], program);
}
export function tickArrayPdaFor(program: PublicKey, pool: PublicKey, start: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), i32(start)], program);
}
/** A vault is the pool PDA's ATA for the mint (test:159, processor.rs:132-139). */
export function vaultAtaFor(pool: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, pool, true, TOKEN_PROGRAM_ID);
}

/** Canonical mint order — InitPool enforces mint0 < mint1 (processor.rs:115). */
export function orderMints(a: PublicKey, b: PublicKey): { mint0: PublicKey; mint1: PublicKey; flipped: boolean } {
  const flipped = Buffer.compare(a.toBuffer(), b.toBuffer()) >= 0;
  return flipped ? { mint0: b, mint1: a, flipped } : { mint0: a, mint1: b, flipped };
}

/** Distinct tick-array start indices spanning [tickLower, tickUpper] (test:62 uses
 *  the [-SPAN,0,SPAN] set around tick 0; this generalizes to any range). */
export function tickArrayStartsForRange(tickLower: number, tickUpper: number, tickSpacing: number): number[] {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  const lo = tickArrayStartIndex(tickLower, tickSpacing);
  const hi = tickArrayStartIndex(tickUpper, tickSpacing);
  const starts: number[] = [];
  for (let s = lo; s <= hi; s += span) starts.push(s);
  return starts;
}

/** price → sqrt_price(Q64.64), clamped to the program's bounds (test:176-177 uses
 *  the tick-0 identity; general price goes through priceToTick at spacing 1). */
export function priceToSqrtPrice(price: number, decimals0: number, decimals1: number): bigint {
  const tick = priceToTick(price, 1, decimals0, decimals1);
  const sp = getSqrtPriceAtTick(tick);
  return sp < MIN_SQRT_PRICE ? MIN_SQRT_PRICE : sp > MAX_SQRT_PRICE ? MAX_SQRT_PRICE : sp;
}

// ── lane-agnostic instruction builders (accounts byte-identical to test:198-201 / :215) ──
export interface InitPoolArgs {
  program: PublicKey; poolPda: PublicKey; bump: number;
  mint0: PublicKey; mint1: PublicKey; vault0: PublicKey; vault1: PublicKey;
  payer: PublicKey; feePips: number; tickSpacing: number; sqrtPrice: bigint;
}
export function buildInitPoolIx(a: InitPoolArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      acc(a.poolPda, false, true), acc(a.mint0, false, false), acc(a.mint1, false, false),
      acc(a.vault0, false, false), acc(a.vault1, false, false),
      acc(a.payer, true, true), acc(SystemProgram.programId, false, false),
    ],
    data: initPoolData(a.bump, a.feePips, a.tickSpacing, a.sqrtPrice),
  });
}

export interface InitTickArrayArgs {
  program: PublicKey; poolPda: PublicKey; tickArrayPda: PublicKey; bump: number; startIndex: number; payer: PublicKey;
}
export function buildInitTickArrayIx(a: InitTickArrayArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      acc(a.poolPda, false, false), acc(a.tickArrayPda, false, true),
      acc(a.payer, true, true), acc(SystemProgram.programId, false, false),
    ],
    data: initTickArrayData(a.startIndex, a.bump),
  });
}
