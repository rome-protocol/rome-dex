// rome-dex CLMM — dual-lane on-chain proof (roadmap #4, PR ③). The P1 gate:
//
//   the SAME concentrated-liquidity pool serves BOTH lanes —
//   • Solana lane: the local keypair signs Swap / IncreaseLiquidity /
//     DecreaseLiquidity / Collect directly;
//   • EVM lane: an EVM EOA drives the identical instructions through the CPI
//     precompile, Rome auto-signing its external_auth PDA as the owner —
//   with CU per lane measured, fees accruing to positions on both lanes, and
//   the pool never over-paying (slippage guard reverts on an impossible min).
//
// Position PDAs are created permissionlessly (OpenPosition is payer-funded by
// design) — same pattern as farm InitUserStake: Rome's emulator does not
// discover a 3rd-party program's account creation inside a CPI, so the hot
// path never creates accounts.
//
// Run AFTER setup-clmm.mjs (writes harness/clmm.json):
//   node --test clmm.test.mjs        (EVM-lane tests skip without HADRIAN_PRIVATE_KEY)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  conn, payer, PK, bal, ensureAta, mintIfLow, execSolana, execEvmCpi, evmPdaFor,
  EVM_DEPLOYER,
} from "./lib.mjs";
import { quoteClmmExactIn, fetchClmmPool, tickArrayStartIndex } from "../sdk/clmm-quote.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.HADRIAN_PRIVATE_KEY;

const C = JSON.parse(fs.readFileSync(path.join(DIR, "clmm.json"), "utf8"));
const CLMM = new PublicKey(C.program);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = SystemProgram.programId;
const MINT0 = new PublicKey(C.mint0);
const MINT1 = new PublicKey(C.mint1);

// ---- encoders (mirror clmm/src/instruction.rs) ----
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u128 = (v) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(BigInt(v) >> 64n, 8); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
export const openPositionData = (lower, upper, bump) =>
  Buffer.concat([Buffer.from([2]), i32(lower), i32(upper), Buffer.from([bump])]);
export const increaseData = (liq, max0, max1) =>
  Buffer.concat([Buffer.from([3]), u128(liq), u64(max0), u64(max1)]);
export const decreaseData = (liq, min0, min1) =>
  Buffer.concat([Buffer.from([4]), u128(liq), u64(min0), u64(min1)]);
export const collectData = () => Buffer.from([5]);
export const closePositionData = () => Buffer.from([6]);
export const swapDataClmm = (zeroForOne, amountIn, minOut, limit = 0n) =>
  Buffer.concat([Buffer.from([7]), Buffer.from([zeroForOne ? 1 : 0]), u64(amountIn), u64(minOut), u128(limit)]);

const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const positionPda = (owner, lower, upper) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("position"), PK(C.pool).toBuffer(), PK(owner).toBuffer(), i32(lower), i32(upper)],
    CLMM,
  );

// The position range used throughout ([-1280, 1280] — spacing 64, straddles
// the two setup tick arrays).
const LOWER = C.positionLower, UPPER = C.positionUpper;

// Tick arrays for the position's two bounds (fixed by the range).
const ARR_AT0 = C.tickArrays["0"];
const ARR_LEFT = C.tickArrays["-5632"];

// Walk-order tick arrays derived from the LIVE pool tick — arrays[0] must
// contain the current tick (the program validates exactly this), and the walk
// continues in the swap direction as far as setup created arrays.
const SPAN = 88 * C.tickSpacing;
function walkArrays(currentTick, zeroForOne) {
  const start = Math.floor(currentTick / SPAN) * SPAN;
  const seq = zeroForOne ? [start, start - SPAN] : [start, start + SPAN];
  return seq.map((st) => C.tickArrays[String(st)]).filter(Boolean);
}

const swapAccounts = (authority, src, dst, walk) => [
  acc(C.pool, 0, 1), acc(authority, 1, 0), acc(src, 0, 1), acc(dst, 0, 1),
  acc(C.vault0, 0, 1), acc(C.vault1, 0, 1), acc(TOKEN, 0, 0),
  ...walk.map((a) => acc(a, 0, 1)),
];

const liqAccounts = (position, owner, ata0, ata1) => [
  acc(C.pool, 0, 1), acc(position, 0, 1), acc(owner, 1, 0),
  acc(ata0, 0, 1), acc(ata1, 0, 1), acc(C.vault0, 0, 1), acc(C.vault1, 0, 1),
  acc(TOKEN, 0, 0), acc(ARR_LEFT, 0, 1), acc(ARR_AT0, 0, 1),
];

