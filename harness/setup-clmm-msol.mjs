// setup-clmm-msol.mjs — one-time mSOL/wSOL 0.05% CLMM pool on Hadrian's Solana
// substrate, sourced through the ecosystem itself: the deployer stakes SOL into
// the REAL devnet Marinade (program MarBmsSg…, the cardo-proven deposit path)
// and pools the resulting mSOL against wSOL at the MEASURED exchange rate (the
// dust probe's realized lamports→mSOL ratio — never a cached or assumed price).
//
// LST/SOL is the concentrated-liquidity showcase pair: the rate moves slowly,
// so a tight 0.05% / spacing-8 band is deep with tiny capital. Idempotent; ends
// with a proof swap so "usable" is verified, not assumed. Total spend ≈ 1.5 SOL.
//
// Run: node --import tsx setup-clmm-msol.mjs
//
// Marinade constants + account order mirror cardo lib/marinade-{program,
// instructions,state}.ts (verified live there 2026-04-25; deposit disc =
// sha256("global:deposit")[..8]; msol_leg read from State offset 420).

import {
  ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, createSyncNativeInstruction, NATIVE_MINT,
} from "@solana/spl-token";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conn, payer, PK, bal } from "./lib.mjs";
import { decodePool } from "../sdk/clmm-quote.mjs";
import { orderMints, priceToSqrtPrice, tickArrayStartsForRange } from "../app/lib/clmm-create";
import { priceToTick, getLiquidityForAmounts, getAmountsForLiquidity } from "../app/lib/clmm-quote";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "clmm-msol.json");

const CLMM = new PublicKey("cLMkE4X3PN4qwLBjUksHAnYbQiNMMedCPEdYwRbLVjV");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// ── Marinade (devnet redeploy — ids per cardo/registry, live-verified) ───────
const MARINADE = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const M_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const MSOL = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
const DEPOSIT_DISC = Buffer.from("f223c68952e1f2b6", "hex");
const pdaOf = (seed) => PublicKey.findProgramAddressSync([M_STATE.toBuffer(), Buffer.from(seed)], MARINADE)[0];
const M_RESERVE = pdaOf("reserve");
const M_SOL_LEG = pdaOf("liq_sol");
const M_MSOL_LEG_AUTH = pdaOf("liq_st_sol_authority");
const M_MINT_AUTH = pdaOf("st_mint");

const FEE_PIPS = 500, TICK_SPACING = 8, SPAN = 88 * TICK_SPACING;
const DUST_LAMPORTS = 50_000_000n;      // 0.05 SOL probe (dust-first rule)
const STAKE_LAMPORTS = 650_000_000n;    // main stake
const WRAP_LAMPORTS = 750_000_000n;     // wSOL side
const PROOF_IN = 5_000_000n;            // 0.005 wSOL proof swap

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const u128 = (v) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(BigInt(v) >> 64n, 8); return b; };
const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const send = (ixs) => sendAndConfirmTransaction(
  conn,
  ixs.reduce((t, ix) => t.add(ix), new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))),
  [payer], { commitment: "confirmed" },
);
const clmmIx = (accounts, data) => new TransactionInstruction({ programId: CLMM, keys: accounts, data });

// ── mSOL leg (from live State, offset 420..452 — cardo layout) ───────────────
const stateInfo = await conn.getAccountInfo(M_STATE);
if (!stateInfo) throw new Error("marinade state missing");
const M_MSOL_LEG = new PublicKey(stateInfo.data.subarray(420, 452));
console.log("marinade msol_leg", M_MSOL_LEG.toBase58());

const ataMsol = (await getOrCreateAssociatedTokenAccount(conn, payer, MSOL, payer.publicKey)).address;
const ataWsol = (await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey)).address;

const marinadeDeposit = (lamports) => new TransactionInstruction({
  programId: MARINADE,
  keys: [
    acc(M_STATE, 0, 1), acc(MSOL, 0, 1), acc(M_SOL_LEG, 0, 1), acc(M_MSOL_LEG, 0, 1),
    acc(M_MSOL_LEG_AUTH, 0, 0), acc(M_RESERVE, 0, 1),
    acc(payer.publicKey, 1, 1), acc(ataMsol, 0, 1), acc(M_MINT_AUTH, 0, 0),
    acc(SystemProgram.programId, 0, 0), acc(TOKEN, 0, 0),
  ],
  data: Buffer.concat([DEPOSIT_DISC, u64(lamports)]),
});

