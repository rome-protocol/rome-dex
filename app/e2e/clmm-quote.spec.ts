/**
 * clmm-quote.spec.ts — the TS CLMM quote mirror must stay byte-faithful to the
 * on-chain math. Pure logic (no browser). Cross-checks tick math against the
 * SAME audited reference vectors the Rust core and sdk/clmm-quote.mjs assert,
 * plus round-trips and the price↔tick UI helpers. If this drifts, the app
 * quotes a CLMM trade the chain won't honor.
 */
import { test, expect } from "@playwright/test";
import {
  getSqrtPriceAtTick, getTickAtSqrtPrice, MIN_TICK, MAX_TICK,
  MIN_SQRT_PRICE, MAX_SQRT_PRICE, tickToPrice, priceToTick, sqrtPriceToPrice,
  getAmountsForLiquidity, getLiquidityForAmounts,
} from "@/lib/clmm-quote";

// (tick, exact sqrt_price Q64.64) — from clmm/src/curve/tick_math.rs (audited).
const VEC: [number, bigint][] = [
  [0, 18446744073709551616n], [1, 18447666387855959850n], [-1, 18445821805675392312n],
  [10, 18455969290605290415n], [-10, 18437523468038800970n], [100, 18539204128674405694n],
  [-100, 18354745142194483680n], [1000, 19392480388906835027n], [-1000, 17547129613991599912n],
  [10000, 30412779051191529115n], [-10000, 11188795550323333171n],
  [100000, 2737055259406564611100n], [-100000, 124324258982888375n],
  [443636, 79226673515399013880257568879n], [-443636, 4295048016n],
];

test.describe("CLMM quote mirror — faithful to the on-chain math", () => {
  test("tick math matches the audited reference vectors exactly", () => {
    for (const [t, want] of VEC) {
      expect(getSqrtPriceAtTick(t), `sqrt at tick ${t}`).toBe(want);
    }
  });

  test("get_tick_at_sqrt_price round-trips the vectors", () => {
    for (const [t, sp] of VEC) {
      expect(getTickAtSqrtPrice(sp), `tick at sqrt(${t})`).toBe(t);
    }
  });

  test("band edges are the documented bounds", () => {
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
  });

  test("price↔tick helpers round-trip on the spacing grid", () => {
    const spacing = 64;
    for (const t of [-1280, -640, 0, 640, 1280, 5632]) {
      const price = tickToPrice(t);
      const back = priceToTick(price, spacing);
      expect(back, `tick ${t} → price ${price} → tick`).toBe(t);
    }
  });

  test("price at tick 0 is 1.0 and rises with tick", () => {
    expect(sqrtPriceToPrice(getSqrtPriceAtTick(0))).toBeCloseTo(1.0, 9);
    expect(tickToPrice(1000)).toBeGreaterThan(tickToPrice(0));
    expect(tickToPrice(-1000)).toBeLessThan(tickToPrice(0));
  });

  test("liquidity↔amounts: in-range band needs both tokens, and L round-trips", () => {
    const sqrtP = getSqrtPriceAtTick(0); // price 1.0, in [-1280, 1280]
    const L = 1_000_000_000n;
    // Amounts you'd RECEIVE for L (round-down), then budget them back: the
    // conservative inverse never asks for more L than the budget supports.
    const [a0, a1] = getAmountsForLiquidity(sqrtP, 0, -1280, 1280, L, false);
    expect(a0 > 0n && a1 > 0n).toBe(true);
    const backL = getLiquidityForAmounts(sqrtP, 0, -1280, 1280, a0, a1);
    expect(backL <= L).toBe(true);
    expect(backL > (L * 999n) / 1000n).toBe(true); // within 0.1%
  });

  test("liquidity↔amounts: below-range band is single-sided (token0 only)", () => {
    const sqrtP = getSqrtPriceAtTick(0);
    const [a0, a1] = getAmountsForLiquidity(sqrtP, 0, 640, 1280, 1_000_000_000n, true);
    expect(a0 > 0n).toBe(true);
    expect(a1).toBe(0n);
  });
});
