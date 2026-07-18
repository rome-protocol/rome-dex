// create-real-pool.mjs — ready-to-fire creation of a rome-dex pool of REAL Rome
// tokens: wUSDC (mint 4zMMC9…, 6dp) + wSOL (So111…112, 9dp). Mirrors
// create-pool.mjs (vaults owned by the authority PDA, Initialize fee tier
// 0.30% = trade 25/10000 + owner 5/10000).
//
// SAFE READY-STATE by design:
//   • Idempotent — if pool-real.json exists, does nothing (prints the pool + exits 0).
//   • Balance dry-run — if the deployer's wUSDC ATA holds < the seed target, it
//     prints EXACTLY what to send and EXITS 0 without creating anything (never
//     strands funds, never hard-fails for lack of funds).
//   • Only once wUSDC is present does it wrap ~0.4 SOL → wSOL and create the pool.
//
// Env overrides (all optional): SEED_USDC (whole wUSDC, default 30),
// SEED_WSOL_SOL (whole SOL to wrap, default 0.4).
//
// Run: node create-real-pool.mjs

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, getAccount,
  createAssociatedTokenAccountInstruction, createSyncNativeInstruction,
  createAccount, createMint, transfer, TOKEN_PROGRAM_ID, NATIVE_MINT,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- constants (real Rome tokens; registry tokens.json) ----
const RPC = "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("Fv2LgkewH9114T6Gg99ERq8TxMVj2MGPRC73dJ4AKb1A");
// A = wUSDC (6dp), B = wSOL (9dp). wSOL uses the canonical native mint.
const WUSDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL = NATIVE_MINT; // So11111111111111111111111111111111111111112
const DEC_A = 6, DEC_B = 9;
const SYMBOLS = { A: "USDC", B: "SOL" };

const SEED_USDC = Number(process.env.SEED_USDC ?? 30);          // whole wUSDC to seed
const SEED_WSOL_SOL = Number(process.env.SEED_WSOL_SOL ?? 0.4); // whole SOL to wrap + seed
const seedUsdcRaw = BigInt(Math.round(SEED_USDC * 10 ** DEC_A));
const seedWsolRaw = BigInt(Math.round(SEED_WSOL_SOL * 10 ** DEC_B));

const conn = new Connection(RPC, "confirmed");
// Deployer keypair — defaults to the local CLI key; DEPLOYER_KEYPAIR overrides
// the path (used to demo the balance dry-run against an unfunded wallet).
const KEYPAIR_PATH = process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH))));

const OUT = path.join(DIR, "pool-real.json");
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
// Fee tier 0.30% = trade 25/10000 + owner 5/10000 (denoms nonzero to pass validate).
const feesBuf = Buffer.concat([u64(25), u64(10000), u64(5), u64(10000), u64(0), u64(10000), u64(0), u64(10000)]);
const curveBuf = Buffer.concat([Buffer.from([0]), Buffer.alloc(32)]); // ConstantProduct
const initData = Buffer.concat([Buffer.from([0]), feesBuf, curveBuf]); // 1+64+33 = 98

async function ataBalance(mint, owner) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    return (await getAccount(conn, ata)).amount;
  } catch { return 0n; }
}