// ── source mSOL: dust probe first, then the stake (skip when already held) ───
let realizedRate; // mSOL raw per lamport (both 9dp → dimensionless SOL/mSOL rate)
const msolBefore = await bal(ataMsol);
if (msolBefore < 500_000_000n) {
  const before = await bal(ataMsol);
  const sig1 = await send([marinadeDeposit(DUST_LAMPORTS)]);
  const dustOut = (await bal(ataMsol)) - before;
  if (dustOut <= 0n) throw new Error("dust probe returned no mSOL — stopping before the main stake");
  realizedRate = Number(dustOut) / Number(DUST_LAMPORTS);
  console.log(`DUST probe: 0.05 SOL → ${Number(dustOut) / 1e9} mSOL (rate ${realizedRate.toFixed(6)} mSOL/SOL) · ${sig1.slice(0, 12)}…`);
  const sig2 = await send([marinadeDeposit(STAKE_LAMPORTS)]);
  console.log(`staked 0.65 SOL → mSOL bal ${Number(await bal(ataMsol)) / 1e9} · ${sig2.slice(0, 12)}…`);
} else {
  console.log(`mSOL already held (${Number(msolBefore) / 1e9}) — skipping stake`);
}
// Rate for pricing: prefer the measured probe; fall back to a fresh 1-lamport-
// scale read of realized totals if re-running (probe skipped).
if (realizedRate == null) {
  const dustOutProbe = await bal(ataMsol);
  realizedRate = Number(dustOutProbe) / Number(DUST_LAMPORTS + STAKE_LAMPORTS);
  console.log(`re-run: derived rate ${realizedRate.toFixed(6)} from held balance`);
}

// wSOL side
if ((await bal(ataWsol)) < WRAP_LAMPORTS) {
  await send([
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ataWsol, lamports: Number(WRAP_LAMPORTS) }),
    createSyncNativeInstruction(ataWsol),
  ]);
  console.log("wrapped 0.75 SOL");
}

// ── pool: canonical order + price in token1-per-token0 ───────────────────────
const { mint0, mint1 } = orderMints(MSOL, NATIVE_MINT);
const msolIs0 = mint0.equals(MSOL);
// realizedRate = mSOL per SOL. price(token1 per token0):
//   mSOL is token0 → price = SOL per mSOL = 1/rate; else price = rate.
const price = msolIs0 ? 1 / realizedRate : realizedRate;
const D0 = 9, D1 = 9;
const SYM0 = msolIs0 ? "mSOL" : "SOL", SYM1 = msolIs0 ? "SOL" : "mSOL";
const tick = priceToTick(price, 1, D0, D1);
const sqrtPrice = priceToSqrtPrice(price, D0, D1);
console.log(`mint0=${SYM0} mint1=${SYM1} · price ${price.toFixed(6)} ${SYM1}/${SYM0} → tick ${tick}`);

const feeLe = u32(FEE_PIPS);
const [poolPda, poolBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), mint0.toBuffer(), mint1.toBuffer(), feeLe], CLMM);
console.log("pool PDA", poolPda.toBase58());
const vault0 = (await getOrCreateAssociatedTokenAccount(conn, payer, mint0, poolPda, true)).address;
const vault1 = (await getOrCreateAssociatedTokenAccount(conn, payer, mint1, poolPda, true)).address;

if (!(await conn.getAccountInfo(poolPda))) {
  const sig = await send([clmmIx([
    acc(poolPda, 0, 1), acc(mint0, 0, 0), acc(mint1, 0, 0), acc(vault0, 0, 0), acc(vault1, 0, 0),
    acc(payer.publicKey, 1, 1), acc(SystemProgram.programId, 0, 0),
  ], Buffer.concat([Buffer.from([0]), Buffer.from([poolBump]), feeLe, u16(TICK_SPACING), u128(sqrtPrice)]))]);
  console.log("InitPool", sig.slice(0, 12) + "…");
} else console.log("pool exists — skipping InitPool");
const poolState = decodePool((await conn.getAccountInfo(poolPda)).data);

// ── tick arrays around the rate ──────────────────────────────────────────────
const starts = tickArrayStartsForRange(poolState.currentTick - SPAN, poolState.currentTick + SPAN, TICK_SPACING);
const tickArrays = {};
for (const start of starts) {
  const [taPda, taBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), poolPda.toBuffer(), i32(start)], CLMM);
  tickArrays[String(start)] = taPda.toBase58();
  if (!(await conn.getAccountInfo(taPda))) {
    await send([clmmIx([
      acc(poolPda, 0, 0), acc(taPda, 0, 1), acc(payer.publicKey, 1, 1), acc(SystemProgram.programId, 0, 0),
    ], Buffer.concat([Buffer.from([1]), i32(start), Buffer.from([taBump])]))]);
    console.log(`InitTickArray ${start}`);
  }
}

// ── seed position: tight ±~1.6% band (200 ticks), spacing-aligned ────────────
const lower = Math.floor((poolState.currentTick - 160) / TICK_SPACING) * TICK_SPACING;
const upper = Math.ceil((poolState.currentTick + 160) / TICK_SPACING) * TICK_SPACING;
const a0 = msolIs0 ? await bal(ataMsol) : await bal(ataWsol);
const a1 = msolIs0 ? await bal(ataWsol) : await bal(ataMsol);
const target0 = (a0 * 90n) / 100n, target1 = (a1 * 90n) / 100n; // keep dust for fees/proof
const liquidity = getLiquidityForAmounts(poolState.sqrtPrice, poolState.currentTick, lower, upper, target0, target1);
if (liquidity <= 0n) throw new Error("zero seed liquidity");
const [need0, need1] = getAmountsForLiquidity(poolState.sqrtPrice, poolState.currentTick, lower, upper, liquidity, true);