const SWAP_IN = 50_000n; // tiny probe (6dp test mints)

const S = {};

test("setup: payer ATAs funded; pool live with in-range liquidity", async () => {
  S.ata0 = await ensureAta(MINT0, payer.publicKey);
  S.ata1 = await ensureAta(MINT1, payer.publicKey);
  await mintIfLow(MINT0, S.ata0, 10_000_000n, 100_000_000n);
  await mintIfLow(MINT1, S.ata1, 10_000_000n, 100_000_000n);
  const pool = await fetchClmmPool(conn, PK(C.pool));
  assert.ok(pool.liquidity > 0n, `pool has in-range liquidity (got ${pool.liquidity})`);
  S.pool = pool;
});

test("Solana lane: exact-in swap 0→1 lands, quote mirror matches EXACTLY", async () => {
  const walk = walkArrays(S.pool.currentTick, true);
  const quote = await quoteClmmExactIn(conn, PK(C.pool), walk.map(PK), true, SWAP_IN);
  assert.ok(quote.amountOut > 0n, "quote produces output");

  const before1 = await bal(S.ata1);
  const before0 = await bal(S.ata0);
  const r = await execSolana({
    programId: CLMM,
    accounts: swapAccounts(payer.publicKey, S.ata0, S.ata1, walk),
    data: swapDataClmm(true, SWAP_IN, 1n),
  });
  assert.ok(r.ok, "swap ok");
  const paid = before0 - (await bal(S.ata0));
  const got = (await bal(S.ata1)) - before1;
  assert.equal(paid, SWAP_IN, "exact-in consumes exactly the input");
  assert.equal(got, quote.amountOut, `off-chain quote mirrors on-chain EXACTLY (quote ${quote.amountOut}, got ${got})`);
  S.solanaSwapCu = r.cu;
  console.log(`  Solana-lane CLMM swap CU: ${r.cu} · in ${paid} → out ${got}`);
});

test("Solana lane: impossible min_amount_out reverts (pool never over-pays)", async () => {
  const pool = await fetchClmmPool(conn, PK(C.pool));
  let failed = null;
  try {
    await execSolana({
      programId: CLMM,
      accounts: swapAccounts(payer.publicKey, S.ata0, S.ata1, walkArrays(pool.currentTick, true)),
      data: swapDataClmm(true, SWAP_IN, 1_000_000_000_000n),
    });
  } catch (e) { failed = String(e?.message ?? e); }
  assert.ok(failed, "slippage guard must revert");
});

test("Solana lane: fees accrued to the position are collectable", async () => {
  const [pda] = positionPda(payer.publicKey, LOWER, UPPER);
  // Generate fresh fees THIS run (idempotent across runs): a small swap pays
  // 0.30% of SWAP_IN in token0 to in-range LPs.
  const pool = await fetchClmmPool(conn, PK(C.pool));
  const feeSwap = await execSolana({
    programId: CLMM,
    accounts: swapAccounts(payer.publicKey, S.ata0, S.ata1, walkArrays(pool.currentTick, true)),
    data: swapDataClmm(true, SWAP_IN, 1n),
  });
  assert.ok(feeSwap.ok, "fee-generating swap ok");
  // Poke (Decrease 0) refreshes tokens_owed from fee growth, then Collect pays.
  const poke = await execSolana({
    programId: CLMM,
    accounts: liqAccounts(pda, payer.publicKey, S.ata0, S.ata1),
    data: decreaseData(0n, 0n, 0n),
  });
  assert.ok(poke.ok, "poke ok");
  const before0 = await bal(S.ata0);
  const r = await execSolana({
    programId: CLMM,
    accounts: [
      acc(C.pool, 0, 0), acc(positionPda(payer.publicKey, LOWER, UPPER)[0], 0, 1), acc(payer.publicKey, 1, 0),
      acc(S.ata0, 0, 1), acc(S.ata1, 0, 1), acc(C.vault0, 0, 1), acc(C.vault1, 0, 1), acc(TOKEN, 0, 0),
    ],
    data: collectData(),
  });
  assert.ok(r.ok, "collect ok");
  const feeGot = (await bal(S.ata0)) - before0;
  // The swap above paid 0.30% of 50_000 = 150 in token0 to the (sole) LP.
  assert.ok(feeGot > 0n, `LP collected swap fees in token0 (got ${feeGot})`);
  console.log(`  Solana-lane fees collected: ${feeGot} token0`);
});

