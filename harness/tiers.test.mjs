// Multi fee-tier suite (Phase 3): quote every tier of the SAME A/B pair, assert
// the SDK's bestTier() picks the pool that ACTUALLY yields the best on-chain
// output, and prove tier selection is dual-lane.
//
//   • Solana lane — execute a small exact-in swap on the SDK-chosen best tier
//     and confirm the realized output beats-or-ties every other tier's quote.
//   • EVM lane    — execute one exact-in swap via CPI on the chosen tier's pool,
//     confirming the account builder targets the SELECTED pool (not a hardcoded
//     one) and delivers output > 0.
//
// Reuses the existing A/B mints; pools created by create-tiered-pools.mjs.
// EVM-lane test skips (not fails) without HADRIAN_PRIVATE_KEY.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { bestTier } from "../sdk/quote.mjs";
import {
  payer, tiers, bal, reservesOf, tierFees, mintIfLow, pool,
  evmPdaFor, ensureAta, EVM_DEPLOYER,
  swapAccountsFor, swapData, execSolana, execEvmCpi,
} from "./lib.mjs";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const NO_TIERS = tiers ? false : "run harness/create-tiered-pools.mjs first (pools-tiers.json missing)";
const AMOUNT_IN = 5_000_000n; // 5 A (6 dp) — a mid-size trade where depth/fee matter
const MAX_IN = 100_000_000n;
const cu = {};

// Read live reserves of every tier, oriented A→B, and quote them all.
async function quoteAllTiers(amountIn) {
  const states = [];
  for (const t of tiers) {
    const { a, b } = await reservesOf(t);
    states.push({ tier: t.tier, swapState: t.swapState, reserveIn: a, reserveOut: b, fees: tierFees(t) });
  }
  const sel = bestTier({ amountIn, tiers: states });
  return { states, ...sel };
}

test("bestTier picks the tier that yields the greatest on-chain output (Solana lane)", async () => {
  assert.ok(tiers && tiers.length >= 2, "need ≥2 fee tiers");
  await mintIfLow(pool.mintA, pool.payerAtaA, MAX_IN, 500_000_000n);

  // 1) SDK selection over live reserves.
  const { best, quotes } = await quoteAllTiers(AMOUNT_IN);
  assert.ok(best, "bestTier must select a tier");
  const chosen = tiers.find((t) => t.swapState === best.swapState);
  assert.ok(chosen, "chosen tier resolves to a pool");

  // The chosen tier's quoted output must be ≥ every other tier's quoted output.
  for (const q of quotes) {
    if (!q.quote) continue;
    assert.ok(
      best.quote.amountOut >= q.quote.amountOut,
      `chosen ${best.tier} out=${best.quote.amountOut} should be ≥ ${q.tier} out=${q.quote.amountOut}`,
    );
  }

  // 2) Execute the swap on the CHOSEN tier's pool (Solana lane) and confirm the
  //    realized output equals the SDK quote to the unit AND beats-or-ties the
  //    quotes of the pools we did NOT pick (the whole point of tier selection).
  const before = await bal(pool.payerAtaB);
  const r = await execSolana({
    accounts: swapAccountsFor(chosen, "AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB),
    data: swapData(AMOUNT_IN, 0n),
  });
  assert.ok(r.ok, "swap on chosen tier should land");
  const realized = (await bal(pool.payerAtaB)) - before;

  assert.equal(realized, best.quote.amountOut, `realized ${realized} vs chosen quote ${best.quote.amountOut}`);
  for (const q of quotes) {
    if (!q.quote || q.swapState === best.swapState) continue;
    assert.ok(realized >= q.quote.amountOut, `realized ${realized} on ${best.tier} should beat/tie ${q.tier} (${q.quote.amountOut})`);
  }

  cu.chosenTier = best.tier;
  cu.solanaSwap = r.cu;
  cu.quotes = quotes.map((q) => `${q.tier}:${q.quote ? q.quote.amountOut : "—"}`).join("  ");
});

test("dual-lane: an EVM-lane swap routes to the SELECTED tier's pool", { skip: KEY ? false : (NO_TIERS || "no HADRIAN_PRIVATE_KEY") }, async () => {
  const { best } = await quoteAllTiers(AMOUNT_IN);
  const chosen = tiers.find((t) => t.swapState === best.swapState);

  const pda = evmPdaFor(EVM_DEPLOYER);
  const evmA = await ensureAta(chosen.mintA, pda, true);
  const evmB = await ensureAta(chosen.mintB, pda, true);
  await mintIfLow(chosen.mintA, evmA, MAX_IN, 500_000_000n);

  const before = await bal(evmB);
  const r = await execEvmCpi({
    accounts: swapAccountsFor(chosen, "AtoB", pda, evmA, evmB),
    data: swapData(AMOUNT_IN, 0n),
    key: KEY,
  });
  assert.ok(r.ok, `EVM swap on ${chosen.tier} tier should succeed: ${r.error || ""}`);
  const delta = (await bal(evmB)) - before;
  assert.ok(delta > 0n, `EVM-lane swap on selected tier ${chosen.tier} should deliver B, got ${delta}`);
  cu.evmSwap = r.maxCu;
  cu.evmLegs = r.legs;
});

after(() => {
  console.log("\n=== multi fee-tier best-price selection (A/B pair, " + (tiers?.length ?? 0) + " tiers) ===");
  console.log(`  per-tier quotes (out) : ${cu.quotes ?? "—"}`);
  console.log(`  SDK-chosen best tier  : ${cu.chosenTier ?? "—"}`);
  console.log(`  Solana lane swap (chosen tier) : ${cu.solanaSwap ?? "—"} CU`);
  console.log(`  EVM lane   swap (chosen tier) : ${cu.evmSwap ?? "—"} CU  (legs=${cu.evmLegs ?? "—"})`);
  if (cu.solanaSwap && cu.evmSwap)
    console.log(`  parity ratio          : ${(cu.evmSwap / cu.solanaSwap).toFixed(2)}×  (both « 1.4M)`);
});
