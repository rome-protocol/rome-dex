// create-real-tiered-pools.mjs — REAL multi-fee-tier pools of wUSDC/wSOL.
//
// Companion to create-tiered-pools.mjs (which builds tiers of the test A/B
// mints). This one builds the SAME three standard fee tiers (0.05% / 0.30% /
// 1.00%) but of the REAL Rome tokens wUSDC (4zMMC9…, 6dp) + wSOL (So111…112,
// 9dp), so the app lights up with LIVE USD values (both symbols have oracle
// feeds). It:
//   • REUSES harness/pool-real.json as the 0.30% tier (already created).
//   • CREATES a 0.05% tier (trade 5/10000, owner 0) and a 1.00% tier
//     (trade 100/10000, owner 0) of real wUSDC/wSOL with SMALL seeds
//     (~10 wUSDC : ~0.13 wSOL each — conserves the deployer's wUSDC).
//   • Wraps SOL → wSOL (SystemProgram.transfer + syncNative) as needed.
//   • Seeds each tier with slightly DIFFERENT A:B ratios so spot prices differ
//     (tier selection meaningful — best output varies by tier + amount).
//   • Writes harness/pools-real-tiers.json (ordered by bps ascending), each
//     entry carrying symbols:{A:"USDC",B:"SOL"}.
//
// Idempotent per tier: if pools-real-tiers.json already has a tier, that tier is
// left untouched (its addresses reused). Only missing tiers are created. Re-run
// safely.
//
// Env overrides (all optional):
//   SEED_005_USDC (default 10), SEED_005_SOL (default 0.14)
//   SEED_100_USDC (default 10), SEED_100_SOL (default 0.12)
//
// Run: node create-real-tiered-pools.mjs   (deployer key = ~/.config/solana/id.json)

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getAccount, getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction, createSyncNativeInstruction,
  transfer, NATIVE_MINT,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEE_TIERS } from "../sdk/quote.mjs";
import { resolveCreatePool, buildCreatePoolIx, feesBufFor } from "./createPoolLib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))),
);

// Real Rome tokens (registry tokens.json). A = wUSDC (6dp), B = wSOL (9dp).
const WUSDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL = NATIVE_MINT; // So11111111111111111111111111111111111111112
const DEC_A = 6, DEC_B = 9;
const SYMBOLS = { A: "USDC", B: "SOL" };

const POOL_REAL = path.join(DIR, "pool-real.json"); // the 0.30% tier (already created)
const OUT = path.join(DIR, "pools-real-tiers.json");

// Per-tier seeds (whole tokens). Slightly different A:B ratios → distinct spot
// prices so the router's best-tier pick is meaningful. Small to conserve wUSDC.
//   0.30% = pool-real.json (30 wUSDC : 0.4 wSOL ≈ 75 USDC/SOL baseline).
//   0.05% = 10 wUSDC : 0.14 wSOL  (≈ 71.4 USDC/SOL — cheaper SOL, best small-buy tier).
//   1.00% = 10 wUSDC : 0.12 wSOL  (≈ 83.3 USDC/SOL — pricier SOL + high fee, router avoids).
const SEED = {
  "0.05%": { usdc: Number(process.env.SEED_005_USDC ?? 10), sol: Number(process.env.SEED_005_SOL ?? 0.14) },
  "1.00%": { usdc: Number(process.env.SEED_100_USDC ?? 10), sol: Number(process.env.SEED_100_SOL ?? 0.12) },
};

async function ataBalance(mint, owner) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    return (await getAccount(conn, ata)).amount;
  } catch { return 0n; }
}

// Wrap `lamports` native SOL into the payer's wSOL ATA (create ATA if missing).
async function ensureWrappedSol(lamports) {
  const wsolAta = getAssociatedTokenAddressSync(WSOL, payer.publicKey);
  const info = await conn.getAccountInfo(wsolAta);
  const tx = new Transaction();
  if (!info) tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, wsolAta, payer.publicKey, WSOL));
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wsolAta, lamports }));
  tx.add(createSyncNativeInstruction(wsolAta));
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  console.log(`  wrapped ${lamports / LAMPORTS_PER_SOL} SOL → wSOL (${wsolAta.toBase58()}) sig ${sig}`);
  return wsolAta;
}

