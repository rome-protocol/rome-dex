/**
 * pool.spec.ts — Pool detail (/pools/[id]).
 *
 * Price chart canvas renders, the kv stat grid is present, and the LiquidityPanel
 * exposes the Add / Remove / Zap segmented control (no wallet needed).
 */
import { test, expect } from "@playwright/test";

test.describe("Pool detail screen", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/pools/30");
  });

  test("header shows the pair + tier badge", async ({ page }) => {
    const head = page.locator(".sc-head");
    await expect(head).toContainText("USDC");
    await expect(head).toContainText("SOL");
    await expect(head.locator(".badge.tier")).toContainText("0.30%");
  });

  test("price chart canvas renders", async ({ page }) => {
    const chart = page.getByTestId("pool-chart");
    await expect(chart).toBeVisible({ timeout: 15_000 });
    await expect(chart.locator("canvas")).toBeVisible();
  });

  test("kv stat grid shows TVL / reserves", async ({ page }) => {
    const kv = page.locator(".kv");
    await expect(kv).toBeVisible({ timeout: 15_000 });
    await expect(kv).toContainText("TVL");
    await expect(kv).toContainText("APR");
    await expect(kv).toContainText("Reserve USDC");
  });

  test("LiquidityPanel has Add / Remove / Zap controls", async ({ page }) => {
    const panel = page.getByTestId("liquidity-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("liq-tab-add")).toBeVisible();
    await expect(page.getByTestId("liq-tab-remove")).toBeVisible();
    await expect(page.getByTestId("liq-tab-zap")).toBeVisible();

    // Add is the default active segment (aria-selected — stable hook).
    await expect(page.getByTestId("liq-tab-add")).toHaveAttribute("aria-selected", "true");

    // Switching segments updates the active state.
    await page.getByTestId("liq-tab-remove").click();
    await expect(page.getByTestId("liq-tab-remove")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("liq-tab-add")).toHaveAttribute("aria-selected", "false");
  });

  test("2nd-pair pool detail (/pools/1030) renders USDC/ETH", async ({ page }) => {
    await page.goto("/pools/1030");
    const head = page.locator(".sc-head");
    await expect(head).toContainText("USDC");
    await expect(head).toContainText("ETH");
    await expect(head.locator(".badge.tier")).toContainText("0.30%");
    await expect(page.getByTestId("liquidity-panel")).toBeVisible({ timeout: 15_000 });
  });

  test("unknown tier id shows a graceful not-found message", async ({ page }) => {
    await page.goto("/pools/9999");
    await expect(page.locator(".wrap.page")).toContainText("No pool for tier id", {
      timeout: 15_000,
    });
  });
});
