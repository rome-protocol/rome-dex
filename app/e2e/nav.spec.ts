/**
 * nav.spec.ts — TopNav tab navigation.
 *
 * Asserts the 4 tabs exist, active-tab state is exposed via aria-selected (a
 * stable ARIA hook, not a CSS class), and clicking a tab navigates.
 */
import { test, expect } from "@playwright/test";

const TABS = [
  { testid: "tab-swap", label: "Swap", path: "/" },
  { testid: "tab-pools", label: "Pools", path: "/pools" },
  { testid: "tab-clmm", label: "CLMM", path: "/clmm" },
  { testid: "tab-positions", label: "Positions", path: "/positions" },
  { testid: "tab-farms", label: "Farms", path: "/farms" },
  { testid: "tab-analytics", label: "Analytics", path: "/analytics" },
];

test.describe("TopNav", () => {
  test("exactly 6 tabs render", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveCount(6);
    for (const t of TABS) {
      await expect(page.getByRole("tab", { name: t.label })).toBeVisible();
    }
  });

  test("Swap tab is active on the home route (aria-selected)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("tab-swap")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("tab-pools")).toHaveAttribute("aria-selected", "false");
  });

  test("clicking each tab navigates and updates active state", async ({ page }) => {
    await page.goto("/");
    for (const t of TABS) {
      await page.getByTestId(t.testid).click();
      await expect(page).toHaveURL(new RegExp(`${t.path === "/" ? "/$" : t.path}`));
      await expect(page.getByTestId(t.testid)).toHaveAttribute("aria-selected", "true");
    }
  });

  test("pool-detail route keeps the Pools tab active", async ({ page }) => {
    await page.goto("/pools/30");
    await expect(page.getByTestId("tab-pools")).toHaveAttribute("aria-selected", "true");
  });
});
