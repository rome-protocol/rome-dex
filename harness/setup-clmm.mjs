// One-time CLMM proof-pool setup on Hadrian's Solana substrate → harness/clmm.json.
//
// Creates two fresh 6-dp test mints (deployer is mint authority — tiny amounts,
// no real value at risk), the pool PDA's ATA vaults, the pool at price 1.0
// (tick 0, 0.30% fee, spacing 64), three tick arrays around the price
// (-5632 / 0 / +5632), and a seed position [-1280, 1280] from the payer so the
// pool has in-range liquidity. Idempotent: safe to re-run (skips what exists).
//
// Run: node setup-clmm.mjs

import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conn, payer, PK, bal } from "./lib.mjs";
import { decodePool } from "../sdk/clmm-quote.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "clmm.json");

const CLMM = new PublicKey("cLMkE4X3PN4qwLBjUksHAnYbQiNMMedCPEdYwRbLVjV");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const FEE_PIPS = 3000;      // 0.30%
const TICK_SPACING = 64;
const SPAN = 88 * TICK_SPACING; // 5632
const SQRT_PRICE_1 = 1n << 64n; // price 1.0 → tick 0
const POS_LOWER = -1280, POS_UPPER = 1280;
const SEED_LIQUIDITY = 10_000_000_000n; // ≈620e6 raw of each side at ±6.4%

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const u128 = (v) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(BigInt(v) >> 64n, 8); return b; };
const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });

async function send(ix) {
  return sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
}
const clmmIx = (accounts, data) => new TransactionInstruction({ programId: CLMM, keys: accounts, data });

// ── mints (created once; reused from clmm.json on re-run) ───────────────────
let prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;

let mint0, mint1;
if (prev?.mint0 && (await conn.getAccountInfo(PK(prev.mint0)))) {
  mint0 = PK(prev.mint0); mint1 = PK(prev.mint1);
  console.log("reusing mints", mint0.toBase58(), mint1.toBase58());
} else {
  const a = await createMint(conn, payer, payer.publicKey, null, 6);
  const b = await createMint(conn, payer, payer.publicKey, null, 6);
  // Canonical order: mint0 < mint1 bytewise (InitPool enforces it).
  [mint0, mint1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  console.log("created mints", mint0.toBase58(), mint1.toBase58());
  prev = null; // fresh mints → everything downstream is fresh
}

// ── pool PDA + vaults ───────────────────────────────────────────────────────
const feeLe = u32(FEE_PIPS);
const [poolPda, poolBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), mint0.toBuffer(), mint1.toBuffer(), feeLe], CLMM);
console.log("pool PDA", poolPda.toBase58());

const vault0 = (await getOrCreateAssociatedTokenAccount(conn, payer, mint0, poolPda, true)).address;
const vault1 = (await getOrCreateAssociatedTokenAccount(conn, payer, mint1, poolPda, true)).address;

if (!(await conn.getAccountInfo(poolPda))) {
  const data = Buffer.concat([Buffer.from([0]), Buffer.from([poolBump]), feeLe, u16(TICK_SPACING), u128(SQRT_PRICE_1)]);
  const sig = await send(clmmIx([
    acc(poolPda, 0, 1), acc(mint0, 0, 0), acc(mint1, 0, 0), acc(vault0, 0, 0), acc(vault1, 0, 0),
    acc(payer.publicKey, 1, 1), acc(SystemProgram.programId, 0, 0),
  ], data));
  console.log("InitPool", sig);
} else console.log("pool exists — skipping InitPool");

// ── tick arrays around the price ────────────────────────────────────────────
const tickArrays = {};
for (const start of [-SPAN, 0, SPAN]) {
  const [taPda, taBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), poolPda.toBuffer(), i32(start)], CLMM);
  tickArrays[String(start)] = taPda.toBase58();
  if (!(await conn.getAccountInfo(taPda))) {
    const sig = await send(clmmIx([
      acc(poolPda, 0, 0), acc(taPda, 0, 1), acc(payer.publicKey, 1, 1), acc(SystemProgram.programId, 0, 0),
    ], Buffer.concat([Buffer.from([1]), i32(start), Buffer.from([taBump])])));
    console.log(`InitTickArray ${start}`, sig);
  } else console.log(`tick array ${start} exists — skipping`);
}

// ── payer token balances ────────────────────────────────────────────────────
const ata0 = (await getOrCreateAssociatedTokenAccount(conn, payer, mint0, payer.publicKey)).address;
const ata1 = (await getOrCreateAssociatedTokenAccount(conn, payer, mint1, payer.publicKey)).address;
for (const [mint, ata] of [[mint0, ata0], [mint1, ata1]]) {
  if ((await bal(ata)) < 1_000_000_000n) {
    await mintTo(conn, payer, mint, ata, payer, 10_000_000_000n);
  }
}

// ── seed position [-1280, 1280] ─────────────────────────────────────────────
const [posPda, posBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("position"), poolPda.toBuffer(), payer.publicKey.toBuffer(), i32(POS_LOWER), i32(POS_UPPER)],
  CLMM);
if (!(await conn.getAccountInfo(posPda))) {
  const sig = await send(clmmIx([
    acc(poolPda, 0, 0), acc(posPda, 0, 1), acc(payer.publicKey, 0, 0),
    acc(payer.publicKey, 1, 1), acc(SystemProgram.programId, 0, 0),
  ], Buffer.concat([Buffer.from([2]), i32(POS_LOWER), i32(POS_UPPER), Buffer.from([posBump])])));
  console.log("OpenPosition", sig);
} else console.log("position exists — skipping OpenPosition");

// Seed liquidity only when the pool is dry (idempotent).
const liquidityNow = decodePool((await conn.getAccountInfo(poolPda)).data).liquidity;
if (liquidityNow === 0n) {
  const taLeft = PK(tickArrays[String(-SPAN)]);
  const taAt0 = PK(tickArrays["0"]);
  const data = Buffer.concat([Buffer.from([3]), u128(SEED_LIQUIDITY), u64(1_000_000_000n), u64(1_000_000_000n)]);
  const sig = await send(clmmIx([
    acc(poolPda, 0, 1), acc(posPda, 0, 1), acc(payer.publicKey, 1, 0),
    acc(ata0, 0, 1), acc(ata1, 0, 1), acc(vault0, 0, 1), acc(vault1, 0, 1),
    acc(TOKEN, 0, 0), acc(taLeft, 0, 1), acc(taAt0, 0, 1),
  ], data));
  console.log("IncreaseLiquidity (seed)", sig, "vault0", await bal(vault0), "vault1", await bal(vault1));
} else console.log(`pool already has liquidity ${liquidityNow} — skipping seed`);

fs.writeFileSync(OUT, JSON.stringify({
  program: CLMM.toBase58(),
  pool: poolPda.toBase58(),
  poolBump,
  mint0: mint0.toBase58(),
  mint1: mint1.toBase58(),
  vault0: vault0.toBase58(),
  vault1: vault1.toBase58(),
  feePips: FEE_PIPS,
  tickSpacing: TICK_SPACING,
  tickArrays,
  positionLower: POS_LOWER,
  positionUpper: POS_UPPER,
}, null, 2));
console.log("wrote", OUT);
