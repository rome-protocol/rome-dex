// Pins the client CLMM quote walkers (sdk/clmm-quote.mjs and its TS mirror
// app/lib/clmm-quote.ts) against the on-chain crossings cap in
// clmm/src/engine.rs (MAX_CROSSINGS_PER_SWAP=16). Pure fixture — no RPC, no
// live pool, runs standalone.
//
// Without the cap, a swap whose path holds >16 initialized ticks quotes a
// FULL fill while the program partial-fills at 16 crossings; a caller sizing
// minOut off that quote gets SlippageExceeded on-chain every time, at any
// slippage setting, since the revert leaves pool state unchanged and retries
// can't help. The fixture vector below is the exact output engine::swap
// produces for this fixture (captured via a temporary eprintln! in
// clmm/src/engine.rs's swap_stops_at_crossing_cap, matching its build_24_tick_window
// setup exactly) — the walkers must reproduce it byte-for-byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as js from "../sdk/clmm-quote.mjs";
import * as ts from "../app/lib/clmm-quote.ts";

const SPACING = 64;
const TICK_ARRAY_SIZE = 88;
const SPAN = TICK_ARRAY_SIZE * SPACING; // 5632
const BOUNDARY_NET = 1000n;

// Mirrors clmm/src/engine.rs tests::tick_boundaries() exactly: 24 contiguous
// boundaries, one spacing apart, ticks -5184..-6656 (nearest-to-farthest).
const tickBoundaries = () => Array.from({ length: 24 }, (_, i) => -64 * (81 + i));

function emptyTicks() {
  return Array.from({ length: TICK_ARRAY_SIZE }, () => ({ liquidityGross: 0n, liquidityNet: 0n }));
}

// Mirrors clmm/src/engine.rs tests::build_24_tick_window(): a pool at tick 0
// with 4 tick arrays in walk order, 24 boundary ticks seeded with nonzero net
// (first 8 in array1, remaining 16 in array2 — crossing an array boundary
// partway through the walk, same as the Rust fixture).
function buildFixture() {
  const pool = {
    isInitialized: true, bump: 255, feePips: 3000, tickSpacing: SPACING,
    currentTick: 0, sqrtPrice: js.getSqrtPriceAtTick(0), liquidity: 1n << 40n,
    feeGrowthGlobal0: 0n, feeGrowthGlobal1: 0n,
  };
  const arrays = [
    { startTickIndex: 0, ticks: emptyTicks() },
    { startTickIndex: -SPAN, ticks: emptyTicks() },
    { startTickIndex: -2 * SPAN, ticks: emptyTicks() },
    { startTickIndex: -3 * SPAN, ticks: emptyTicks() }, // headroom only
  ];
  for (const t of tickBoundaries()) {
    const arr = t < -SPAN ? arrays[2] : arrays[1];
    const slot = (t - arr.startTickIndex) / SPACING;
    arr.ticks[slot] = { liquidityGross: BOUNDARY_NET, liquidityNet: BOUNDARY_NET };
  }
  return { pool, arrays };
}

// Golden vector from clmm/src/engine.rs::swap on this exact fixture (zero_for_one,
// amount_in=500_000_000_000, MIN_SQRT_PRICE limit) — the program's ground truth.
const EXPECTED = {
  amountIn: 395375564248n,
  fee: 1189695788n,
  amountOut: 290804572088n,
  sqrtPriceAfter: 13567852949051854384n,
  tickAfter: -6145,
  amountInRemaining: 103434739964n, // 500_000_000_000 - (amountIn + fee)
};

for (const [name, mod] of [["sdk/clmm-quote.mjs", js], ["app/lib/clmm-quote.ts", ts]]) {
  test(`${name}: caps at MAX_CROSSINGS_PER_SWAP and reports the partial fill`, () => {
    const { pool, arrays } = buildFixture();
    const q = mod.quoteClmmExactInSync(pool, arrays, true, 500_000_000_000n, js.MIN_SQRT_PRICE);
    assert.equal(q.amountIn, EXPECTED.amountIn, "capped amountIn must match the program exactly");
    assert.equal(q.fee, EXPECTED.fee, "capped fee must match the program exactly");
    assert.equal(q.amountOut, EXPECTED.amountOut, "capped amountOut must match the program exactly");
    assert.equal(q.sqrtPriceAfter, EXPECTED.sqrtPriceAfter, "resting price must match the program exactly");
    assert.equal(q.tickAfter, EXPECTED.tickAfter, "resting tick must match the program exactly");
    assert.equal(q.partial, true, "a capped swap must be flagged partial");
    assert.equal(q.amountInRemaining, EXPECTED.amountInRemaining, "unconsumed input must be surfaced");
  });
}

test("sdk and app mirrors agree with each other on the capped fixture", () => {
  const { pool, arrays } = buildFixture();
  const a = js.quoteClmmExactInSync(pool, arrays, true, 500_000_000_000n, js.MIN_SQRT_PRICE);
  const b = ts.quoteClmmExactInSync(pool, arrays, true, 500_000_000_000n, js.MIN_SQRT_PRICE);
  assert.deepEqual(a, b, "sdk/clmm-quote.mjs and app/lib/clmm-quote.ts must be byte-faithful to each other");
});
