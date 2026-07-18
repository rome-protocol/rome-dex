/**
 * positions.spec.ts — Portfolio screen (no wallet).
 *
 * Renders without error and settles into a definite state: either the empty
 * state (no wallet / no LP) or position cards. Stat tiles are always present.
 */
import { test, expect } from "@playwright/test";
import { collectErrors } from "./helpers";

test.describe("Positions screen", () => {
  test("renders stat tiles + resolves to empty-state or cards, no errors", async ({ page }) => {
    const getErrors = collectErrors(page);
    await page.goto("/positions");
    await expect(page.getByRole("heading", { name: "Your positions" })).toBeVisible();

    // Three portfolio stat tiles.
    await expect(page.locator(".stats .stat")).toHaveCount(3);
    await expect(page.locator(".stats")).toContainText("Position value");

    // The screen starts in a loading state, then settles to a definite one:
    // an empty-state card or ≥1 position card. Wait for the loading note to go.
    await expect(page.locator(".card", { hasText: "Reading your positions" })).toHaveCount(0, {
      timeout: 15_000,
    });

    const emptyState = page.locator(".card", { hasText: "No LP positions" });
    const cards = page.locator(".poscard");
    await expect(async () => {
      const settled = (await emptyState.count()) > 0 || (await cards.count()) > 0;
      expect(settled, "positions did not settle to empty-state or cards").toBe(true);
    }).toPass({ timeout: 15_000 });

    expect(getErrors(), `Console/JS errors: ${getErrors().join(" | ")}`).toHaveLength(0);
  });
});