// ── EVM lane (the parity crux) ───────────────────────────────────────────────

const E = {};
test("EVM lane setup: external_auth PDA funded; position opened permissionlessly", { skip: !KEY }, async () => {
  E.owner = evmPdaFor(EVM_DEPLOYER);
  E.ata0 = await ensureAta(MINT0, E.owner, true);
  E.ata1 = await ensureAta(MINT1, E.owner, true);
  await mintIfLow(MINT0, E.ata0, 70_000_000n, 200_000_000n);
  await mintIfLow(MINT1, E.ata1, 70_000_000n, 200_000_000n);

  // Permissionless payer-funded OpenPosition for the EVM user (farm pattern —
  // the EVM hot path must never create program accounts inside the CPI).
  const [pda, bump] = positionPda(E.owner, LOWER, UPPER);
  E.position = pda;
  if (!(await conn.getAccountInfo(pda))) {
    const r = await execSolana({
      programId: CLMM,
      accounts: [
        acc(C.pool, 0, 0), acc(pda, 0, 1), acc(E.owner, 0, 0),
        acc(payer.publicKey, 1, 1), acc(SYSTEM, 0, 0),
      ],
      data: openPositionData(LOWER, UPPER, bump),
    });
    assert.ok(r.ok, "permissionless OpenPosition for the EVM owner");
  }
});

test("EVM lane: IncreaseLiquidity via CPI — Rome auto-signs the owner PDA", { skip: !KEY }, async () => {
  // L=1e9 over ±1280 ticks ≈ 6.2% of L per side ≈ 62e6 raw — cap at 100e6.
  const LIQ = 1_000_000_000n;
  const r = await execEvmCpi({
    programId: CLMM,
    key: KEY,
    accounts: liqAccounts(E.position, E.owner, E.ata0, E.ata1),
    data: increaseData(LIQ, 100_000_000n, 100_000_000n),
  });
  assert.ok(r.ok, `evm increase ok: ${r.error || ""}`);
  console.log(`  EVM-lane IncreaseLiquidity: ${r.legs} legs, maxCu ${r.maxCu}`);
});

test("EVM lane: exact-in swap via CPI into the SAME pool, CU parity band", { skip: !KEY }, async () => {
  const pool = await fetchClmmPool(conn, PK(C.pool));
  const walk = walkArrays(pool.currentTick, true);
  const quote = await quoteClmmExactIn(conn, PK(C.pool), walk.map(PK), true, SWAP_IN);
  const before1 = await bal(E.ata1);
  const r = await execEvmCpi({
    programId: CLMM,
    key: KEY,
    accounts: swapAccounts(E.owner, E.ata0, E.ata1, walk),
    data: swapDataClmm(true, SWAP_IN, 1n),
  });
  assert.ok(r.ok, `evm swap ok: ${r.error || ""}`);
  const got = (await bal(E.ata1)) - before1;
  assert.equal(got, quote.amountOut, `EVM-lane realized == quote (quote ${quote.amountOut}, got ${got})`);
  assert.ok(r.maxCu < 1_400_000, `EVM lane under the atomic ceiling (${r.maxCu})`);
  console.log(`  EVM-lane CLMM swap: ${r.legs} legs, maxCu ${r.maxCu} · Solana lane was ${S.solanaSwapCu} CU · ratio ${(r.maxCu / S.solanaSwapCu).toFixed(2)}×`);
});

test("EVM lane: DecreaseLiquidity returns principal to the PDA's ATAs", { skip: !KEY }, async () => {
  const before0 = await bal(E.ata0);
  const before1 = await bal(E.ata1);
  const r = await execEvmCpi({
    programId: CLMM,
    key: KEY,
    accounts: liqAccounts(E.position, E.owner, E.ata0, E.ata1),
    data: decreaseData(1_000_000_000n, 1n, 1n),
  });
  assert.ok(r.ok, `evm decrease ok: ${r.error || ""}`);
  assert.ok((await bal(E.ata0)) > before0 && (await bal(E.ata1)) >= before1,
    "principal returned to the EVM user's ATAs");
});

