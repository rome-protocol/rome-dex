/**
 * charts.spec.ts — empty-series detection for the canvas charts. An empty or
 * all-zero series must render an honest "no activity yet" message, never a
 * misleading flat line at zero (the chart drawing itself is canvas; this
 * guards the pure predicate that gates it, and render.spec guarantees the
 * empty-path renders without console errors on every route).
 */
import { test, expect } from "@playwright/test";
import { isEmptySeries } from "@/components/Charts";

test.describe("chart empty-series detection", () => {
  test("no points or all-zero → empty (honest message, not a flat line)", () => {
    expect(isEmptySeries([])).toBe(true);
    expect(isEmptySeries([0])).toBe(true);
    expect(isEmptySeries([0, 0, 0])).toBe(true);
  });
  test("any non-zero point → not empty (real data, draw it)", () => {
    expect(isEmptySeries([0, 0, 1])).toBe(false);
    expect(isEmptySeries([5])).toBe(false);
  });
});
