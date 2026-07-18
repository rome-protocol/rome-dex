/**
 * analytics.spec.ts — Analytics dashboard (real indexed data).
 *
 * The canvases render (cumulative-volume area chart + daily-volume bars), the
 * volume-by-lane card resolves (legend when swaps are indexed, else a no-swaps
 * note), the top-pools table renders, and the data-provenance footnote states
 * everything is live on-chain.
 */
import { test, expect } from "@playwright/test";

test.describe("Analytics screen", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  });

  test("at least two chart canvases render", async ({ page }) => {
    const canvases = page.locator("canvas");
    await expect(async () => {
      expect(await canvases.count()).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 15_000 });
    await expect(canvases.first()).toBeVisible();
  });

  test("volume-by-lane card resolves (legend or no-swaps note)", async ({ page }) => {
    // The lane card headline is always present.
    await expect(page.locator(".chartcard", { hasText: "Volume by lane" })).toBeVisible();
    // After the indexer resolves it shows either the lane legend or a no-swaps note.
    const legend = page.locator(".legend");
    const noSwaps = page.getByText("No trades yet");
    await expect(async () => {
      const settled = (await legend.count()) > 0 || (await noSwaps.count()) > 0;
      expect(settled, "lane split did not resolve").toBe(true);
    }).toPass({ timeout: 30_000 });
  });

  test("top-pools table renders", async ({ page }) => {
    await expect(page.locator(".tbl")).toContainText("Top pools by volume");
  });

  test("Provenance footnote states data is live on-chain", async ({ page }) => {
    const prov = page.locator(".provenance");
    await expect(prov).toBeVisible();
    await expect(prov).toContainText("Data provenance");
    await expect(prov).toContainText("live on-chain");
  });
});
