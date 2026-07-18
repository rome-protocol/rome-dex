// EVM wallet picker — operator bug: "with MetaMask AND Coinbase installed it
// opens Coinbase, no way to choose." With >1 injected EVM wallet the EVM lane
// must offer a choice (EIP-6963 discovery); with exactly one it connects
// directly. Providers are stubbed via addInitScript — the mock announces two
// EIP-6963 providers in response to eip6963:requestProvider (no real
// extensions in CI). Mirrors solwallet.spec.ts for the Solana lane.

import { test, expect, type Page } from "@playwright/test";

const MM_EOA = "0x1111222233334444555566667777888899990000";
const MM_SHORT = "0x1111…0000";
const CB_EOA = "0x2222333344445555666677778888999900001111";
const CB_SHORT = "0x2222…1111";

// Announce N EIP-6963 providers on request. `only` restricts to a single wallet.
async function stubEip6963(page: Page, only?: "metamask" | "coinbase") {
  await page.addInitScript(({ mm, cb, only }) => {
    const mk = (eoa: string) => ({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [eoa];
        if (method === "eth_chainId") return "0x30D4A"; // 200010
        if (method === "eth_maxPriorityFeePerGas" || method === "eth_gasPrice") return "0x0";
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        return null;
      },
      on: () => {},
      removeListener: () => {},
    });
    const wallets = [
      { rdns: "io.metamask", name: "MetaMask", provider: mk(mm) },
      { rdns: "com.coinbase.wallet", name: "Coinbase Wallet", provider: mk(cb) },
    ].filter((w) => (only === "metamask" ? w.rdns === "io.metamask" : only === "coinbase" ? w.rdns === "com.coinbase.wallet" : true));

    window.addEventListener("eip6963:requestProvider", () => {
      for (const w of wallets) {
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
          detail: { info: { uuid: w.rdns, name: w.name, icon: "data:image/svg+xml,<svg/>", rdns: w.rdns }, provider: w.provider },
        }));
      }
    });
    // Simulate the injection race: window.ethereum is Coinbase (the wrong one).
    (window as unknown as Record<string, unknown>).ethereum = wallets[wallets.length - 1].provider;
  }, { mm: MM_EOA, cb: CB_EOA, only: only ?? null });
}

test.describe("EVM wallet picker", () => {
  test("two wallets → picker offers both, no auto-connect, choosing MetaMask connects it", async ({ page }) => {
    await stubEip6963(page);
    await page.goto("/");

    const pill = page.getByTestId("wallet-pill-evm");
    await expect(pill).toContainText("Connect");
    await pill.click();

    const picker = page.getByTestId("evm-wallet-picker");
    await expect(picker).toBeVisible();
    await expect(page.getByTestId("evm-wallet-option-io.metamask")).toBeVisible();
    await expect(page.getByTestId("evm-wallet-option-com.coinbase.wallet")).toBeVisible();
    // No auto-connect while the picker is open.
    await expect(pill).toContainText("Connect");

    await page.getByTestId("evm-wallet-option-io.metamask").click();
    await expect(picker).toBeHidden();
    await expect(pill).toContainText(MM_SHORT); // the CHOSEN wallet, not Coinbase
  });

  test("single wallet → connects directly, no picker", async ({ page }) => {
    await stubEip6963(page, "coinbase");
    await page.goto("/");

    const pill = page.getByTestId("wallet-pill-evm");
    await pill.click();
    await expect(page.getByTestId("evm-wallet-picker")).toHaveCount(0);
    await expect(pill).toContainText(CB_SHORT);
  });
});