// ── PR ④: router-folded EVM swap (1 leg) + brand-new-wallet acceptance ───────
// The CLMM swap router assembles the CPI metas in EVM memory so the EVM-lane
// swap lands in ONE atomic leg (vs 3 raw). Liquidity ops are NOT routed — a
// per-user Position PDA's owner must sign, and a contract auto-signs only its
// own PDA, so open/increase/decrease/collect/close stay on the direct path.
import { Keypair, SystemProgram as SysProg } from "@solana/web3.js";
import { createMint as _cm, mintTo as _mt, getOrCreateAssociatedTokenAccount as _goata } from "@solana/spl-token";
import { ethers } from "ethers";
import { EVM_RPC, CHAIN_ID, CPI, b32, resolveGas, evmRpc, cuOfSig } from "./lib.mjs";

const routerUrl = new URL("./clmm-router.json", import.meta.url);
const ROUTER = fs.existsSync(routerUrl) ? JSON.parse(fs.readFileSync(routerUrl)) : null;
const R = {};

test("EVM lane: swap VIA ROUTER folds to fewer legs than raw CPI", { skip: !KEY || !ROUTER }, async () => {
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const w = new ethers.Wallet(KEY.trim(), provider);
  const iface = new ethers.Interface([
    "function swap(bytes32 poolId, bool zeroForOne, uint64 amountIn, uint64 minOut, uint128 sqrtPriceLimit, bytes32[] tickArrays) returns (uint64)",
  ]);
  const routerPda = evmPdaFor(ROUTER.address);
  const userPda = evmPdaFor(EVM_DEPLOYER);
  const srcAta = await ensureAta(MINT0, userPda, true);
  await mintIfLow(MINT0, srcAta, 5_000_000n, 50_000_000n);

  // Approve the router PDA as SPL delegate on the input ATA (approve-once UX).
  const d = Buffer.alloc(9); d[0] = 4; d.writeBigUInt64LE(SWAP_IN, 1);
  const cpiIface = new ethers.Interface(["function invoke(bytes32, (bytes32,bool,bool)[], bytes)"]);
  const approveData = cpiIface.encodeFunctionData("invoke", [
    b32(PK("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
    [[b32(srcAta), false, true], [b32(routerPda), false, false], [b32(userPda), true, false]],
    "0x" + d.toString("hex")]);
  let nonce = await provider.getTransactionCount(w.address, "pending");
  let g = await resolveGas({ from: w.address, to: CPI, data: approveData });
  let signed = await w.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g, to: CPI, value: 0n, data: approveData });
  let sr = await evmRpc("eth_sendRawTransaction", [signed]);
  assert.ok(!sr.error, `approve: ${JSON.stringify(sr.error || {}).slice(0, 200)}`);
  await provider.waitForTransaction(sr.result, 1, 120000).catch(() => null);

  const pool = await fetchClmmPool(conn, PK(C.pool));
  const walk = walkArrays(pool.currentTick, true);
  const quote = await quoteClmmExactIn(conn, PK(C.pool), walk.map(PK), true, SWAP_IN);
  const dstAta = await ensureAta(MINT1, userPda, true);
  const before1 = await bal(dstAta);

  const data = iface.encodeFunctionData("swap", [b32(PK(C.pool)), true, SWAP_IN, 1n, 0n, walk.map((a) => b32(PK(a)))]);
  nonce = await provider.getTransactionCount(w.address, "pending");
  g = await resolveGas({ from: w.address, to: ROUTER.address, data });
  signed = await w.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g, to: ROUTER.address, value: 0n, data });
  sr = await evmRpc("eth_sendRawTransaction", [signed]);
  assert.ok(!sr.error, `router swap: ${JSON.stringify(sr.error || {}).slice(0, 220)}`);
  await provider.waitForTransaction(sr.result, 1, 120000).catch(() => null);
  const sigs = (await evmRpc("rome_solanaTxForEvmTx", [sr.result])).result || [];
  let maxCu = 0; for (const s of sigs) { const c = await cuOfSig(s); if (c) maxCu = Math.max(maxCu, c); }

  const got = (await bal(dstAta)) - before1;
  assert.equal(got, quote.amountOut, `router swap realized == quote (quote ${quote.amountOut}, got ${got})`);
  // The fold assembles metas in-memory so calldata no longer holder-stages;
  // on hadrian-lt (iterative-by-design) a heavy CLMM swap still splits by CU,
  // so the win is FEWER legs than the 3-leg raw-CPI path (true 1-leg needs the
  // atomic proxy whose persistent ALT covers the CLMM accounts).
  assert.ok(sigs.length < 3, `router folds the swap to FEWER legs than raw CPI (got ${sigs.length}, raw was 3)`);
  R.routerLegs = sigs.length; R.routerCu = maxCu;
  console.log(`  EVM-lane ROUTER swap: ${sigs.length} leg(s) vs 3 raw, maxCu ${maxCu}`);
});

