/**
 * clmm-picker.spec.ts — multi-pool /clmm + positions that can't get lost.
 *
 * The panel used to hardwire chain.clmm.pools[0]; these specs pin the new
 * surface: a pool picker over ALL config pools (+ device-created pools,
 * deduped), the pool card following the selection, a CLMM section on
 * /positions, and the "Track a position" recovery path (band → on-chain
 * verify). Position reads hit the LIVE chain — the deployer's real seed
 * position on the real SOL/USDC pool (addresses from committed artifacts:
 * harness/clmm-real.json + deploy/deployments.json) is the fixture, so
 * what these specs prove is what production does.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { tickToPrice } from "../lib/clmm-quote";

const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "harness", "clmm-real.json"), "utf8"));
// The recovery form takes PRICES (never ticks — experience-not-engineering);
// spacing-aligned ticks round-trip exactly through the app's own conversion.
const priceOf = (tick: number) => String(tickToPrice(tick, REAL.decimals0, REAL.decimals1));
const DEPLOYER_SOL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "deployments.json"), "utf8"),
).solana.devnet.upgradeAuthority as string;

async function connectSolanaAs(page: Page, pk: string) {
  await page.addInitScript((pubkey) => {
    const provider = {
      isPhantom: true,
      publicKey: null as { toString(): string } | null,
      connect: async () => ({ publicKey: { toString: () => pubkey } }),
      disconnect: async () => {},
      signTransaction: async (tx: unknown) => tx,
    };
    const w = window as unknown as Record<string, unknown>;
    w.phantom = { solana: provider };
    w.solana = provider;
  }, pk);
}

test.describe("CLMM pool picker", () => {
  test("picker lists the config pools and defaults to the first (SOL/USDC)", async ({ page }) => {
    const errors = [];
    await page.goto("/clmm");
    const picker = page.getByTestId("clmm-pool-picker");
    await expect(picker).toBeVisible();
    // Options render once the chain config loads — wait for them, don't race it.
    await expect(picker.locator("option").first()).toContainText(/SOL/, { timeout: 15_000 });
    const labels = await picker.locator("option").allTextContents();
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels[0]).toMatch(/SOL\s*\/\s*USDC/);
    expect(labels.some((l) => /tRDA\s*\/\s*tRDB/.test(l))).toBe(true);
    await expect(page.getByTestId("clmm-pool-card")).toContainText("SOL / USDC");
  });

  test("selecting another pool re-points the pool card and the panel", async ({ page }) => {
    await page.goto("/clmm");
    const picker = page.getByTestId("clmm-pool-picker");
    await expect(picker).toBeVisible();
    // Select the proof pool by its pool address value.
    await picker.selectOption("CD9zVVXdC4NFj5Es7ZpZd6qeP5uvENmUSET3Mwrh9asb");
    await expect(page.getByTestId("clmm-pool-card")).toContainText("tRDA / tRDB");
    // The live price for the selected pool loads too (proof pool trades ~1).
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
  });

  test("a device-created pool that duplicates a config pool is deduped", async ({ page }) => {
    await page.addInitScript((real) => {
      localStorage.setItem("rome-dex:my-pools", JSON.stringify([{
        kind: "clmm", pool: real.pool, program: real.program,
        mintA: real.mint0, mintB: real.mint1, symbolA: real.symbol0, symbolB: real.symbol1,
        decimalsA: real.decimals0, decimalsB: real.decimals1,
        vaultA: real.vault0, vaultB: real.vault1, feeBps: 30, tier: "0.30%",
        createdSig: "x", createdAt: 1,
      }]));
    }, REAL);
    await page.goto("/clmm");
    const picker = page.getByTestId("clmm-pool-picker");
    await expect(picker).toBeVisible();
    const values = await picker.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values.filter((v) => v === REAL.pool)).toHaveLength(1);
  });
});

test.describe("CLMM positions — durable + recoverable", () => {
  test("a tracked band shows on /positions (CLMM section, live on-chain read)", async ({ page }) => {
    await connectSolanaAs(page, DEPLOYER_SOL);
    await page.addInitScript(({ owner, pool, lower, upper }) => {
      localStorage.setItem(`clmm-positions:${owner}:${pool}`, JSON.stringify([{ lower, upper }]));
    }, { owner: DEPLOYER_SOL, pool: REAL.pool, lower: REAL.positionLower, upper: REAL.positionUpper });
    await page.goto("/positions");
    await page.getByTestId("wallet-pill-solana").click();
    const section = page.getByTestId("clmm-positions-section");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section).toContainText(/SOL\s*\/\s*USDC/, { timeout: 20_000 });
  });

  test("Track a position: entering the band of a REAL on-chain position recovers it", async ({ page }) => {
    await connectSolanaAs(page, DEPLOYER_SOL);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
    // No tracked bands → the deployer's live position is invisible until recovered.
    await page.getByTestId("clmm-track-toggle").click();
    await page.getByTestId("clmm-track-lower").fill(priceOf(REAL.positionLower));
    await page.getByTestId("clmm-track-upper").fill(priceOf(REAL.positionUpper));
    await page.getByTestId("clmm-track-btn").click();
    // Verified against the chain → appears in "Your positions".
    await expect(page.getByTestId(`clmm-pos-${REAL.positionLower}-${REAL.positionUpper}`)).toBeVisible({ timeout: 20_000 });
  });

  test("Track a position: a band with no on-chain position is refused honestly", async ({ page }) => {
    await connectSolanaAs(page, DEPLOYER_SOL);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
    await page.getByTestId("clmm-track-toggle").click();
    await page.getByTestId("clmm-track-lower").fill(priceOf(REAL.positionLower - 128));
    await page.getByTestId("clmm-track-upper").fill(priceOf(REAL.positionUpper + 128));
    await page.getByTestId("clmm-track-btn").click();
    await expect(page.getByTestId("clmm-track-status")).toContainText(/no position/i, { timeout: 20_000 });
  });
});