const [posPda, posBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("position"), poolPda.toBuffer(), payer.publicKey.toBuffer(), i32(lower), i32(upper)], CLMM);
const ata0 = msolIs0 ? ataMsol : ataWsol, ata1 = msolIs0 ? ataWsol : ataMsol;
if (!(await conn.getAccountInfo(posPda))) {
  await send([clmmIx([
    acc(poolPda, 0, 0), acc(posPda, 0, 1), acc(payer.publicKey, 0, 0),
    acc(payer.publicKey, 1, 1), acc(SystemProgram.programId, 0, 0),
  ], Buffer.concat([Buffer.from([2]), i32(lower), i32(upper), Buffer.from([posBump])]))]);
  console.log(`OpenPosition [${lower}, ${upper}]`);
}
const arrFor = (t) => PK(tickArrays[String(Math.floor(t / SPAN) * SPAN)] ?? tickArrays[String(starts[0])]);
if (decodePool((await conn.getAccountInfo(poolPda)).data).liquidity === 0n) {
  const sig = await send([clmmIx([
    acc(poolPda, 0, 1), acc(posPda, 0, 1), acc(payer.publicKey, 1, 0),
    acc(ata0, 0, 1), acc(ata1, 0, 1), acc(vault0, 0, 1), acc(vault1, 0, 1),
    acc(TOKEN, 0, 0), acc(arrFor(lower), 0, 1), acc(arrFor(upper), 0, 1),
  ], Buffer.concat([Buffer.from([3]), u128(liquidity), u64((need0 * 102n) / 100n + 1n), u64((need1 * 102n) / 100n + 1n)]))]);
  console.log(`seeded: ${Number(await bal(vault0)) / 1e9} ${SYM0} + ${Number(await bal(vault1)) / 1e9} ${SYM1} · ${sig.slice(0, 12)}…`);
} else console.log("pool already has liquidity — skipping seed");

// ── proof swap: 0.005 wSOL in ────────────────────────────────────────────────
const zeroForOne = !msolIs0; // selling wSOL: wSOL is token0 ? 0→1 : 1→0
const cur = decodePool((await conn.getAccountInfo(poolPda)).data).currentTick;
const startNow = Math.floor(cur / SPAN) * SPAN;
const walk = (zeroForOne ? [startNow, startNow - SPAN] : [startNow, startNow + SPAN])
  .map((s) => tickArrays[String(s)]).filter(Boolean).map((k) => PK(k));
const [srcP, dstP] = zeroForOne ? [ata0, ata1] : [ata1, ata0];
const outBefore = await bal(dstP);
const sig = await send([clmmIx([
  acc(poolPda, 0, 1), acc(payer.publicKey, 1, 0), acc(srcP, 0, 1), acc(dstP, 0, 1),
  acc(vault0, 0, 1), acc(vault1, 0, 1), acc(TOKEN, 0, 0),
  ...walk.map((a) => acc(a, 0, 1)),
], Buffer.concat([Buffer.from([7]), Buffer.from([zeroForOne ? 1 : 0]), u64(PROOF_IN), u64(1n), u128(0n)]))]);
const got = (await bal(dstP)) - outBefore;
if (got <= 0n) throw new Error("proof swap delivered nothing");
console.log(`PROOF swap: 0.005 wSOL → ${Number(got) / 1e9} mSOL-side (${sig.slice(0, 12)}…)`);

// ── record + paste-ready config ──────────────────────────────────────────────
const record = {
  program: CLMM.toBase58(), pool: poolPda.toBase58(), poolBump,
  mint0: mint0.toBase58(), mint1: mint1.toBase58(),
  vault0: vault0.toBase58(), vault1: vault1.toBase58(),
  feePips: FEE_PIPS, tickSpacing: TICK_SPACING,
  symbol0: SYM0, symbol1: SYM1, decimals0: D0, decimals1: D1,
  tickArrays, positionLower: lower, positionUpper: upper,
  realizedRateMsolPerSol: realizedRate,
};
fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
console.log("wrote", OUT);
console.log("\n── chains.yaml pool entry ──");
console.log([
  `        - pool: ${record.pool}`,
  `          mint0: ${record.mint0}`,
  `          mint1: ${record.mint1}`,
  `          vault0: ${record.vault0}`,
  `          vault1: ${record.vault1}`,
  `          feePips: ${FEE_PIPS}`,
  `          tickSpacing: ${TICK_SPACING}`,
  `          symbol0: ${SYM0}`,
  `          symbol1: ${SYM1}`,
  `          decimals0: ${D0}`,
  `          decimals1: ${D1}`,
  "          tickArrays:",
  ...Object.entries(tickArrays).map(([s, k]) => `            "${s}": ${k}`),
].join("\n"));
