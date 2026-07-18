// Solana wallet picker — operator bug: "no way to connect via solflare, it
// automatically connects with phantom." With more than one Solana wallet
// extension installed, connecting the SOL lane must offer a choice; with
// exactly one, it connects directly. Providers are stubbed via addInitScript
// (no real extensions in CI).

import { test, expect, type Page } from "@playwright/test";

const PHANTOM_PK = "9wJGNGWdFaotGrqBEuAkujhnRi94vyadDS4vz8YeiAds";
const SOLFLARE_PK = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

async function stubPhantom(page: Page) {
  await page.addInitScript(({ pk }) => {
    const provider = {
      isPhantom: true,
      publicKey: null as { toString(): string } | null,
      connect: async () => {
        (window as unknown as Record<string, unknown>).__phantomConnected = true;
        return { publicKey: { toString: () => pk } };
      },
      disconnect: async () => {},
      signTransaction: async (tx: unknown) => tx,
    };
    const w = window as unknown as Record<string, unknown>;
    w.phantom = { solana: provider };
    w.solana = provider;
  }, { pk: PHANTOM_PK });
}

async function stubSolflare(page: Page) {
  await page.addInitScript(({ pk }) => {
    const w = window as unknown as Record<string, unknown>;
    // Solflare's API: connect() resolves boolean; publicKey lives on the provider.
    w.solflare = {
      isSolflare: true,
      publicKey: { toString: () => pk },
      connect: async () => {
        w.__solflareConnected = true;
        return true;
      },
      disconnect: async () => {},
      signTransaction: async (tx: unknown) => tx,
    };
  }, { pk: SOLFLARE_PK });
}

test.describe("Solana wallet picker", () => {
  test("two wallets detected → picker offers both, no auto-connect", async ({ page }) => {
    await stubPhantom(page);
    await stubSolflare(page);
    await page.goto("/");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("sol-wallet-picker")).toBeVisible();
    await expect(page.getByTestId("sol-wallet-option-phantom")).toBeVisible();
    await expect(page.getByTestId("sol-wallet-option-solflare")).toBeVisible();
    const connected = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { ph: Boolean(w.__phantomConnected), sf: Boolean(w.__solflareConnected) };
    });
    expect(connected).toEqual({ ph: false, sf: false });
  });

  test("choosing Solflare connects via the Solflare provider", async ({ page }) => {
    await stubPhantom(page);
    await stubSolflare(page);
    await page.goto("/");
    await page.getByTestId("wallet-pill-solana").click();
    await page.getByTestId("sol-wallet-option-solflare").click();
    await expect(page.getByTestId("wallet-pill-solana")).toContainText(SOLFLARE_PK.slice(0, 4));
    const connected = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { ph: Boolean(w.__phantomConnected), sf: Boolean(w.__solflareConnected) };
    });
    expect(connected).toEqual({ ph: false, sf: true });
  });

  test("single wallet detected → connects directly, no picker", async ({ page }) => {
    await stubPhantom(page);
    await page.goto("/");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("wallet-pill-solana")).toContainText(PHANTOM_PK.slice(0, 4));
    await expect(page.getByTestId("sol-wallet-picker")).toHaveCount(0);
  });
});
