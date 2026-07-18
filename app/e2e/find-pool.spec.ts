/**
 * find-pool.spec.ts — "Find a pool" on /pools. Pools are deterministic PDAs, so a
 * pool NOT created on this device can be found by deriving its address from two
 * tokens + a fee tier + a type and checking on-chain (findPool). A found pool is
 * added to the registry → appears + becomes tradable. This exercises the UI
 * surface; the derivation/on-chain path is unit-verified against the live pool.
 */
import { test, expect } from "@playwright/test";

test.describe("Find a pool — /pools", () => {
  test("toggle reveals the find form (type, tokens, tiers)", async ({ page }) => {
    await page.goto("/pools");
    await expect(page.getByTestId("find-pool-panel")).toHaveCount(0);
    await page.getByTestId("find-pool-toggle").click();
    await expect(page.getByTestId("find-pool-panel")).toBeVisible();
    await expect(page.getByTestId("find-type-simple")).toBeVisible();
    await expect(page.getByTestId("find-type-clmm")).toBeVisible();
    await expect(page.getByTestId("find-token-a")).toBeVisible();
    await expect(page.getByTestId("find-token-b")).toBeVisible();
    for (const t of ["0.05%", "0.30%", "1.00%"]) await expect(page.getByTestId(`find-tier-${t}`)).toBeVisible();
    // Disabled until two distinct tokens are chosen.
    await expect(page.getByTestId("find-pool-btn")).toBeDisabled();
  });

  test("choosing two tokens enables Find", async ({ page }) => {
    await page.goto("/pools");
    await page.getByTestId("find-pool-toggle").click();
    await page.getByTestId("find-token-a").selectOption({ label: "USDC" });
    await page.getByTestId("find-token-b").selectOption({ label: "SOL" });
    await expect(page.getByTestId("find-pool-btn")).toBeEnabled();
  });
});
