// setup-clmm-real.mjs — one-time REAL-TOKEN CLMM pool on Hadrian's Solana
// substrate: wUSDC/wSOL 0.30%, priced from the DEX's own USDC/SOL constant-
// product pool (on-chain truth), three tick arrays centered on that price, and
// a small deployer-seeded position so the pool quotes + trades immediately.
//
// This is the pool /clmm serves to real users — the proof pool's tRDA/tRDB are
// deployer-only test mints nobody can obtain (the live "can't use CLMM" break).
// Idempotent: safe to re-run (skips whatever exists). Ends with a tiny proof
// swap (0.1 wUSDC) so "usable" is verified, not assumed.
//
// Run: node --import tsx setup-clmm-real.mjs        (tsx: imports app builders)

import {
  ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, mintTo, createSyncNativeInstruction, NATIVE_MINT,
} from "@solana/spl-token";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conn, payer, PK, bal, swapAccountsFor, swapData } from "./lib.mjs";
import { decodePool } from "../sdk/clmm-quote.mjs";
// App-side pure builders/math (byte-parity with the UI's create path).
import { orderMints, priceToSqrtPrice, tickArrayStartsForRange } from "../app/lib/clmm-create";
import { priceToTick, getLiquidityForAmounts, getAmountsForLiquidity } from "../app/lib/clmm-quote";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "clmm-real.json");

const CLMM = new PublicKey("cLMkE4X3PN4qwLBjUksHAnYbQiNMMedCPEdYwRbLVjV");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WUSDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // 6dp, deployer mint authority
const WSOL = NATIVE_MINT; // So111…112, 9dp

const FEE_PIPS = 3000, TICK_SPACING = 64, SPAN = 88 * TICK_SPACING;
const SEED_USDC = 25_000_000n;      // 25 wUSDC
const PROOF_IN = 100_000n;          // 0.1 wUSDC proof swap

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const u128 = (v) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(BigInt(v) >> 64n, 8); return b; };
const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
// CLMM swap/liquidity math runs close to (and past) the 200K default CU budget
// at real-price ticks (the proof pool measured 191,810 CU at tick ~0) — every
// tx carries an explicit limit.
const send = (ixs) => sendAndConfirmTransaction(
  conn,
  ixs.reduce((t, ix) => t.add(ix), new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))),
  [payer], { commitment: "confirmed" },
);
const clmmIx = (accounts, data) => new TransactionInstruction({ programId: CLMM, keys: accounts, data });

// ── price: the DEX's own USDC/SOL 0.30% pool reserves (on-chain truth) ───────
const tiers = JSON.parse(fs.readFileSync(path.join(DIR, "pools-real-tiers.json"), "utf8"));
const t30 = tiers.find((t) => t.bps === 30);
if (!t30 || t30.mintA !== WUSDC.toBase58() || t30.mintB !== WSOL.toBase58()) throw new Error("expected the USDC/SOL 0.30% tier in pools-real-tiers.json");
const rUsdc = Number(await bal(PK(t30.vaultA))) / 1e6;
const rSol = Number(await bal(PK(t30.vaultB))) / 1e9;
const usdcPerSol = rUsdc / rSol;
console.log(`live DEX price: ${usdcPerSol.toFixed(2)} wUSDC per wSOL (reserves ${rUsdc.toFixed(2)} / ${rSol.toFixed(4)})`);
if (!(usdcPerSol > 1 && usdcPerSol < 100_000)) throw new Error("implausible price — refusing");

// ── canonical order + tick math (decimals-aware) ─────────────────────────────
const { mint0, mint1 } = orderMints(WUSDC, WSOL);
const usdcIs0 = mint0.equals(WUSDC);
const D0 = usdcIs0 ? 6 : 9, D1 = usdcIs0 ? 9 : 6;
const SYM0 = usdcIs0 ? "USDC" : "SOL", SYM1 = usdcIs0 ? "SOL" : "USDC";
const price = usdcIs0 ? 1 / usdcPerSol : usdcPerSol; // token1 per token0, human
const tick = priceToTick(price, 1, D0, D1);
const sqrtPrice = priceToSqrtPrice(price, D0, D1);
console.log(`mint0=${SYM0} ${mint0.toBase58().slice(0, 8)}… mint1=${SYM1} · price(t1/t0)=${price} → tick ${tick}`);

