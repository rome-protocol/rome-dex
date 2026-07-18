/**
 * farms.spec.ts — Farms (liquidity-mining) screen, no wallet.
 *
 * Renders without error, surfaces the farm card for the USDC/SOL 0.30% LP mint,
 * and — with no wallet connected — shows the "Connect wallet" CTA plus a stake
 * input. No backend signer is involved; every action goes through the user's
 * wallet only.
 */
import { test, expect } from "@playwright/test";
import { collectErrors } from "./helpers";

test.describe("Farms screen", () => {
  test("renders heading + farm card with stats, no errors", async ({ page }) => {
    const getErrors = collectErrors(page);
    await page.goto("/farms");
    await expect(page.getByRole("heading", { name: "Farms" })).toBeVisible();

    // At least one farm card renders (the seeded USDC/SOL 0.30% farm).
    await expect(page.getByTestId("farm-card").first()).toBeVisible();

    // The farm's stats live inside the card (emission / APR / total staked / position)
    // — the redesign keeps this information, it does not cut it.
    const card = page.getByTestId("farm-card").first();
    await expect(page.locator(".farm-metrics").first()).toBeVisible();
    await expect(card).toContainText("Reward APR");
    await expect(card).toContainText("Total staked");
    await expect(card).toContainText("Emission");
    await expect(card).toContainText("Your staked");

    expect(getErrors(), `Console/JS errors: ${getErrors().join(" | ")}`).toHaveLength(0);
  });

  test("no wallet → Connect-wallet CTA + stake input present", async ({ page }) => {
    await page.goto("/farms");
    const card = page.getByTestId("farm-card").first();
    await expect(card).toBeVisible();

    // The pair the farm rewards.
    await expect(card).toContainText("USDC / SOL");
    await expect(card).toContainText("0.30%");

    // Stake amount input is present even without a wallet.
    await expect(card.getByTestId("farm-stake-input")).toBeVisible();

    // With no wallet, the primary action reads "Connect wallet" and is disabled.
    const cta = card.getByTestId("farm-stake-btn");
    await expect(cta).toHaveText(/connect wallet/i);
    await expect(cta).toBeDisabled();
  });
});

// ── Balance-aware staking (live-user report 2026-07-09) ──────────────────────
// Staking with zero LP produced raw on-chain errors on both lanes (the stake
// button never read the wallet's real LP balance). The button now gates on it
// and says what to do instead of letting the chain reject.
async function connectSolanaAs(page: import("@playwright/test").Page, pk: string) {
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

function mockLpBalance(page: import("@playwright/test").Page, amountRaw: string | null) {
  return page.route((url) => url.hostname.includes("api.devnet.solana.com"), async (route) => {
    const body = route.request().postDataJSON() as { method?: string; id?: number } | null;
    if (body?.method === "getTokenAccountBalance") {
      const value = amountRaw == null
        ? null // ATA doesn't exist — the RPC returns an error result
        : { amount: amountRaw, decimals: 6, uiAmount: Number(amountRaw) / 1e6, uiAmountString: String(Number(amountRaw) / 1e6) };
      return route.fulfill({ json: amountRaw == null
        ? { jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32602, message: "could not find account" } }
        : { jsonrpc: "2.0", id: body.id ?? 1, result: { context: { slot: 1 }, value } } });
    }
    return route.fallback();
  });
}

test.describe("Farms — balance-aware staking", () => {
  const PK = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  test("zero LP → Stake gated with add-liquidity guidance, nothing submitted", async ({ page }) => {
    await connectSolanaAs(page, PK);
    await mockLpBalance(page, null); // no LP ATA at all — a returning LP's exact state
    await page.goto("/farms");
    await page.getByTestId("wallet-pill-solana").click();
    const card = page.getByTestId("farm-card").first();
    await card.getByTestId("farm-stake-input").fill("1");
    await expect(card.getByTestId("farm-stake-btn")).toBeDisabled();
    await expect(card.getByTestId("farm-lp-note")).toContainText(/add liquidity/i, { timeout: 15_000 });
  });

  test("holding LP → available balance shown; over-balance gated; within-balance enabled", async ({ page }) => {
    await connectSolanaAs(page, PK);
    await mockLpBalance(page, "5000000"); // 5 LP
    await page.goto("/farms");
    await page.getByTestId("wallet-pill-solana").click();
    const card = page.getByTestId("farm-card").first();
    await expect(card.getByTestId("farm-lp-available")).toContainText("5", { timeout: 15_000 });
    await card.getByTestId("farm-stake-input").fill("10");
    await expect(card.getByTestId("farm-stake-btn")).toBeDisabled();
    await expect(card.getByTestId("farm-stake-btn")).toContainText(/not enough lp/i);
    await card.getByTestId("farm-stake-input").fill("1");
    await expect(card.getByTestId("farm-stake-btn")).toBeEnabled();
  });
});
