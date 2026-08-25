// create-real-pair-eth.mjs — a SECOND real pair for rome-dex: wUSDC / wETH.
//
// The first real pair is wUSDC/wSOL at 3 fee tiers (create-real-tiered-pools.mjs
// → pools-real-tiers.json). This adds a second pair so the app is genuinely
// multi-pair. Side A = the REAL wUSDC (4zMMC9…, 6dp, oracle-fed). Side B = a
// fresh "wETH"-style test mint the deployer controls (8dp) — the ETH/USD oracle
// feed lights up USD in the UI (registry oracle.json has ETH/USD). Only the
// 0.30% tier is created (mirrors the standard tier), seeded tiny.
//
// SAFE by design (mirrors create-real-pool.mjs):
//   • Idempotent — if pool-real-eth.json exists, prints it + exits 0.
//   • wUSDC balance dry-run — if the deployer holds < the seed, prints exactly
//     what to send and exits 0 without creating anything (never strands funds).
//
// Env overrides: SEED_USDC (default 3 whole wUSDC), SEED_ETH (default 0.001 ETH).
//
// Run: node create-real-pair-eth.mjs   (deployer key = ~/.config/solana/id.json)

import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getAccount, getOrCreateAssociatedTokenAccount,
  createMint, mintTo, transfer,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCreatePool, buildCreatePoolIx, feesBufFor } from "./createPoolLib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))),
);

// Real wUSDC (registry tokens.json) as side A. Program from the existing pool.
const WUSDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const DEC_A = 6, DEC_B = 8;              // wUSDC 6dp, wETH-style test mint 8dp
const SYMBOLS = { A: "USDC", B: "ETH" };
const SEED_USDC = Number(process.env.SEED_USDC ?? 3);      // whole wUSDC to seed
const SEED_ETH = Number(process.env.SEED_ETH ?? 0.001);   // whole ETH to seed
const seedUsdcRaw = BigInt(Math.round(SEED_USDC * 10 ** DEC_A));
const seedEthRaw = BigInt(Math.round(SEED_ETH * 10 ** DEC_B));

const POOL_REAL = path.join(DIR, "pool-real.json"); // reuse its program id
const OUT = path.join(DIR, "pool-real-eth.json");

const FEE_BPS = 30; // 0.30% tier
// 0.30% tier = trade 25/10000 + owner 5/10000; owner_withdraw + host 0/0
// (production requires exact-equal-zero denominators).
const feesBuf = feesBufFor({ tradeNum: 25n, tradeDen: 10000n, ownerNum: 5n, ownerDen: 10000n });

async function ataBalance(mint, owner) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    return (await getAccount(conn, ata)).amount;
  } catch { return 0n; }
}

async function main() {
  console.log("rome-dex 2nd real-pair creator (wUSDC / wETH-style)");
  console.log("payer (deployer):", payer.publicKey.toBase58());
  console.log(`seed target: ${SEED_USDC} wUSDC : ${SEED_ETH} ETH\n`);

  if (fs.existsSync(OUT)) {
    console.log("pool-real-eth.json already exists — pool considered created. Nothing to do.");
    console.log(fs.readFileSync(OUT, "utf8"));
    process.exit(0);
  }
  if (!fs.existsSync(POOL_REAL)) {
    console.error(`✗ ${POOL_REAL} missing — create the wUSDC/wSOL pool first (node create-real-pool.mjs).`);
    process.exit(1);
  }
  const PROGRAM = new PublicKey(JSON.parse(fs.readFileSync(POOL_REAL, "utf8")).program);

  // wUSDC dry-run gate (never strand funds).
  const usdcBal = await ataBalance(WUSDC, payer.publicKey);
  console.log(`deployer wUSDC balance: ${Number(usdcBal) / 10 ** DEC_A} wUSDC (raw ${usdcBal})`);
  if (usdcBal < seedUsdcRaw) {
    console.log(`\n⏸  NOT READY — need ${Number(seedUsdcRaw - usdcBal) / 10 ** DEC_A} more wUSDC at ${WUSDC.toBase58()}. No pool created.`);
    process.exit(0);
  }
  const solLamports = await conn.getBalance(payer.publicKey);
  if (solLamports < 0.1 * LAMPORTS_PER_SOL) {
    console.log(`\n⏸  NOT READY — need ~0.1 SOL for rent/fees (have ${(solLamports / LAMPORTS_PER_SOL).toFixed(3)}). No pool created.`);
    process.exit(0);
  }
  console.log("\n✅ funds present — creating the 2nd real pair.\n");

  // Fresh wETH-style mint the deployer controls (mint authority = payer).
  const ethMint = await createMint(conn, payer, payer.publicKey, null, DEC_B);
  console.log(" wETH-style mint:", ethMint.toBase58());

  const usdcAta = getAssociatedTokenAddressSync(WUSDC, payer.publicKey);

  // resolve every CreatePool PDA (no ephemeral signer)
  const r = resolveCreatePool(PROGRAM, WUSDC, ethMint, FEE_BPS);
  console.log(" swapState", r.pool.toBase58(), "authority", r.authority.toBase58());

  const vaultA = (await getOrCreateAssociatedTokenAccount(conn, payer, WUSDC, r.authority, true)).address;
  const vaultB = (await getOrCreateAssociatedTokenAccount(conn, payer, ethMint, r.authority, true)).address;
  await transfer(conn, payer, usdcAta, vaultA, payer, seedUsdcRaw);   // real wUSDC
  await mintTo(conn, payer, ethMint, vaultB, payer, seedEthRaw);      // fresh ETH
  console.log(` vaultA(wUSDC)=${vaultA.toBase58()} vaultB(wETH)=${vaultB.toBase58()}`);

  const ix = buildCreatePoolIx({ program: PROGRAM, payer: payer.publicKey, mintA: WUSDC, mintB: ethMint, vaultA, vaultB, feeBps: FEE_BPS, feesBuf, ...r });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  console.log("\n✅ wUSDC/wETH pool (0.30%) created. sig:", sig);

  const pool = {
    tier: "0.30%", bps: 30,
    feeTradeNum: 25, feeTradeDen: 10000, feeOwnerNum: 5, feeOwnerDen: 10000,
    program: PROGRAM.toBase58(), swapState: r.pool.toBase58(), authority: r.authority.toBase58(),
    mintA: WUSDC.toBase58(), mintB: ethMint.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(),
    poolMint: r.lpMint.toBase58(), destination: r.dest.toBase58(),
    payerAtaA: usdcAta.toBase58(), payerAtaB: getAssociatedTokenAddressSync(ethMint, payer.publicKey).toBase58(),
    decimalsA: DEC_A, decimalsB: DEC_B,
    symbols: SYMBOLS,
  };
  fs.writeFileSync(OUT, JSON.stringify(pool, null, 2) + "\n");
  console.log("wrote pool-real-eth.json:\n", JSON.stringify(pool, null, 2));
  console.log("\nNEXT: node build-app-pools.mjs (assemble multi-pair app JSON) + node register-router.mjs (register the new pool).");
}

main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
