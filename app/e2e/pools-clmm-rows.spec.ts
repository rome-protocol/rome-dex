/**
 * pools-clmm-rows.spec.ts — CLMM pools are first-class on the Pools screen.
 *
 * Live-user report (2026-07-08): "can't find CLMM pool anywhere" — the main
 * pools table only listed constant-product tiers; the concentrated pools were
 * reachable only via the /clmm nav item. And the provide panel read as
 * one-sided ("Deposit USDC" only) even though the deposit moves BOTH tokens.
 *
 * Pins: concentrated rows in the pools table (live TVL, click → /clmm with the
 * pool preselected), a provide affordance on created-pool rows, ?pool= deep
 * links on /clmm, and the two-sided add-liquidity inputs.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "harness", "clmm-real.json"), "utf8"));
const PROOF_POOL = "CD9zVVXdC4NFj5Es7ZpZd6qeP5uvENmUSET3Mwrh9asb";

test.describe("Pools screen — concentrated rows", () => {
  test("the table lists the concentrated pools with live TVL", async ({ page }) => {
    await page.goto("/pools");
    const rows = page.getByTestId("clmm-pool-row");
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await expect(rows.first()).toContainText(/SOL\s*\/\s*USDC/);
    await expect(rows.first().locator(".badge.tier")).toContainText(/concentrated/i);
    // TVL is a live vault read — a dollar figure, not a dash.
    await expect(rows.first().locator("[data-testid=clmm-row-tvl]")).toContainText(/\$/, { timeout: 20_000 });
  });

  test("clicking a concentrated row lands on /clmm with that pool selected", async ({ page }) => {
    await page.goto("/pools");
    const row = page.getByTestId("clmm-pool-row").first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/clmm\\?pool=${REAL.pool}`));
    await expect(page.getByTestId("clmm-pool-card")).toContainText("SOL / USDC");
  });

  test("/clmm?pool= deep link preselects that pool in the picker", async ({ page }) => {
    await page.goto(`/clmm?pool=${PROOF_POOL}`);
    await expect(page.getByTestId("clmm-pool-card")).toContainText("tRDA / tRDB", { timeout: 20_000 });
    await expect(page.getByTestId("clmm-pool-picker")).toHaveValue(PROOF_POOL);
  });

  test("a created concentrated pool row offers 'provide' → /clmm with it selected", async ({ page }) => {
    await page.addInitScript((real) => {
      localStorage.setItem("rome-dex:my-pools", JSON.stringify([{
        kind: "clmm", pool: real.pool, program: real.program,
        mintA: real.mint0, mintB: real.mint1, symbolA: real.symbol0, symbolB: real.symbol1,
        decimalsA: real.decimals0, decimalsB: real.decimals1,
        vaultA: real.vault0, vaultB: real.vault1, feeBps: 30, tier: "0.30%",
        createdSig: "x", createdAt: 1,
      }]));
    }, REAL);
    await page.goto("/pools");
    const provide = page.getByTestId("my-pool-provide");
    await expect(provide).toBeVisible({ timeout: 15_000 });
    await provide.click();
    await expect(page).toHaveURL(new RegExp(`/clmm\\?pool=${REAL.pool}`));
  });
});

test.describe("Add liquidity — two-sided by construction", () => {
  test("typing either token computes the other from the live pool ratio", async ({ page }) => {
    await page.goto("/pools/30"); // USDC/SOL 0.30% detail
    const a = page.getByTestId("liq-add-input");
    const b = page.getByTestId("liq-add-input-b");
    await expect(a).toBeVisible({ timeout: 20_000 });
    await expect(b).toBeVisible();

    // A → B: enter 10 USDC, the SOL side fills with a nonzero amount.
    await a.fill("10");
    await expect(b).not.toHaveValue("", { timeout: 15_000 });
    const solSide = parseFloat(await b.inputValue());
    expect(solSide).toBeGreaterThan(0);

    // B → A: editing the SOL side recomputes USDC.
    await b.fill(String((solSide * 2).toFixed(6)));
    await expect(a).not.toHaveValue("10", { timeout: 15_000 });
    expect(parseFloat(await a.inputValue())).toBeGreaterThan(10);

    // The deposit preview states BOTH amounts (nothing moves silently).
    await expect(page.getByTestId("add-preview")).toContainText("USDC");
    await expect(page.getByTestId("add-preview")).toContainText("SOL");
  });
});
