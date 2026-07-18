// indexer.test.mjs — TEST-FIRST proof that the on-demand analytics indexer
// reflects REAL on-chain swap flow.
//
// Strategy: scan a live pool's swap history BEFORE a swap, land one real
// exact-in swap on the Solana lane, scan AFTER, and assert the indexer's
// realized input-volume for the input token grew by exactly the amount swapped
// (raw-token delta is price-independent → a hard equality) and that USD volume
// + LP fees both increased.
//
//   run:  HADRIAN_PRIVATE_KEY=<your-funded-devnet-key> \
//         node --test harness/indexer.test.mjs
//
// The swap step signs with the local Solana keypair (harness payer), so it runs
// without the EVM key. The whole suite is Solana-lane; no HADRIAN_PRIVATE_KEY
// needed. It exercises app/lib/indexer-core.mjs — the canonical scan/aggregate
// core the server-side lib/indexer.ts mirrors.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  payer, pool, bal, mintIfLow, swapAccounts, swapData, execSolana,
} from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const core = await import(path.join(DIR, "../app/lib/indexer-core.mjs"));
const { scanPoolSwaps, aggregate } = core;

// pool.json carries the primary USDC/SOL pool; give the scanner the fee-tier
// fields it needs (default 0.30% trade fee if the file predates them).
const P = {
  ...pool,
  feeTradeNum: pool.feeTradeNum ?? 25,
  feeTradeDen: pool.feeTradeDen ?? 10000,
  decimalsA: pool.decimalsA ?? 6,
  decimalsB: pool.decimalsB ?? 9,
  symbolA: pool.symbols?.A ?? pool.symbolA ?? "USDC",
  symbolB: pool.symbols?.B ?? pool.symbolB ?? "SOL",
};

// A fixed price map keeps the USD assertion deterministic (real oracle prices
// are covered by oracle.test.mjs; here we test the indexer's counting).
const PRICES = { USDC: 1, SOL: 150, ETH: 3000 };

const AMOUNT_IN = 2_000_000n; // 2 USDC (6 dp) — input token A
const inSym = P.symbolA;      // USDC

let beforeAgg, afterAgg, beforeScan, afterScan;

test("indexer core exports scan + aggregate", () => {
  assert.equal(typeof scanPoolSwaps, "function");
  assert.equal(typeof aggregate, "function");
});

test("scan a live pool and aggregate to non-negative USD totals", async () => {
  beforeScan = await scanPoolSwaps(P, { maxSigs: 300 });
  beforeAgg = aggregate(beforeScan.swaps, PRICES);
  assert.ok(beforeAgg.volumeUsdAll >= 0);
  assert.ok(beforeAgg.feesUsdAll >= 0);
  assert.equal(typeof beforeAgg.evmSwaps, "number");
  assert.equal(typeof beforeAgg.solSwaps, "number");
});

test("a real exact-in swap moves the indexer's realized volume + fees", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, AMOUNT_IN, 500_000_000n);
  const before = await bal(pool.payerAtaB);
  const r = await execSolana({
    accounts: swapAccounts("AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB),
    data: swapData(AMOUNT_IN, 0n),
  });
  assert.ok(r.ok, "swap should land");
  assert.ok((await bal(pool.payerAtaB)) - before > 0n, "should receive some B");

  // Re-scan (raw core, no cache). Absorb confirmation propagation lag: retry
  // until the new swap shows up in the signature list (bounded).
  for (let i = 0; i < 10; i++) {
    afterScan = await scanPoolSwaps(P, { maxSigs: 300 });
    afterAgg = aggregate(afterScan.swaps, PRICES);
    if (afterAgg.swapCount > beforeAgg.swapCount) break;
    await new Promise((res) => setTimeout(res, 2000));
  }

  // 1) Raw input-token volume grew by exactly the amount swapped in (price-free).
  const rawBefore = beforeAgg.rawVolBySymbol[inSym] ?? 0;
  const rawAfter = afterAgg.rawVolBySymbol[inSym] ?? 0;
  const rawDelta = rawAfter - rawBefore;
  const expected = Number(AMOUNT_IN) / 10 ** P.decimalsA; // 2.0 USDC
  assert.ok(
    Math.abs(rawDelta - expected) < 1e-6,
    `raw ${inSym} volume delta ${rawDelta} should equal swapped-in ${expected}`,
  );

  // 2) Swap count grew by at least one.
  assert.ok(afterAgg.swapCount > beforeAgg.swapCount, "swap count should increase");

  // 3) USD volume + LP fees strictly increased.
  assert.ok(afterAgg.volumeUsdAll > beforeAgg.volumeUsdAll, "USD volume should increase");
  assert.ok(afterAgg.feesUsdAll > beforeAgg.feesUsdAll, "LP fees should increase");

  // 4) The USD + fee deltas match the swap: 2 USDC @ $1 = $2 volume, × trade rate.
  const volDelta = afterAgg.volumeUsdAll - beforeAgg.volumeUsdAll;
  const feeDelta = afterAgg.feesUsdAll - beforeAgg.feesUsdAll;
  assert.ok(Math.abs(volDelta - expected * PRICES[inSym]) < 1e-3, `USD vol delta ${volDelta} ~ $${expected}`);
  const rate = P.feeTradeNum / P.feeTradeDen;
  assert.ok(Math.abs(feeDelta - expected * PRICES[inSym] * rate) < 1e-3, `fee delta ${feeDelta} ~ trade-fee`);
});

after(() => {
  if (!afterAgg) return;
  console.log("\n=== indexer delta (live pool " + P.swapState.slice(0, 8) + "…) ===");
  console.log(`  swaps scanned         : ${beforeScan.scanned} → ${afterScan.scanned} (truncated=${afterScan.truncated})`);
  console.log(`  swap count            : ${beforeAgg.swapCount} → ${afterAgg.swapCount}`);
  console.log(`  volume USD (all-time) : $${beforeAgg.volumeUsdAll.toFixed(2)} → $${afterAgg.volumeUsdAll.toFixed(2)}`);
  console.log(`  LP fees USD (all-time): $${beforeAgg.feesUsdAll.toFixed(4)} → $${afterAgg.feesUsdAll.toFixed(4)}`);
  console.log(`  lane split (count)    : EVM ${afterAgg.evmSwaps} / SOL ${afterAgg.solSwaps}`);
  const since = afterScan.earliestBlockTime;
  console.log(`  indexed since         : ${since ? new Date(since * 1000).toISOString() : "—"}`);
});
