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
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getAccount,
  createAccount, createMint, mintTo, transfer, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
// 0.30% tier = trade 25/10000 + owner 5/10000 (denoms nonzero to pass validate).
const feesBuf = Buffer.concat([u64(25), u64(10000), u64(5), u64(10000), u64(0), u64(10000), u64(0), u64(10000)]);
const curveBuf = Buffer.concat([Buffer.from([0]), Buffer.alloc(32)]); // ConstantProduct
const initData = Buffer.concat([Buffer.from([0]), feesBuf, curveBuf]);

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

  const swapState = Keypair.generate();
  const [authority] = PublicKey.findProgramAddressSync([swapState.publicKey.toBuffer()], PROGRAM);
  console.log(" swapState", swapState.publicKey.toBase58(), "authority", authority.toBase58());

  const vaultA = await createAccount(conn, payer, WUSDC, authority, Keypair.generate());
  const vaultB = await createAccount(conn, payer, ethMint, authority, Keypair.generate());
  await transfer(conn, payer, usdcAta, vaultA, payer, seedUsdcRaw);   // real wUSDC
  await mintTo(conn, payer, ethMint, vaultB, payer, seedEthRaw);      // fresh ETH
  console.log(` vaultA(wUSDC)=${vaultA.toBase58()} vaultB(wETH)=${vaultB.toBase58()}`);

  const poolMint = await createMint(conn, payer, authority, null, 6);
  const feeAcct = await createAccount(conn, payer, poolMint, payer.publicKey, Keypair.generate());
  const destAcct = await createAccount(conn, payer, poolMint, payer.publicKey, Keypair.generate());

  const stateLen = 324;
  const rent = await conn.getMinimumBalanceForRentExemption(stateLen);
  const createIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: swapState.publicKey,
    lamports: rent, space: stateLen, programId: PROGRAM,
  });
  const initIx = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: swapState.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: vaultA, isSigner: false, isWritable: false },
      { pubkey: vaultB, isSigner: false, isWritable: false },
      { pubkey: poolMint, isSigner: false, isWritable: true },
      { pubkey: feeAcct, isSigner: false, isWritable: false },
      { pubkey: destAcct, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initData,
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(createIx, initIx), [payer, swapState], { commitment: "confirmed" });
  console.log("\n✅ wUSDC/wETH pool (0.30%) initialized. sig:", sig);

  const pool = {
    tier: "0.30%", bps: 30,
    feeTradeNum: 25, feeTradeDen: 10000, feeOwnerNum: 5, feeOwnerDen: 10000,
    program: PROGRAM.toBase58(), swapState: swapState.publicKey.toBase58(), authority: authority.toBase58(),
    mintA: WUSDC.toBase58(), mintB: ethMint.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(),
    poolMint: poolMint.toBase58(), feeAccount: feeAcct.toBase58(), destination: destAcct.toBase58(),
    payerAtaA: usdcAta.toBase58(), payerAtaB: getAssociatedTokenAddressSync(ethMint, payer.publicKey).toBase58(),
    decimalsA: DEC_A, decimalsB: DEC_B,
    symbols: SYMBOLS,
  };
  fs.writeFileSync(OUT, JSON.stringify(pool, null, 2) + "\n");
  console.log("wrote pool-real-eth.json:\n", JSON.stringify(pool, null, 2));
  console.log("\nNEXT: node build-app-pools.mjs (assemble multi-pair app JSON) + node register-router.mjs (register the new pool).");
}

main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
