// Chain switcher e2e. Both cases mock /api/chains so the specs assert UI
// BEHAVIOR (hide at one chain, switch at two), not the repo's deployment
// config — chains.yaml now legitimately carries several chains (#62/#64), so
// an unmocked "single-chain" premise broke the moment a second chain landed.

import { test, expect } from "@playwright/test";

const HADRIAN_ONLY = [{
  chainId: "200010", name: "Hadrian", evmRpc: "https://e1/", solanaRpc: "https://s1/",
  solanaCluster: "devnet", explorerBase: "https://x1/tx", romeEvmProgramId: "R1",
  oracle: { feeds: {} }, dex: { dexProgram: "D1", router: "0x1", tiers: [] },
}];

test.describe("chain switcher", () => {
  test("single-chain: footer names the chain, switcher is hidden", async ({ page }) => {
    await page.route("**/api/chains", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HADRIAN_ONLY) }),
    );
    await page.goto("/");
    await expect(page.locator("footer")).toContainText("Hadrian");
    await expect(page.getByTestId("chain-switcher")).toHaveCount(0);
  });

  test("multi-chain: switcher appears and switching re-points the footer", async ({ page }) => {
    const TWO = [
      {
        chainId: "200010", name: "Hadrian", evmRpc: "https://e1/", solanaRpc: "https://s1/",
        solanaCluster: "devnet", explorerBase: "https://x1/tx", romeEvmProgramId: "R1",
        oracle: { feeds: {} }, dex: { dexProgram: "D1", router: "0x1", tiers: [] },
      },
      {
        chainId: "210000", name: "Nerva", evmRpc: "https://e2/", solanaRpc: "https://s2/",
        solanaCluster: "devnet", explorerBase: "https://x2/tx", romeEvmProgramId: "R2",
        oracle: { feeds: {} }, dex: { dexProgram: "D2", router: "0x2", tiers: [] },
      },
    ];
    await page.route("**/api/chains", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TWO) }),
    );

    await page.goto("/");
    const sw = page.getByTestId("chain-switcher");
    await expect(sw).toBeVisible();
    // Default selection = first chain (pickInitialChainId).
    await expect(page.locator("footer")).toContainText("Hadrian");

    await sw.selectOption("210000");
    await expect(page.locator("footer")).toContainText("Nerva");
    // Selection persists across reload (localStorage-backed store).
    await page.reload();
    await expect(page.locator("footer")).toContainText("Nerva");
  });

  test("clmm provenance line follows the active chain", async ({ page }) => {
    // A minimal CLMM block so /clmm renders its full surface (a clmm-less chain
    // short-circuits to "CLMM is not available"); reads against the fake RPC
    // fail soft (price shows "unavailable"), which is fine — we assert copy.
    const CLMM = {
      program: "cLMkE4X3PN4qwLBjUksHAnYbQiNMMedCPEdYwRbLVjV",
      router: "0x654E2aD87df91ea61e3EAB054e56460A176A7eB5",
      pools: [{
        pool: "CD9zVVXdC4NFj5Es7ZpZd6qeP5uvENmUSET3Mwrh9asb",
        mint0: "He7ombertkWGBabm1va3z6mVf2Spy7mcLUGRJEQxZvS",
        mint1: "5zXcakQojdb9PxMumkaRwFYm1UFJfPCuDzAmP3DHNhUY",
        vault0: "6pEYCQc4E1PjAHNYLkirKipYqrdmprNSSEPhPPF45tJS",
        vault1: "FPjPzGvsNrthaMoKid5jFhGzvQigAGKjB1bA81AX146j",
        feePips: 3000, tickSpacing: 64, symbol0: "tRDA", symbol1: "tRDB",
        decimals0: 6, decimals1: 6,
        tickArrays: { "0": "FH5rAgNews7pSLZ6rboLDmdqhSrwPnUW9ZzM7gpPpSLf" },
      }],
    };
    const TWO = [
      {
        chainId: "200010", name: "Hadrian", evmRpc: "https://e1/", solanaRpc: "https://s1/",
        solanaCluster: "devnet", explorerBase: "https://x1/tx", romeEvmProgramId: "R1",
        oracle: { feeds: {} }, dex: { dexProgram: "D1", router: "0x1", tiers: [] }, clmm: CLMM,
      },
      {
        chainId: "210000", name: "Nerva", evmRpc: "https://e2/", solanaRpc: "https://s2/",
        solanaCluster: "devnet", explorerBase: "https://x2/tx", romeEvmProgramId: "R2",
        oracle: { feeds: {} }, dex: { dexProgram: "D2", router: "0x2", tiers: [] }, clmm: CLMM,
      },
    ];
    await page.route("**/api/chains", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TWO) }),
    );

    await page.goto("/clmm");
    await page.getByTestId("chain-switcher").selectOption("210000");
    await expect(page.locator("main")).toContainText("Live on Nerva");
    await expect(page.locator("main")).not.toContainText("Live on Hadrian");
  });
});