async function createTierPool(tierEntry, seed) {
  const { tier, bps, fees } = tierEntry;
  const seedUsdcRaw = BigInt(Math.round(seed.usdc * 10 ** DEC_A));
  const seedWsolRaw = BigInt(Math.round(seed.sol * 10 ** DEC_B));
  console.log(`\n--- creating REAL ${tier} tier pool (${seed.usdc} wUSDC : ${seed.sol} wSOL) ---`);

  // Fund side A (wUSDC) — must be present in the deployer ATA.
  const usdcAta = getAssociatedTokenAddressSync(WUSDC, payer.publicKey);
  // Fund side B (wSOL) — wrap freshly (top up the wSOL ATA for this tier's seed).
  const wsolAta = await ensureWrappedSol(Number(seedWsolRaw));

  // resolve every CreatePool PDA (no ephemeral signer)
  const r = resolveCreatePool(PROGRAM, WUSDC, WSOL, bps);

  const vaultA = (await getOrCreateAssociatedTokenAccount(conn, payer, WUSDC, r.authority, true)).address;
  const vaultB = (await getOrCreateAssociatedTokenAccount(conn, payer, WSOL, r.authority, true)).address;
  await transfer(conn, payer, usdcAta, vaultA, payer, seedUsdcRaw);
  await transfer(conn, payer, wsolAta, vaultB, payer, seedWsolRaw);
  console.log(`  vaultA(wUSDC)=${vaultA.toBase58()} vaultB(wSOL)=${vaultB.toBase58()}`);

  const ix = buildCreatePoolIx({ program: PROGRAM, payer: payer.publicKey, mintA: WUSDC, mintB: WSOL, vaultA, vaultB, feeBps: bps, feesBuf: feesBufFor(fees), ...r });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  console.log(`  ✅ ${tier} pool created. swapState=${r.pool.toBase58()} sig=${sig}`);

  return {
    tier, bps: tierEntry.bps,
    feeTradeNum: Number(fees.tradeNum), feeTradeDen: Number(fees.tradeDen),
    feeOwnerNum: Number(fees.ownerNum), feeOwnerDen: Number(fees.ownerDen),
    program: PROGRAM.toBase58(), swapState: r.pool.toBase58(), authority: r.authority.toBase58(),
    mintA: WUSDC.toBase58(), mintB: WSOL.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(),
    poolMint: r.lpMint.toBase58(), destination: r.dest.toBase58(),
    payerAtaA: usdcAta.toBase58(), payerAtaB: wsolAta.toBase58(),
    decimalsA: DEC_A, decimalsB: DEC_B,
    symbols: SYMBOLS,
  };
}

// The 0.30% tier from pool-real.json (already created).
function tier030FromPoolReal(t) {
  const p = JSON.parse(fs.readFileSync(POOL_REAL, "utf8"));
  return {
    tier: t.tier, bps: t.bps,
    feeTradeNum: 25, feeTradeDen: 10000, feeOwnerNum: 5, feeOwnerDen: 10000,
    program: p.program, swapState: p.swapState, authority: p.authority,
    mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB,
    poolMint: p.poolMint, destination: p.destination,
    payerAtaA: p.payerAtaA, payerAtaB: p.payerAtaB,
    decimalsA: p.decimalsA ?? DEC_A, decimalsB: p.decimalsB ?? DEC_B,
    symbols: p.symbols ?? SYMBOLS,
  };
}

let PROGRAM;
async function main() {
  console.log("rome-dex REAL tiered-pool creator (wUSDC / wSOL)");
  console.log("payer (deployer):", payer.publicKey.toBase58());

  if (!fs.existsSync(POOL_REAL)) {
    console.error(`\n✗ ${POOL_REAL} missing — create the 0.30% real pool first (node create-real-pool.mjs).`);
    process.exit(1);
  }
  PROGRAM = new PublicKey(JSON.parse(fs.readFileSync(POOL_REAL, "utf8")).program);

  // Load existing output for per-tier idempotency.
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
  const byTier = new Map(existing.map((t) => [t.tier, t]));

  // Balance pre-check for the tiers we still need to create.
  const toCreate = FEE_TIERS.filter((t) => t.tier !== "0.30%" && !byTier.has(t.tier));
  if (toCreate.length) {
    const needUsdcRaw = toCreate.reduce((s, t) => s + BigInt(Math.round(SEED[t.tier].usdc * 10 ** DEC_A)), 0n);
    const needSolLamports = toCreate.reduce((s, t) => s + BigInt(Math.round(SEED[t.tier].sol * LAMPORTS_PER_SOL)), 0n);
    const usdcBal = await ataBalance(WUSDC, payer.publicKey);
    const solBal = BigInt(await conn.getBalance(payer.publicKey));
    console.log(`\nneed for ${toCreate.map((t) => t.tier).join("+")}: ${Number(needUsdcRaw) / 10 ** DEC_A} wUSDC + ~${Number(needSolLamports) / LAMPORTS_PER_SOL} SOL (+rent/fee)`);
    console.log(`have: ${Number(usdcBal) / 10 ** DEC_A} wUSDC, ${Number(solBal) / LAMPORTS_PER_SOL} SOL`);
    if (usdcBal < needUsdcRaw) {
      console.log(`\n⏸  NOT READY — need ${Number(needUsdcRaw - usdcBal) / 10 ** DEC_A} more wUSDC. No pool created.`);
      process.exit(0);
    }
    if (solBal < needSolLamports + BigInt(0.1 * LAMPORTS_PER_SOL)) {
      console.log(`\n⏸  NOT READY — need more SOL for wrap+rent. No pool created.`);
      process.exit(0);
    }
  }

  // Build the ordered tier list, creating only the missing ones.
  const out = [];
  for (const t of FEE_TIERS) {
    if (byTier.has(t.tier)) {
      console.log(`\n--- ${t.tier} tier: already in pools-real-tiers.json — reusing ---`);
      out.push(byTier.get(t.tier));
    } else if (t.tier === "0.30%") {
      console.log(`\n--- 0.30% tier: reusing pool-real.json ---`);
      out.push(tier030FromPoolReal(t));
    } else {
      out.push(await createTierPool(t, SEED[t.tier]));
    }
  }
  out.sort((a, b) => a.bps - b.bps);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log("\nwrote pools-real-tiers.json:\n", JSON.stringify(out, null, 2));
  console.log("\nNEXT: copy these tiers into app/lib/pools-tiers.json to point the app at real USDC/SOL.");
}

main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