// ── pool PDA + vaults ────────────────────────────────────────────────────────
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
  console.log("InitPool", sig);
} else console.log("pool exists — skipping InitPool");
const poolTick = decodePool((await conn.getAccountInfo(poolPda)).data).currentTick;

// ── three tick arrays centered on the pool's actual tick ─────────────────────
const starts = tickArrayStartsForRange(poolTick - SPAN, poolTick + SPAN, TICK_SPACING);
const tickArrays = {};
for (const start of starts) {
  const [taPda, taBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), poolPda.toBuffer(), i32(start)], CLMM);
  tickArrays[String(start)] = taPda.toBase58();
  if (!(await conn.getAccountInfo(taPda))) {
    const sig = await send([clmmIx([
      acc(poolPda, 0, 0), acc(taPda, 0, 1), acc(payer.publicKey, 1, 1), acc(SystemProgram.programId, 0, 0),
    ], Buffer.concat([Buffer.from([1]), i32(start), Buffer.from([taBump])]))]);
    console.log(`InitTickArray ${start}`, sig);
  } else console.log(`tick array ${start} exists — skipping`);
}

// ── fund the deployer's token ATAs (tiny: seed + proof only) ─────────────────
const solNeeded = BigInt(Math.ceil((26 / usdcPerSol) * 1e9)); // ≈ the USDC side's worth, in lamports
const ataUsdc = (await getOrCreateAssociatedTokenAccount(conn, payer, WUSDC, payer.publicKey)).address;
const ataSol = (await getOrCreateAssociatedTokenAccount(conn, payer, WSOL, payer.publicKey)).address;
// The deployer is NOT the wUSDC mint authority — a shortfall is acquired the
// self-service way: wrap SOL and swap through the DEX's own USDC/SOL pool.
const usdcShort = SEED_USDC + PROOF_IN - (await bal(ataUsdc));
// Size the input from the LIVE curve (x·y=k, 0.30% fee): the pool is small, so
// price impact is real — solve for the input that yields the shortfall, +5%.
let wrapExtra = 0n;
if (usdcShort > 0n) {
  const rU = await bal(PK(t30.vaultA)), rS = await bal(PK(t30.vaultB));
  if (usdcShort >= rU) throw new Error("dex pool too shallow to source the wUSDC shortfall");
  const inAfterFee = (usdcShort * rS) / (rU - usdcShort) + 1n;
  wrapExtra = (inAfterFee * 10000n) / 9970n + 1n; // gross up the 0.30% fee
  wrapExtra += wrapExtra / 20n; // +5% slack
}
if ((await bal(ataSol)) < solNeeded + wrapExtra) {
  const lamports = Number(solNeeded + wrapExtra - (await bal(ataSol)));
  await send([
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ataSol, lamports }),
    createSyncNativeInstruction(ataSol),
  ]);
  console.log(`wrapped ${lamports / 1e9} SOL`);
}
if (usdcShort > 0n) {
  const ix = new TransactionInstruction({
    programId: PK(t30.program),
    keys: swapAccountsFor(t30, "BtoA", payer.publicKey, ataSol, ataUsdc),
    data: swapData(wrapExtra, usdcShort),
  });
  const sig = await send([ix]);
  console.log(`swapped ${Number(wrapExtra) / 1e9} wSOL → wUSDC for the shortfall (${sig.slice(0, 12)}…) · wUSDC now ${await bal(ataUsdc)}`);
}
const ata0 = usdcIs0 ? ataUsdc : ataSol, ata1 = usdcIs0 ? ataSol : ataUsdc;

// ── seed position (≈ ±13% band around the price, spacing-aligned) ────────────
const lower = Math.floor((poolTick - 1280) / TICK_SPACING) * TICK_SPACING;
const upper = Math.ceil((poolTick + 1280) / TICK_SPACING) * TICK_SPACING;
// Compute the deposit from the pool's STORED price (a re-derived price drifts
// between runs → SlippageExceeded when the maxes are checked on-chain).
const poolState = decodePool((await conn.getAccountInfo(poolPda)).data);
const amt0Target = usdcIs0 ? SEED_USDC : BigInt(Math.floor(25 / usdcPerSol * 1e9));
const amt1Target = usdcIs0 ? BigInt(Math.floor(25 / usdcPerSol * 1e9)) : SEED_USDC;
const liquidity = getLiquidityForAmounts(poolState.sqrtPrice, poolState.currentTick, lower, upper, amt0Target, amt1Target);
if (liquidity <= 0n) throw new Error("computed zero seed liquidity");
const [need0, need1] = getAmountsForLiquidity(poolState.sqrtPrice, poolState.currentTick, lower, upper, liquidity, true);

