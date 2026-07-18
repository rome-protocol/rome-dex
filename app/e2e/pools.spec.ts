/**
 * pools.spec.ts — Pools table.
 *
 * Stat tiles render, the table has ≥1 live row carrying a fee-tier badge and a
 * dual-lane access badge, and clicking a row navigates to /pools/<id>.
 */
import { test, expect } from "@playwright/test";

test.describe("Pools screen", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/pools");
    await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
  });

  test("stat tiles render", async ({ page }) => {
    const tiles = page.locator(".stats .stat");
    await expect(tiles).toHaveCount(4);
    await expect(page.locator(".stats")).toContainText("Total value locked");
    await expect(page.locator(".stats")).toContainText("Pools");
  });

  test("table renders ≥1 live pool row with tier + dual-lane badges", async ({ page }) => {
    // Rows hydrate after /api/pools resolves.
    const rows = page.getByTestId("pool-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(1);

    const first = rows.first();
    await expect(first.locator(".badge.tier")).toBeVisible();
    await expect(first.locator(".badge.dual")).toContainText("dual-lane");
  });

  test("table shows BOTH pairs (USDC/SOL and USDC/ETH)", async ({ page }) => {
    const rows = page.getByTestId("pool-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const table = page.locator("table.tbl");
    await expect(table).toContainText("USDC / SOL");
    await expect(table).toContainText("USDC / ETH");
  });

  test("clicking a row navigates to /pools/<poolId>", async ({ page }) => {
    const rows = page.getByTestId("pool-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await rows.first().click();
    await expect(page).toHaveURL(/\/pools\/\d+$/);
    // Landed on a detail page with a liquidity panel.
    await expect(page.getByTestId("liquidity-panel")).toBeVisible({ timeout: 15_000 });
  });
});
