/**
 * swap.spec.ts — Swap screen.
 *
 * A real DEX signs only with the user's connected wallet. With NO wallet the
 * primary CTA reads "Connect wallet" and is disabled — there is no backend/demo
 * signer fallback anywhere. Quote rendering is wallet-independent (server read).
 * The wallet-connected block injects a mock MetaMask provider + mocks the Solana
 * RPC balance call so the swap CTA can enable without submitting a real tx.
 */
import { test, expect } from "@playwright/test";

// Minimal injected MetaMask provider (no real signing happens in these specs).
const ETH_SCRIPT = `
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x1111222233334444555566667777888899990000'];
      if (method === 'eth_chainId') return '0x30D2A';
      if (method === 'net_version') return '200010';
      if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') return '0x0';
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
`;

// Fulfil the client-side Solana getTokenAccountBalance read with a large balance
// so the connected lane is never "insufficient".
async function mockSolBalance(page: import("@playwright/test").Page) {
  await page.route(/api\.devnet\.solana\.com/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { context: { slot: 1 }, value: { amount: "100000000000000", decimals: 6, uiAmount: 100000000, uiAmountString: "100000000" } },
      }),
    }),
  );
}

test.describe("Swap screen — no wallet", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("swap-panel")).toBeVisible();
  });

  test("hero + cross-VM leg strip render", async ({ page }) => {
    await expect(page.locator("h1.swap-stage-title")).toContainText("Trade from");
    // LegStrip defaults to the EVM lane (3 legs) with no wallet.
    await expect(page.locator(".leg-strip .leg")).toHaveCount(3);
  });

  test("token rows (You pay / You receive) present", async ({ page }) => {
    await expect(page.getByTestId("input-label")).toHaveText("You pay");
    await expect(page.getByTestId("output-label")).toHaveText("You receive");
    await expect(page.getByTestId("swap-input")).toBeVisible();
    await expect(page.getByTestId("swap-output")).toBeVisible();
  });

  test("market selector is separate from the token chips; no in-card lane selector", async ({ page }) => {
    // The market (pair) selector is its own control and opens the pair list.
    await expect(page.getByTestId("market-select")).toBeVisible();
    await page.getByTestId("market-select").click();
    await expect(page.getByTestId("pair-modal")).toBeVisible();
    await page.getByTestId("pair-modal-close").click();
    await expect(page.getByTestId("pair-modal")).toBeHidden();

    // The pay / receive token chips are display-only — they no longer open the
    // pair modal (choosing the market and reading the token are distinct).
    await expect(page.getByTestId("token-in")).toBeVisible();
    await expect(page.getByTestId("token-out")).toBeVisible();

    // The swap uses the connected wallet like every other screen — there is NO
    // EVM/Solana lane selector inside the card (the header pills own connection).
    await expect(page.getByTestId("dual-lane-indicator")).toHaveCount(0);
    await expect(page.getByTestId("lane-evm")).toHaveCount(0);
    await expect(page.getByTestId("lane-solana")).toHaveCount(0);
  });

  test("fee-tier chips present (Auto + 0.05% / 0.30% / 1.00%)", async ({ page }) => {
    await expect(page.getByTestId("tier-auto")).toBeVisible();
    for (const t of ["0.05%", "0.30%", "1.00%"]) {
      await expect(page.getByTestId(`tier-option-${t}`)).toBeVisible();
    }
    // Auto is the default selection.
    await expect(page.getByTestId("tier-auto")).toHaveAttribute("aria-pressed", "true");
  });

  test("no wallet → CTA reads 'Connect wallet', disabled, and there is NO Demo mode", async ({ page }) => {
    const btn = page.getByTestId("swap-btn");
    await expect(btn).toHaveText("Connect wallet");
    await expect(btn).toBeDisabled();
    // No backend/demo signer surface anywhere.
    await expect(page.getByText("Demo mode", { exact: false })).toHaveCount(0);
    await expect(page.getByTestId("demo-banner")).toHaveCount(0);
  });

  test("typing an amount fetches a live quote but the CTA stays 'Connect wallet' (no wallet)", async ({ page }) => {
    await page.getByTestId("swap-input").fill("1");
    // Quote breakdown appears once /api/tiers responds — quoting needs no wallet.
    await expect(page.getByTestId("quote-breakdown")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("swap-output")).not.toHaveValue("");
    // …but you still cannot swap without a wallet.
    const btn = page.getByTestId("swap-btn");
    await expect(btn).toHaveText("Connect wallet");
    await expect(btn).toBeDisabled();
  });

  test("selecting a fixed tier updates the selection (Auto → 1.00%)", async ({ page }) => {
    await page.getByTestId("tier-option-1.00%").click();
    await expect(page.getByTestId("tier-option-1.00%")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("tier-auto")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("selected-tier")).toHaveText("1.00%");
  });
});

