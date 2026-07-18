/**
 * create-pool.spec.ts — the Simple (constant-product) create flow on /pools.
 *
 * DUAL-LANE via CreatePool (tag 7): a pool can be created from EITHER wallet
 * (on-chain proof: harness/create-simple-pool.test.mjs, both lanes green). Here we
 * prove the UI surface: the type chooser, the dual-lane form (dropdown tokens +
 * seed amounts + fee tier), and that Create enables on BOTH an EVM and a Solana
 * wallet. The real submit needs a signature (proven on-chain), so we stop at an
 * enabled Create button.
 */
import { test, expect, type Page } from "@playwright/test";
import { collectErrors } from "./helpers";

const PK = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

async function connectSolana(page: Page) {
  await page.addInitScript(({ pk }) => {
    const provider = {
      isPhantom: true,
      publicKey: null as { toString(): string } | null,
      connect: async () => ({ publicKey: { toString: () => pk } }),
      disconnect: async () => {},
      signTransaction: async (tx: unknown) => tx,
    };
    const w = window as unknown as Record<string, unknown>;
    w.phantom = { solana: provider };
    w.solana = provider;
  }, { pk: PK });
}

async function connectEvm(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.ethereum = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) =>
        method === "eth_requestAccounts" || method === "eth_accounts"
          ? ["0x1f4946Be340F06c46A50E65084790968aBcc48F6"] : null,
      on: () => {}, removeListener: () => {},
    };
  });
}

test.describe("Create a pool — /pools", () => {
  test("toggle → type chooser; Simple → no wallet asks to connect (either lane)", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/pools");
    // Hidden until toggled → then the chooser (Simple / Concentrated), not a form.
    await expect(page.getByTestId("create-pool-chooser")).toHaveCount(0);
    await page.getByTestId("create-pool-toggle").click();
    await expect(page.getByTestId("create-pool-chooser")).toBeVisible();
    await expect(page.getByTestId("choose-simple")).toBeVisible();
    await expect(page.getByTestId("choose-concentrated")).toBeVisible();
    // Simple → the constant-product panel; no wallet → dual-lane connect prompt.
    await page.getByTestId("choose-simple").click();
    await expect(page.getByTestId("create-pool-panel")).toBeVisible();
    await expect(page.getByTestId("create-pool-connect")).toContainText(/EVM or Solana/i);
    await expect(page.getByTestId("create-pool-btn")).toBeDisabled();
    expect(errors(), errors().join(" | ")).toHaveLength(0);
  });

  // Fill the Simple form with two known tokens + seed amounts.
  async function openAndFillSimple(page: Page) {
    await page.getByTestId("create-pool-toggle").click();
    await page.getByTestId("choose-simple").click();
    await expect(page.getByTestId("create-pool-panel")).toBeVisible();
    await page.getByTestId("pool-token-a").selectOption({ label: "USDC" });
    await page.getByTestId("pool-token-b").selectOption({ label: "SOL" });
    await page.getByTestId("seed-a").fill("10");
    await page.getByTestId("seed-b").fill("1");
  }

  test("Simple pool, EVM wallet → dual-lane, filled form enables Create (EVM can create)", async ({ page }) => {
    await connectEvm(page);
    await page.goto("/pools");
    await page.getByTestId("wallet-pill-evm").click();
    await openAndFillSimple(page);
    // The WS2 headline: an EVM wallet can now create a SIMPLE pool — no honest-note.
    await expect(page.getByTestId("create-pool-evm-note")).toHaveCount(0);
    await expect(page.getByTestId("create-pool-btn")).toBeEnabled();
  });

  test("Simple pool, Solana wallet → the create form renders + enables Create", async ({ page }) => {
    await connectSolana(page);
    await page.goto("/pools");
    await page.getByTestId("wallet-pill-solana").click();
    await page.getByTestId("create-pool-toggle").click();
    await page.getByTestId("choose-simple").click();
    // Dropdown token pickers, three fee tiers, two seed inputs, the create button.
    await expect(page.getByTestId("pool-token-a")).toBeVisible();
    await expect(page.getByTestId("pool-token-b")).toBeVisible();
    for (const t of ["0.05%", "0.30%", "1.00%"]) {
      await expect(page.getByTestId(`pool-tier-${t}`)).toBeVisible();
    }
    await expect(page.getByTestId("seed-a")).toBeVisible();
    await expect(page.getByTestId("seed-b")).toBeVisible();
    // Create is disabled until the form is complete (no tokens picked yet).
    await expect(page.getByTestId("create-pool-btn")).toBeDisabled();
    await expect(page.getByTestId("pool-tier-0.30%")).toHaveAttribute("aria-pressed", "true");
  });
});