async function main() {
  console.log("rome-dex real-pool creator (wUSDC / wSOL)");
  console.log("payer (deployer):", payer.publicKey.toBase58());
  console.log(`seed target: ${SEED_USDC} wUSDC : ${SEED_WSOL_SOL} wSOL\n`);

  // ---- idempotency guard ----
  if (fs.existsSync(OUT)) {
    console.log("pool-real.json already exists — pool considered created. Nothing to do.");
    console.log(fs.readFileSync(OUT, "utf8"));
    process.exit(0);
  }

  // ---- (i) wUSDC balance dry-run (READY-STATE gate) ----
  const usdcBal = await ataBalance(WUSDC, payer.publicKey);
  const usdcHuman = Number(usdcBal) / 10 ** DEC_A;
  console.log(`deployer wUSDC balance: ${usdcHuman} wUSDC (raw ${usdcBal})`);

  if (usdcBal < seedUsdcRaw) {
    const needRaw = seedUsdcRaw - usdcBal;
    const needHuman = Number(needRaw) / 10 ** DEC_A;
    console.log("\n⏸  NOT READY — insufficient wUSDC to seed the pool. No pool created.");
    console.log(`   need ${needHuman} wUSDC at ${WUSDC.toBase58()} sent to ${payer.publicKey.toBase58()}`);
    console.log(`   (target seed = ${SEED_USDC} wUSDC; have ${usdcHuman} wUSDC)`);
    console.log("\nTO COMPLETE: fund the deployer wUSDC ATA above, then re-run `node create-real-pool.mjs`.");
    process.exit(0); // ready-state, not a failure
  }

  // Also make sure we have enough SOL to wrap into wSOL + pay rent/fees.
  const solLamports = await conn.getBalance(payer.publicKey);
  const needLamports = Number(seedWsolRaw) + 0.05 * LAMPORTS_PER_SOL; // wrap + rent/fee headroom
  if (solLamports < needLamports) {
    console.log(`\n⏸  NOT READY — need ~${(needLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL (have ${(solLamports / LAMPORTS_PER_SOL).toFixed(3)}). No pool created.`);
    console.log(`   fund ${payer.publicKey.toBase58()} with SOL, then re-run.`);
    process.exit(0);
  }

  console.log("\n✅ funds present — creating the real pool.\n");

  // ---- (ii) wrap ~SEED_WSOL_SOL SOL → wSOL (create/fund wSOL ATA + syncNative) ----
  const wsolAta = getAssociatedTokenAddressSync(WSOL, payer.publicKey);
  const wsolInfo = await conn.getAccountInfo(wsolAta);
  const wrapTx = new Transaction();
  if (!wsolInfo) {
    wrapTx.add(createAssociatedTokenAccountInstruction(payer.publicKey, wsolAta, payer.publicKey, WSOL));
  }
  wrapTx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wsolAta, lamports: Number(seedWsolRaw) }));
  wrapTx.add(createSyncNativeInstruction(wsolAta));
  const wrapSig = await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  console.log(" wrapped SOL → wSOL. ata", wsolAta.toBase58(), "sig", wrapSig);

  // deployer wUSDC ATA (must already exist since it holds a balance)
  const usdcAta = getAssociatedTokenAddressSync(WUSDC, payer.publicKey);

  // ---- (iii) create the pool (mirror create-pool.mjs) ----
  const swapState = Keypair.generate();
  const [authority] = PublicKey.findProgramAddressSync([swapState.publicKey.toBuffer()], PROGRAM);
  console.log(" swapState", swapState.publicKey.toBase58(), "authority", authority.toBase58());

  const vaultA = await createAccount(conn, payer, WUSDC, authority, Keypair.generate());
  const vaultB = await createAccount(conn, payer, WSOL, authority, Keypair.generate());
  await transfer(conn, payer, usdcAta, vaultA, payer, seedUsdcRaw);
  await transfer(conn, payer, wsolAta, vaultB, payer, seedWsolRaw);
  console.log(" vaultA(wUSDC)", vaultA.toBase58(), "vaultB(wSOL)", vaultB.toBase58());

  const poolMint = await createMint(conn, payer, authority, null, 6);
  const feeAcct = await createAccount(conn, payer, poolMint, payer.publicKey, Keypair.generate());
  const destAcct = await createAccount(conn, payer, poolMint, payer.publicKey, Keypair.generate());
  console.log(" poolMint", poolMint.toBase58());

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
  console.log("\n✅ real pool initialized. sig:", sig);

  // ---- (iv) write pool-real.json (same shape as pool.json + symbols) ----
  const pool = {
    program: PROGRAM.toBase58(), swapState: swapState.publicKey.toBase58(), authority: authority.toBase58(),
    mintA: WUSDC.toBase58(), mintB: WSOL.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(),
    poolMint: poolMint.toBase58(), feeAccount: feeAcct.toBase58(), destination: destAcct.toBase58(),
    payerAtaA: usdcAta.toBase58(), payerAtaB: wsolAta.toBase58(),
    decimalsA: DEC_A, decimalsB: DEC_B,
    symbols: SYMBOLS,
  };
  fs.writeFileSync(OUT, JSON.stringify(pool, null, 2) + "\n");
  console.log("wrote pool-real.json:\n", JSON.stringify(pool, null, 2));
  console.log("\nNEXT: point the app at pool-real.json (regenerate pools-tiers.json with these addresses + symbols) to light up USD.");
}

main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