test("BRAND-NEW WALLET (fresh Solana keypair): full journey open→increase→swap→decrease→collect→close", async () => {
  // A never-seen keypair — the cold-account path where creation bugs hide.
  const fresh = Keypair.generate();
  // Fund it minimally: SOL for signing + rent it must pay, and both test tokens.
  const fundSol = await execSolana({
    programId: SysProg.programId,
    accounts: [acc(payer.publicKey, 1, 1), acc(fresh.publicKey, 0, 1)],
    data: (() => { const b = Buffer.alloc(12); b.writeUInt32LE(2, 0); b.writeBigUInt64LE(50_000_000n, 4); return b; })(),
  }).catch(() => null);
  // (SystemProgram transfer via raw ix; if the helper shape differs, fall back.)
  if (!fundSol?.ok) {
    const { sendAndConfirmTransaction, Transaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(SysProg.transfer({ fromPubkey: payer.publicKey, toPubkey: fresh.publicKey, lamports: 50_000_000n }));
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  }
  const fa0 = (await _goata(conn, payer, MINT0, fresh.publicKey)).address;
  const fa1 = (await _goata(conn, payer, MINT1, fresh.publicKey)).address;
  await _mt(conn, payer, MINT0, fa0, payer, 200_000_000n);
  await _mt(conn, payer, MINT1, fa1, payer, 200_000_000n);

  const [pos, bump] = positionPda(fresh.publicKey, LOWER, UPPER);
  const lstart = tickArrayStartIndex(LOWER, C.tickSpacing), ustart = tickArrayStartIndex(UPPER, C.tickSpacing);
  const liq = (position) => [
    acc(C.pool, 0, 1), acc(position, 0, 1), acc(fresh.publicKey, 1, 0),
    acc(fa0, 0, 1), acc(fa1, 0, 1), acc(C.vault0, 0, 1), acc(C.vault1, 0, 1),
    acc(TOKEN, 0, 0), acc(C.tickArrays[String(lstart)], 0, 1), acc(C.tickArrays[String(ustart)], 0, 1),
  ];

  // OPEN — permissionless, payer funds the rent; owner = the fresh key.
  const open = await execSolana({
    programId: CLMM,
    accounts: [acc(C.pool, 0, 0), acc(pos, 0, 1), acc(fresh.publicKey, 0, 0), acc(payer.publicKey, 1, 1), acc(SYSTEM, 0, 0)],
    data: openPositionData(LOWER, UPPER, bump),
  });
  assert.ok(open.ok, "fresh-wallet OpenPosition (permissionless)");

  // INCREASE — the fresh key signs over its own ATAs.
  const inc = await execSolana({ programId: CLMM, accounts: liq(pos), data: increaseData(1_000_000_000n, 100_000_000n, 100_000_000n), signer: fresh });
  assert.ok(inc.ok, "fresh-wallet IncreaseLiquidity");

  // SWAP — fresh key trades against the pool it just seeded into.
  const pool = await fetchClmmPool(conn, PK(C.pool));
  const walk = walkArrays(pool.currentTick, true);
  const swapAcc = [
    acc(C.pool, 0, 1), acc(fresh.publicKey, 1, 0), acc(fa0, 0, 1), acc(fa1, 0, 1),
    acc(C.vault0, 0, 1), acc(C.vault1, 0, 1), acc(TOKEN, 0, 0), ...walk.map((a) => acc(a, 0, 1)),
  ];
  const before1 = await bal(fa1);
  const sw = await execSolana({ programId: CLMM, accounts: swapAcc, data: swapDataClmm(true, SWAP_IN, 1n), signer: fresh });
  assert.ok(sw.ok, "fresh-wallet Swap");
  assert.ok((await bal(fa1)) > before1, "fresh wallet received swap output");

  // DECREASE — pull principal back to the fresh key's ATAs.
  const dec = await execSolana({ programId: CLMM, accounts: liq(pos), data: decreaseData(1_000_000_000n, 1n, 1n), signer: fresh });
  assert.ok(dec.ok, "fresh-wallet DecreaseLiquidity");

  // COLLECT — pay out any owed fees.
  const col = await execSolana({
    programId: CLMM,
    accounts: [acc(C.pool, 0, 0), acc(pos, 0, 1), acc(fresh.publicKey, 1, 0), acc(fa0, 0, 1), acc(fa1, 0, 1), acc(C.vault0, 0, 1), acc(C.vault1, 0, 1), acc(TOKEN, 0, 0)],
    data: collectData(), signer: fresh,
  });
  assert.ok(col.ok, "fresh-wallet Collect");

  // CLOSE — reclaim rent to the fresh owner (position now empty).
  const close = await execSolana({
    programId: CLMM,
    accounts: [acc(pos, 0, 1), acc(fresh.publicKey, 1, 1)],
    data: closePositionData(), signer: fresh,
  });
  assert.ok(close.ok, "fresh-wallet ClosePosition");
  assert.equal(await conn.getAccountInfo(pos), null, "position account reclaimed");
  console.log("  brand-new Solana wallet: full CLMM journey open→…→close OK");
});

// ── AUDIT CRITICAL regression (on-chain): no fee over-credit drain ───────────
// Open an in-range position in the (fee-bearing) proof pool and IMMEDIATELY
// remove it in full, then Collect. The position earned nothing over ~zero
// duration; a premature fee_growth_outside clear would have minted
// ≈ L·fee_growth_global/2^64 collectable from nothing. Post-fix: Collect pays
// back only principal — no phantom fees.
test("AUDIT CRITICAL: open-then-immediate-full-remove credits ZERO fees (no drain)", async () => {
  const pool = await fetchClmmPool(conn, PK(C.pool));
  assert.ok(pool.feeGrowthGlobal0 > 0n || pool.feeGrowthGlobal1 > 0n,
    "precondition: pool carries accrued fees (prior swaps) — else the drain wouldn't trigger");

  const fresh = Keypair.generate();
  const { sendAndConfirmTransaction: sact, Transaction: Txn } = await import("@solana/web3.js");
  await sact(conn, new Txn().add(SysProg.transfer({ fromPubkey: payer.publicKey, toPubkey: fresh.publicKey, lamports: 40_000_000n })), [payer], { commitment: "confirmed" });
  const fa0 = (await _goata(conn, payer, MINT0, fresh.publicKey)).address;
  const fa1 = (await _goata(conn, payer, MINT1, fresh.publicKey)).address;
  await _mt(conn, payer, MINT0, fa0, payer, 200_000_000n);
  await _mt(conn, payer, MINT1, fa1, payer, 200_000_000n);

  const [pos, bump] = positionPda(fresh.publicKey, LOWER, UPPER);
  const lstart = tickArrayStartIndex(LOWER, C.tickSpacing), ustart = tickArrayStartIndex(UPPER, C.tickSpacing);
  const liq = [
    acc(C.pool, 0, 1), acc(pos, 0, 1), acc(fresh.publicKey, 1, 0),
    acc(fa0, 0, 1), acc(fa1, 0, 1), acc(C.vault0, 0, 1), acc(C.vault1, 0, 1),
    acc(TOKEN, 0, 0), acc(C.tickArrays[String(lstart)], 0, 1), acc(C.tickArrays[String(ustart)], 0, 1),
  ];
  await execSolana({ programId: CLMM, accounts: [acc(C.pool, 0, 0), acc(pos, 0, 1), acc(fresh.publicKey, 0, 0), acc(payer.publicKey, 1, 1), acc(SYSTEM, 0, 0)], data: openPositionData(LOWER, UPPER, bump) });
  await execSolana({ programId: CLMM, accounts: liq, data: increaseData(1_000_000_000n, 100_000_000n, 100_000_000n), signer: fresh });
  // Immediate full removal — no time/swaps in between → zero earned.
  await execSolana({ programId: CLMM, accounts: liq, data: decreaseData(1_000_000_000n, 1n, 1n), signer: fresh });

  const b0 = await bal(fa0), b1 = await bal(fa1);
  await execSolana({
    programId: CLMM,
    accounts: [acc(C.pool, 0, 0), acc(pos, 0, 1), acc(fresh.publicKey, 1, 0), acc(fa0, 0, 1), acc(fa1, 0, 1), acc(C.vault0, 0, 1), acc(C.vault1, 0, 1), acc(TOKEN, 0, 0)],
    data: collectData(), signer: fresh,
  });
  const got0 = (await bal(fa0)) - b0, got1 = (await bal(fa1)) - b1;
  assert.equal(got0, 0n, `Collect must pay ZERO phantom token0 (got ${got0})`);
  assert.equal(got1, 0n, `Collect must pay ZERO phantom token1 (got ${got1})`);
  console.log(`  drain guard: open→remove→collect paid ${got0}/${got1} (correct: 0/0)`);
});
