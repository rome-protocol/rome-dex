// Create MULTI FEE-TIER pools of the SAME existing A/B mints (Phase 3).
//
// Best-in-class DEXs (Orca 6 tiers, Raydium 8) offer multiple fee tiers per pair
// so the fee matches volatility. The program's Initialize takes an arbitrary
// Fees struct, so "fee tiers" = multiple pools of the same pair at standard
// tiers + tooling/SDK/UI to pick the right one.
//
// This script:
//   • REUSES the existing pool.json as the 0.30% tier (25/10000 trade + 5/10000
//     owner) — no new pool needed for that tier.
//   • CREATES a 0.05% tier (5/10000 trade) and a 1.00% tier (100/10000 trade) of
//     the SAME mintA/mintB (from pool.json) — NO new mints.
//   • Seeds each with tiny-but-DIFFERENT liquidity so spot prices differ slightly
//     (makes tier selection meaningful — best output varies by tier + amount).
//   • Writes pools-tiers.json — an ordered array of every tier's pool + fees.
//
// Idempotent-ish: re-running creates fresh 0.05/1.00 pools (new swapState
// keypairs) and rewrites pools-tiers.json; the 0.30% entry always points at
// pool.json. Tiny amounts; no mints stranded (deployer is mint authority).

import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEE_TIERS } from "../sdk/quote.mjs";
import { resolveCreatePool, buildCreatePoolIx, feesBufFor } from "./createPoolLib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SOL = "https://api.devnet.solana.com";
const conn = new Connection(SOL, "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))),
);
const pool1 = JSON.parse(fs.readFileSync(path.join(DIR, "pool.json"), "utf8"));
const PROGRAM = new PublicKey(pool1.program);
const mintA = new PublicKey(pool1.mintA); // 6 dp
const mintB = new PublicKey(pool1.mintB); // 9 dp

// Seed reserves per tier (smallest units). Slightly different A:B ratios so spot
// prices differ (tier selection is meaningful). 6-dp A, 9-dp B.
//   0.30% = existing pool.json (100 A : 100 B baseline, drifted by prior swaps).
//   0.05% = deeper, near-1:1000 (1 A ≈ 1000 B) — best price for small trades.
//   1.00% = shallower + skewed — the high-fee tier a router should usually avoid.
const SEED = {
  "0.05%": { a: 120_000_000n, b: 120_000_000_000n }, // 120 A : 120 B
  "1.00%": { a: 80_000_000n,  b: 82_000_000_000n },  // 80 A : 82 B (slightly B-rich)
};

async function createTierPool(tierEntry) {
  const { tier, bps, fees } = tierEntry;
  const seed = SEED[tier];
  console.log(`\n--- creating ${tier} tier pool ---`);

  // resolve every CreatePool PDA (no ephemeral signer)
  const r = resolveCreatePool(PROGRAM, mintA, mintB, bps);

  // vaults owned by the pool authority PDA
  const vaultA = (await getOrCreateAssociatedTokenAccount(conn, payer, mintA, r.authority, true)).address;
  const vaultB = (await getOrCreateAssociatedTokenAccount(conn, payer, mintB, r.authority, true)).address;
  // seed liquidity directly by minting into the vaults (deployer is mint authority)
  await mintTo(conn, payer, mintA, vaultA, payer, seed.a);
  await mintTo(conn, payer, mintB, vaultB, payer, seed.b);

  const ix = buildCreatePoolIx({ program: PROGRAM, payer: payer.publicKey, mintA, mintB, vaultA, vaultB, feeBps: bps, feesBuf: feesBufFor(fees), ...r });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  console.log(`  ✅ ${tier} pool created. swapState=${r.pool.toBase58()} sig=${sig}`);

  return {
    tier, bps: tierEntry.bps,
    feeTradeNum: Number(fees.tradeNum), feeTradeDen: Number(fees.tradeDen),
    feeOwnerNum: Number(fees.ownerNum), feeOwnerDen: Number(fees.ownerDen),
    program: PROGRAM.toBase58(), swapState: r.pool.toBase58(), authority: r.authority.toBase58(),
    mintA: mintA.toBase58(), mintB: mintB.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(),
    poolMint: r.lpMint.toBase58(), destination: r.dest.toBase58(),
    payerAtaA: pool1.payerAtaA, payerAtaB: pool1.payerAtaB,
  };
}

async function main() {
  console.log("payer:", payer.publicKey.toBase58());
  const tiers = [];

  for (const t of FEE_TIERS) {
    if (t.tier === "0.30%") {
      // Reuse the existing pool.json (already the 0.30% tier).
      tiers.push({
        tier: t.tier, bps: t.bps,
        feeTradeNum: 25, feeTradeDen: 10000, feeOwnerNum: 5, feeOwnerDen: 10000,
        program: pool1.program, swapState: pool1.swapState, authority: pool1.authority,
        mintA: pool1.mintA, mintB: pool1.mintB, vaultA: pool1.vaultA, vaultB: pool1.vaultB,
        poolMint: pool1.poolMint, destination: pool1.destination,
        payerAtaA: pool1.payerAtaA, payerAtaB: pool1.payerAtaB,
      });
      console.log(`\n--- 0.30% tier: reusing pool.json swapState=${pool1.swapState} ---`);
    } else {
      tiers.push(await createTierPool(t));
    }
  }

  // Keep tiers ordered by bps ascending (0.05 → 0.30 → 1.00).
  tiers.sort((a, b) => a.bps - b.bps);
  fs.writeFileSync(path.join(DIR, "pools-tiers.json"), JSON.stringify(tiers, null, 2) + "\n");
  console.log("\nwrote pools-tiers.json:\n", JSON.stringify(tiers, null, 2));
}

main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