const [posPda, posBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("position"), poolPda.toBuffer(), payer.publicKey.toBuffer(), i32(lower), i32(upper)], CLMM);
if (!(await conn.getAccountInfo(posPda))) {
  const sig = await send([clmmIx([
    acc(poolPda, 0, 0), acc(posPda, 0, 1), acc(payer.publicKey, 0, 0),
    acc(payer.publicKey, 1, 1), acc(SystemProgram.programId, 0, 0),
  ], Buffer.concat([Buffer.from([2]), i32(lower), i32(upper), Buffer.from([posBump])]))]);
  console.log(`OpenPosition [${lower}, ${upper}]`, sig);
} else console.log("position exists — skipping OpenPosition");

const arrForTick = (t) => PK(tickArrays[String(Math.floor(t / SPAN) * SPAN)] ?? tickArrays[String(starts[0])]);
if (decodePool((await conn.getAccountInfo(poolPda)).data).liquidity === 0n) {
  const sig = await send([clmmIx([
    acc(poolPda, 0, 1), acc(posPda, 0, 1), acc(payer.publicKey, 1, 0),
    acc(ata0, 0, 1), acc(ata1, 0, 1), acc(vault0, 0, 1), acc(vault1, 0, 1),
    acc(TOKEN, 0, 0), acc(arrForTick(lower), 0, 1), acc(arrForTick(upper), 0, 1),
  ], Buffer.concat([Buffer.from([3]), u128(liquidity), u64((need0 * 102n) / 100n + 1n), u64((need1 * 102n) / 100n + 1n)]))]);
  console.log(`IncreaseLiquidity (seed) ${sig} · vault0 ${await bal(vault0)} vault1 ${await bal(vault1)}`);
} else console.log("pool already has liquidity — skipping seed");

// ── proof swap: 0.1 wUSDC in — usable is verified, not assumed ───────────────
const zeroForOne = usdcIs0; // USDC in = token0→token1 iff USDC is mint0
const curTick = decodePool((await conn.getAccountInfo(poolPda)).data).currentTick;
const startNow = Math.floor(curTick / SPAN) * SPAN;
const walk = (zeroForOne ? [startNow, startNow - SPAN] : [startNow, startNow + SPAN])
  .map((s) => tickArrays[String(s)]).filter(Boolean).map((k) => PK(k));
const [srcProof, dstProof] = zeroForOne ? [ata0, ata1] : [ata1, ata0];
const outBefore = await bal(dstProof);
const sig = await send([clmmIx([
  acc(poolPda, 0, 1), acc(payer.publicKey, 1, 0), acc(srcProof, 0, 1), acc(dstProof, 0, 1),
  acc(vault0, 0, 1), acc(vault1, 0, 1), acc(TOKEN, 0, 0),
  ...walk.map((a) => acc(a, 0, 1)),
], Buffer.concat([Buffer.from([7]), Buffer.from([zeroForOne ? 1 : 0]), u64(PROOF_IN), u64(1n), u128(0n)]))]);
const got = (await bal(dstProof)) - outBefore;
if (got <= 0n) throw new Error("proof swap delivered nothing");
console.log(`PROOF swap: 0.1 wUSDC → ${got} raw wSOL-side (${sig.slice(0, 12)}…)`);

// ── record + paste-ready config block ────────────────────────────────────────
const record = {
  program: CLMM.toBase58(), pool: poolPda.toBase58(), poolBump,
  mint0: mint0.toBase58(), mint1: mint1.toBase58(),
  vault0: vault0.toBase58(), vault1: vault1.toBase58(),
  feePips: FEE_PIPS, tickSpacing: TICK_SPACING,
  symbol0: SYM0, symbol1: SYM1, decimals0: D0, decimals1: D1,
  tickArrays, positionLower: lower, positionUpper: upper,
};
fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
console.log("wrote", OUT);
console.log("\n── chains.yaml pool entry (insert FIRST under clmm.pools) ──");
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
