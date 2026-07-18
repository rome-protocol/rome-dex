// Multi-hop routing suite: atomically swap A→B→C across TWO pools in one Solana
// tx, and assert the end-to-end output equals the SDK route quote to the unit.
// Proves multi-pool composition on a shared hub token (B) + exact route quoting.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quoteRoute, POOL_FEES } from "../sdk/quote.mjs";
import {
  payer, pool, bal, reserves, swapAccountsFor, swapData, execSolanaMulti, mintIfLow,
} from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const p2 = JSON.parse(fs.readFileSync(path.join(DIR, "pool2.json"), "utf8"));
const cu = {};

test("atomic multi-hop A→B→C (one Solana tx) matches the route quote exactly", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, 100_000_000n, 500_000_000n);
  const amountIn = 2_000_000n; // 2 A

  // pre-tx reserves of each pool (leg2's pool is untouched by leg1)
  const r1 = await reserves();
  const r2 = { a: await bal(p2.vaultA), b: await bal(p2.vaultB) };
  const q = quoteRoute({
    amountIn,
    hops: [
      { reserveIn: r1.a, reserveOut: r1.b, fees: POOL_FEES }, // A→B in pool1
      { reserveIn: r2.a, reserveOut: r2.b, fees: POOL_FEES }, // B→C in pool2
    ],
  });
  const leg1Out = q.legs[0].amountOut; // exact B out of leg1 → exact B into leg2

  const payerB = pool.payerAtaB;      // hub token ATA (pool2.payerAtaA)
  const payerC = p2.payerAtaB;        // final output ATA
  const beforeB = await bal(payerB);
  const beforeC = await bal(payerC);

  const r = await execSolanaMulti([
    { accounts: swapAccountsFor(pool, "AtoB", payer.publicKey, pool.payerAtaA, payerB), data: swapData(amountIn, 0n) },
    { accounts: swapAccountsFor(p2, "AtoB", payer.publicKey, payerB, payerC), data: swapData(leg1Out, 0n) },
  ]);
  assert.ok(r.ok, "atomic route should land");

  const gotC = (await bal(payerC)) - beforeC;
  const netB = (await bal(payerB)) - beforeB;
  // Route output is exact vs the SDK route quote.
  assert.equal(gotC, q.amountOut, `route output ${gotC} vs quote ${q.amountOut}`);
  assert.ok(gotC > 0n, "should receive some C");
  // The hub token passes through, minus negligible dust: exact-in refunds the
  // sub-unit ceil_div input rounding, so leg2 consumes ≤ what leg1 produced.
  // netB is that dust — non-negative and tiny (a real router sweeps it or uses
  // exact-out for the final leg).
  assert.ok(netB >= 0n, "route must never overdraw the hub token");
  assert.ok(netB < 1_000n, `hub dust should be negligible, got ${netB}`);
  cu.route = r.cu;
  cu.hubDust = netB;
});

after(() => {
  console.log("\n=== multi-hop A→B→C across 2 pools (permissionless pool2 " + p2.swapState.slice(0, 8) + "…) ===");
  console.log(`  atomic 2-leg route, one Solana tx : ${cu.route ?? "—"} CU`);
  console.log(`  hub dust (exact-in rounding)      : ${cu.hubDust ?? "—"} (of ~1.1e9 B, negligible)`);
});
