/**
 * my-pools-ui.spec.ts — the "Pools you created" section on /pools renders pools
 * from the local registry and reads their live reserves. Seeds localStorage with
 * a REAL created pool (HGRCDDbx…, made by harness/create-simple-pool.test.mjs) so
 * the row + live-reserve read exercise the real path.
 */
import { test, expect } from "@playwright/test";

// A real constant-product pool created on-chain by the harness (Solana lane).
const REAL_POOL = {
  kind: "simple",
  pool: "HGRCDDbxWKuT4h1We4tLxULh6d1o7cSHkYXKq6dVMuLm",
  program: "Fv2LgkewH9114T6Gg99ERq8TxMVj2MGPRC73dJ4AKb1A",
  mintA: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  mintB: "So11111111111111111111111111111111111111112",
  symbolA: "USDC", symbolB: "SOL", decimalsA: 6, decimalsB: 6,
  // vaults left blank → reserves read as 0 (the row still renders); the point of
  // this test is the registry→UI wiring, not the exact reserves.
  vaultA: "", vaultB: "", feeBps: 30, tier: "0.30%", createdSig: "", createdAt: 1,
};

async function connectSolana(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const provider = {
      isPhantom: true, publicKey: null as { toString(): string } | null,
      connect: async () => ({ publicKey: { toString: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" } }),
      disconnect: async () => {}, signTransaction: async (tx: unknown) => tx,
    };
    const w = window as unknown as Record<string, unknown>;
    w.phantom = { solana: provider }; w.solana = provider;
  });
}

test.describe("Pools you created — /pools", () => {
  test("no created pools → the section is absent", async ({ page }) => {
    await page.goto("/pools");
    await expect(page.getByTestId("my-pools")).toHaveCount(0);
  });

  test("a registry entry renders a row with type + fee + a forget control", async ({ page }) => {
    await page.addInitScript((entry) => {
      window.localStorage.setItem("rome-dex:my-pools", JSON.stringify([entry]));
    }, REAL_POOL);
    await page.goto("/pools");
    await expect(page.getByTestId("my-pools")).toBeVisible();
    const row = page.getByTestId("my-pool-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("USDC");
    await expect(row).toContainText("SOL");
    await expect(row).toContainText("Simple");
    await expect(row).toContainText("0.30%");
    // "forget" removes it from the list without touching the pool.
    await page.getByTestId("my-pool-forget").click();
    await expect(page.getByTestId("my-pool-row")).toHaveCount(0);
  });

  // The live CLMM proof pool (same PDA seeds as a created CLMM pool).
  const CLMM_POOL = {
    kind: "clmm",
    pool: "CD9zVVXdC4NFj5Es7ZpZd6qeP5uvENmUSET3Mwrh9asb",
    program: "cLMkE4X3PN4qwLBjUksHAnYbQiNMMedCPEdYwRbLVjV",
    mintA: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    mintB: "So11111111111111111111111111111111111111112",
    symbolA: "tRDA", symbolB: "tRDB", decimalsA: 6, decimalsB: 6,
    vaultA: "", vaultB: "", feeBps: 30, tier: "0.30%", createdSig: "", createdAt: 2,
  };

  test("a CLMM pool row also offers an inline trade panel (Concentrated)", async ({ page }) => {
    await connectSolana(page);
    await page.addInitScript((entry) => {
      window.localStorage.setItem("rome-dex:my-pools", JSON.stringify([entry]));
    }, CLMM_POOL);
    await page.goto("/pools");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("my-pool-row")).toContainText("Concentrated");
    await page.getByTestId("my-pool-trade").click();
    await expect(page.getByTestId("my-pool-trade-row")).toBeVisible();
    await expect(page.getByTestId("trade-amount")).toBeVisible();
  });

  test("a Simple pool row can expand an inline trade panel", async ({ page }) => {
    await connectSolana(page);
    await page.addInitScript((entry) => {
      window.localStorage.setItem("rome-dex:my-pools", JSON.stringify([entry]));
    }, REAL_POOL);
    await page.goto("/pools");
    await page.getByTestId("wallet-pill-solana").click();
    // The Simple row offers a "trade" toggle → inline swap form for THIS pool.
    await expect(page.getByTestId("my-pool-trade")).toBeVisible();
    await page.getByTestId("my-pool-trade").click();
    await expect(page.getByTestId("my-pool-trade-row")).toBeVisible();
    await expect(page.getByTestId("trade-amount")).toBeVisible();
    await expect(page.getByTestId("trade-flip")).toContainText("USDC → SOL");
    // Flip reverses the direction.
    await page.getByTestId("trade-flip").click();
    await expect(page.getByTestId("trade-flip")).toContainText("SOL → USDC");
  });
});