test.describe("Swap screen — wallet connected", () => {
  test.beforeEach(async ({ page }) => {
    await mockSolBalance(page);
    await page.addInitScript(ETH_SCRIPT);
    await page.goto("/");
    await expect(page.getByTestId("swap-panel")).toBeVisible();
    // Wallet auto-connects via the injected provider path; drive the header connect pill.
    await page.getByTestId("wallet-pill-evm").click();
  });

  test("CTA reads 'Enter an amount' with an empty input", async ({ page }) => {
    const btn = page.getByTestId("swap-btn");
    await expect(btn).toHaveText("Enter an amount");
    await expect(btn).toBeDisabled();
  });

  test("typing an amount fetches a live quote and enables the CTA", async ({ page }) => {
    await page.getByTestId("swap-input").fill("1");
    await expect(page.getByTestId("quote-breakdown")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("swap-output")).not.toHaveValue("");
    const btn = page.getByTestId("swap-btn");
    await expect(btn).toBeEnabled({ timeout: 15_000 });
    await expect(btn).toContainText("Swap");
  });

  test("selecting a fixed tier updates the selection (Auto → 1.00%)", async ({ page }) => {
    await page.getByTestId("tier-option-1.00%").click();
    await expect(page.getByTestId("tier-option-1.00%")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("tier-auto")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("selected-tier")).toHaveText("1.00%");
  });

  test("pair selector lists available pairs and re-points the swap", async ({ page }) => {
    // Default market is USDC/SOL; the token chips reflect it.
    await expect(page.getByTestId("token-in")).toContainText("USDC");
    await expect(page.getByTestId("token-out")).toContainText("SOL");

    // Open the market selector — a control distinct from the token chips.
    await page.getByTestId("market-select").click();
    const modal = page.getByTestId("pair-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("pair-option-USDC-SOL")).toBeVisible();
    await expect(page.getByTestId("pair-option-USDC-ETH")).toBeVisible();

    // Selecting the 2nd market re-points the swap.
    await page.getByTestId("pair-option-USDC-ETH").click();
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("token-out")).toContainText("ETH");

    // USDC/ETH has only the 0.30% tier → other tier chips are gone.
    await expect(page.getByTestId("tier-option-0.30%")).toBeVisible();
    await expect(page.getByTestId("tier-option-0.05%")).toHaveCount(0);
    await expect(page.getByTestId("tier-option-1.00%")).toHaveCount(0);
  });

  test("switching pair fetches a live quote for the new pair", async ({ page }) => {
    await page.getByTestId("market-select").click();
    await page.getByTestId("pair-option-USDC-ETH").click();
    await page.getByTestId("swap-input").fill("1");
    await expect(page.getByTestId("quote-breakdown")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("swap-output")).not.toHaveValue("");
  });

  test("review modal opens then cancels without submitting", async ({ page }) => {
    await page.getByTestId("swap-input").fill("1");
    await expect(page.getByTestId("swap-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("swap-btn").click();
    await expect(page.getByTestId("confirm-modal")).toBeVisible();
    await page.getByTestId("cancel-swap-btn").click();
    await expect(page.getByTestId("confirm-modal")).toBeHidden();
    // No transaction was submitted → no status note.
    await expect(page.getByTestId("swap-status")).toHaveCount(0);
  });
});
