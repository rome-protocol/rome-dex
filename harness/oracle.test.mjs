// oracle.test.mjs — asserts the Rome oracle layer reads SANE live USD prices
// via eth_call (Chainlink-compatible latestRoundData + decimals) on the EVM RPC.
// Pure read, no key needed. Run sequentially: `node --test oracle.test.mjs`.
//
// Feeds are LIVE Chainlink-compatible aggregators on Hadrian (registry
// chains/200010-hadrian/oracle.json). If the RPC is unreachable the network
// asserts skip loudly rather than hang.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPrice, feedFor, FEEDS } from "../sdk/oracle.mjs";

// A price is "sane" if positive and within a wide band; timestamp is a unix
// seconds value not absurdly in the past (feeds may lag on devnet, so we only
// require it to be a plausible recent-ish epoch, not fresh-to-the-second).
function assertSane(p, { min, max }) {
  assert.equal(typeof p.price, "number", "price is a number");
  assert.ok(p.price > min, `price ${p.price} > ${min}`);
  assert.ok(p.price < max, `price ${p.price} < ${max}`);
  assert.equal(typeof p.decimals, "number", "decimals is a number");
  assert.ok(p.decimals >= 0 && p.decimals <= 18, `decimals ${p.decimals} in [0,18]`);
  assert.equal(typeof p.updatedAt, "number", "updatedAt is a number");
  assert.ok(p.updatedAt > 1_600_000_000, `updatedAt ${p.updatedAt} is a plausible epoch (post-2020)`);
  assert.equal(typeof p.stale, "boolean", "stale is a boolean");
}

test("feedFor maps token symbols to feed addresses", () => {
  assert.equal(feedFor("SOL"), FEEDS["SOL/USD"].address);
  assert.equal(feedFor("USDC"), FEEDS["USDC/USD"].address);
  assert.equal(feedFor("ETH"), FEEDS["ETH/USD"].address);
  // wrapped-token aliases resolve to the same feed
  assert.equal(feedFor("wSOL"), FEEDS["SOL/USD"].address);
  assert.equal(feedFor("wUSDC"), FEEDS["USDC/USD"].address);
  // unknown symbol → null (graceful: no feed, no USD)
  assert.equal(feedFor("A"), null);
  assert.equal(feedFor("XYZ"), null);
});

test("SOL/USD reads a sane live price (1 < p < 100000, 8 decimals)", async () => {
  const p = await fetchPrice("SOL/USD");
  assertSane(p, { min: 1, max: 100_000 });
  assert.equal(p.decimals, 8, "SOL/USD feed is 8 decimals");
  console.log(`  SOL/USD = $${p.price} (decimals=${p.decimals}, updatedAt=${p.updatedAt}, stale=${p.stale})`);
});

test("USDC/USD reads a sane live price (~1)", async () => {
  const p = await fetchPrice("USDC/USD");
  // USDC should peg near $1 — allow a generous band for devnet feed drift.
  assertSane(p, { min: 0.5, max: 2 });
  console.log(`  USDC/USD = $${p.price} (decimals=${p.decimals}, updatedAt=${p.updatedAt}, stale=${p.stale})`);
});

test("fetchPrice by token symbol resolves the feed (SOL → SOL/USD)", async () => {
  const p = await fetchPrice("SOL");
  assertSane(p, { min: 1, max: 100_000 });
});

test("fetchPrice on an unknown symbol returns null (graceful)", async () => {
  assert.equal(await fetchPrice("A"), null);
});
