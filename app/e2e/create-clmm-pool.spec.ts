/**
 * create-clmm-pool.spec.ts — the Concentrated (CLMM) create flow on /pools.
 *
 * DUAL-LANE: the headline outcome — a pool can be created from EITHER wallet
 * (the on-chain proof is harness/clmm-create-pool.test.mjs, both lanes green).
 * Here we prove the UI surface: chooser → concentrated form, the dropdown token
 * pickers + initial-price + range + fee tier, and that the Create button enables
 * on BOTH an EVM and a Solana wallet once the form is complete. The real submit
 * needs a signature (proven on-chain), so we stop at an enabled Create button.
 */
import { test, expect, type Page } from "@playwright/test";
import { collectErrors } from "./helpers";

const SOL_PK = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

async function connectSolana(page: Page) {
  await page.addInitScript(({ pk }) => {
    const provider = {
      isPhantom: true, publicKey: null as { toString(): string } | null,
      connect: async () => ({ publicKey: { toString: () => pk } }),
      disconnect: async () => {}, signTransaction: async (tx: unknown) => tx,
    };
    const w = window as unknown as Record<string, unknown>;
    w.phantom = { solana: provider }; w.solana = provider;
  }, { pk: SOL_PK });
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

// Open the concentrated form and fill it with two known tokens + a price.
async function openAndFill(page: Page) {
  await page.getByTestId("create-pool-toggle").click();
  await page.getByTestId("choose-concentrated").click();
  await expect(page.getByTestId("create-clmm-panel")).toBeVisible();
  await page.getByTestId("clmm-token-a").selectOption({ label: "USDC" });
  await page.getByTestId("clmm-token-b").selectOption({ label: "SOL" });
  await page.getByTestId("clmm-price").fill("100");
}

test.describe("Create a Concentrated pool — /pools (dual-lane)", () => {
  test("chooser → concentrated form renders; no wallet asks to connect (either lane)", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/pools");
    await page.getByTestId("create-pool-toggle").click();
    await page.getByTestId("choose-concentrated").click();
    await expect(page.getByTestId("create-clmm-panel")).toBeVisible();
    // The form fields the operator asked for: dropdown tokens, price, range, tiers.
    await expect(page.getByTestId("clmm-token-a")).toBeVisible();
    await expect(page.getByTestId("clmm-token-b")).toBeVisible();
    await expect(page.getByTestId("clmm-price")).toBeVisible();
    await expect(page.getByTestId("clmm-range-full")).toBeVisible();
    await expect(page.getByTestId("clmm-range-custom")).toBeVisible();
    for (const t of ["0.05%", "0.30%", "1.00%"]) await expect(page.getByTestId(`clmm-tier-${t}`)).toBeVisible();
    // Dual-lane connect message (not Solana-only).
    await expect(page.getByTestId("create-clmm-connect")).toContainText(/EVM or Solana/i);
    // Back returns to the chooser.
    await page.getByTestId("clmm-create-back").click();
    await expect(page.getByTestId("create-pool-chooser")).toBeVisible();
    expect(errors(), errors().join(" | ")).toHaveLength(0);
  });

  test("Solana wallet → filled form enables Create", async ({ page }) => {
    await connectSolana(page);
    await page.goto("/pools");
    await page.getByTestId("wallet-pill-solana").click();
    await openAndFill(page);
    await expect(page.getByTestId("create-clmm-btn")).toBeEnabled();
  });

  test("EVM wallet → filled form enables Create (EVM pool creation, the headline)", async ({ page }) => {
    await connectEvm(page);
    await page.goto("/pools");
    await page.getByTestId("wallet-pill-evm").click();
    await openAndFill(page);
    // The whole point: an EVM wallet can create a Concentrated pool — no honest-note.
    await expect(page.getByTestId("create-clmm-connect")).toHaveCount(0);
    await expect(page.getByTestId("create-clmm-btn")).toBeEnabled();
  });
});
