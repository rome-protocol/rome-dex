/**
 * wallet.spec.ts — dual-wallet connect / disconnect via the TopNav pills.
 *
 * Injects minimal window.ethereum (MetaMask) and window.solana (Phantom) before
 * the app loads, then drives connect/disconnect through the UI. No real on-chain
 * tx is submitted, so this stays in the default (non-@onchain) gate.
 */
import { test, expect } from "@playwright/test";

const MOCK_EOA = "0x1111222233334444555566667777888899990000";
const MOCK_EOA_SHORT = "0x1111…0000";
const MOCK_PHANTOM = "9nMkHfQ3Zq3nJvN2rGpWm4tYxD9sVqZbRcAeFuHnPkLm";
const MOCK_PHANTOM_SHORT = "9nMkHf…PkLm";

const ETH_SCRIPT = `
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${MOCK_EOA}'];
      if (method === 'eth_chainId') return '0x30D4A';
      if (method === 'net_version') return '200010';
      if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') return '0x0';
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
`;

const SOL_SCRIPT = `
  window.solana = {
    isPhantom: true,
    connect: async () => ({ publicKey: { toString: () => '${MOCK_PHANTOM}' } }),
    disconnect: async () => {},
  };
`;

test.describe("Wallet connect / disconnect", () => {
  test("EVM pill connects and disconnects", async ({ page }) => {
    await page.addInitScript(ETH_SCRIPT);
    await page.goto("/");

    const pill = page.getByTestId("wallet-pill-evm");
    await expect(pill).toContainText("Connect");

    await pill.click();
    await expect(pill).toContainText(MOCK_EOA_SHORT);
    // A visible disconnect cue appears on the connected pill.
    await expect(pill).toContainText("✕");
    // Connecting enables the swap CTA (no longer "Connect wallet").
    await expect(page.getByTestId("swap-btn")).toHaveText("Enter an amount");

    await pill.click();
    await expect(pill).toContainText("Connect");
    // Disconnecting returns the CTA to the wallet-gated state.
    await expect(page.getByTestId("swap-btn")).toHaveText("Connect wallet");
  });

  test("Solana pill connects and disconnects", async ({ page }) => {
    await page.addInitScript(SOL_SCRIPT);
    await page.goto("/");

    const pill = page.getByTestId("wallet-pill-solana");
    await expect(pill).toContainText("Connect");

    await pill.click();
    await expect(pill).toContainText(MOCK_PHANTOM_SHORT);
    await expect(page.getByTestId("swap-btn")).toHaveText("Enter an amount");

    await pill.click();
    await expect(pill).toContainText("Connect");
    await expect(page.getByTestId("swap-btn")).toHaveText("Connect wallet");
  });
});

// ── Session persistence (live-user report 2026-07-11) ────────────────────────
// A refresh dropped both connections — the wallet keeps the site authorized,
// but the app never asked. On load it now restores silently: eth_accounts
// (EVM, no popup) / connect({ onlyIfTrusted: true }) (Solana). A wallet whose
// authorization was revoked stays disconnected, with no error banner.
const MOCK_EOA_2 = "0x1111222233334444555566667777888899990000";
const REVOKED_ETH_SCRIPT = `
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts') return ['${MOCK_EOA_2}'];
      if (method === 'eth_accounts') return []; // site authorization revoked
      if (method === 'eth_chainId') return '0x30D4A';
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
`;
const TRUSTED_SOL_SCRIPT = `
  window.solana = {
    isPhantom: true,
    connect: async (opts) => ({ publicKey: { toString: () => '9nMkHfQ3Zq3nJvN2rGpWm4tYxD9sVqZbRcAeFuHnPkLm' } }),
    disconnect: async () => {},
  };
`;
const UNTRUSTED_SOL_SCRIPT = `
  window.solana = {
    isPhantom: true,
    connect: async (opts) => {
      if (opts && opts.onlyIfTrusted) { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
      return { publicKey: { toString: () => '9nMkHfQ3Zq3nJvN2rGpWm4tYxD9sVqZbRcAeFuHnPkLm' } };
    },
    disconnect: async () => {},
  };
`;

test.describe("Wallet session persistence", () => {
  test("EVM connection survives a page refresh (silent eth_accounts restore)", async ({ page }) => {
    await page.addInitScript(ETH_SCRIPT);
    await page.goto("/");
    const pill = page.getByTestId("wallet-pill-evm");
    await pill.getByText("Connect").click();
    await expect(pill).toContainText(MOCK_EOA_SHORT);
    await page.reload();
    await expect(pill).toContainText(MOCK_EOA_SHORT, { timeout: 10_000 });
  });

  test("Solana connection survives a page refresh (onlyIfTrusted restore)", async ({ page }) => {
    await page.addInitScript(TRUSTED_SOL_SCRIPT);
    await page.goto("/");
    const pill = page.getByTestId("wallet-pill-solana");
    await pill.getByText("Connect").click();
    await expect(pill).toContainText(MOCK_PHANTOM_SHORT);
    await page.reload();
    await expect(pill).toContainText(MOCK_PHANTOM_SHORT, { timeout: 10_000 });
  });

  test("revoked EVM authorization → stays disconnected after refresh, no error banner", async ({ page }) => {
    await page.addInitScript(REVOKED_ETH_SCRIPT);
    await page.addInitScript(() => {
      localStorage.setItem("rome-dex:wallets", JSON.stringify({ evm: "injected" }));
    });
    await page.goto("/");
    const pill = page.getByTestId("wallet-pill-evm");
    await expect(pill).toContainText("Connect", { timeout: 10_000 });
    await expect(page.locator("text=No EVM wallet detected")).toHaveCount(0);
  });

  test("untrusted Solana wallet → silent restore declined, stays disconnected", async ({ page }) => {
    await page.addInitScript(UNTRUSTED_SOL_SCRIPT);
    await page.addInitScript(() => {
      localStorage.setItem("rome-dex:wallets", JSON.stringify({ solana: "phantom" }));
    });
    await page.goto("/");
    const pill = page.getByTestId("wallet-pill-solana");
    await expect(pill).toContainText("Connect", { timeout: 10_000 });
  });

  test("explicit disconnect is remembered — no auto-reconnect after refresh", async ({ page }) => {
    await page.addInitScript(ETH_SCRIPT);
    await page.goto("/");
    const pill = page.getByTestId("wallet-pill-evm");
    await pill.getByText("Connect").click();
    await expect(pill).toContainText(MOCK_EOA_SHORT);
    await pill.getByText("✕").click();
    await expect(pill).toContainText("Connect");
    await page.reload();
    // eth_accounts would still return the account (site stays authorized in the
    // wallet) — the app must honor the user's explicit disconnect instead.
    await page.waitForTimeout(1500);
    await expect(pill).toContainText("Connect");
  });
});
