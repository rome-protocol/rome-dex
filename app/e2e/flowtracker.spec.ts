/**
 * flowtracker.spec.ts — the swap-journey strip as a truthful look-ahead + live
 * tracker (left column of the Swap screen).
 *
 * The strip must show the user what WILL happen for THEIR wallet state before
 * they trade (including the one-time approval prompt a fresh EVM wallet gets),
 * track each step as it actually happens during execution, and land the
 * transaction hash in the strip on success. No dev telemetry anywhere.
 *
 * Wallet + chain are fully mocked: the injected EVM provider auto-approves and
 * returns a fixed tx hash; the Solana RPC intercept answers getAccountInfo
 * with "no account" (fresh wallet → approval genuinely needed) and token
 * balances with a large amount. Quotes stay live via same-origin /api.
 */
import { test, expect } from "@playwright/test";

const MOCK_HASH = "0x" + "ab".repeat(32);

// Injected MetaMask-shaped provider that signs nothing but walks the whole
// happy path: sendTransaction resolves MOCK_HASH and the receipt confirms it.
const ETH_FULL_SCRIPT = `
  (() => {
    const HASH = '${MOCK_HASH}';
    const receipt = {
      status: '0x1', transactionHash: HASH, transactionIndex: '0x0',
      blockNumber: '0x10', blockHash: '0x' + '22'.repeat(32),
      from: '0x1111222233334444555566667777888899990000', to: '0x' + '33'.repeat(20),
      cumulativeGasUsed: '0x5208', gasUsed: '0x5208', logs: [], logsBloom: '0x' + '00'.repeat(256),
      type: '0x2', effectiveGasPrice: '0x0', contractAddress: null,
    };
    window.__sentTxs = [];
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x1111222233334444555566667777888899990000'];
        if (method === 'eth_chainId') return '0x30D4A';
        if (method === 'net_version') return '200010';
        if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') return '0x0';
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_estimateGas') return '0x5208';
        if (method === 'eth_getTransactionCount') return '0x0';
        if (method === 'eth_sendTransaction') { window.__sentTxs.push(params[0]); return HASH; }
        if (method === 'eth_getTransactionByHash') return {
          hash: HASH, blockNumber: '0x10', blockHash: receipt.blockHash, transactionIndex: '0x0',
          from: receipt.from, to: receipt.to, nonce: '0x0', value: '0x0', gas: '0x5208', input: '0x',
          type: '0x2', chainId: '0x30D4A', gasPrice: '0x0', maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0',
          accessList: [], v: '0x1', r: '0x' + '11'.repeat(32), s: '0x' + '12'.repeat(32),
        };
        if (method === 'eth_getTransactionReceipt') return receipt;
        return null;
      },
      on: () => {},
      removeListener: () => {},
    };
  })();
`;

// Method-aware Solana RPC mock: fresh wallet (no token accounts exist) with a
// healthy balance read wherever a balance is asked for.
async function mockFreshSolana(page: import("@playwright/test").Page) {
  await page.route(/api\.devnet\.solana\.com/, (route) => {
    const bodyText = route.request().postData() ?? "{}";
    const parsed = JSON.parse(bodyText);
    const reqs = Array.isArray(parsed) ? parsed : [parsed];
    const answer = (r: { id: number; method: string }) => {
      if (r.method === "getTokenAccountBalance")
        return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: { amount: "100000000000000", decimals: 6, uiAmount: 100000000, uiAmountString: "100000000" } } };
      if (r.method === "getAccountInfo")
        return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: null } };
      if (r.method === "getLatestBlockhash")
        return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: { blockhash: "9bZkc5Cs1jGgW2KWjuDkC2gDDF3bBv9pJt3pmqjYSMAD", lastValidBlockHeight: 1000 } } };
      return { jsonrpc: "2.0", id: r.id, result: null };
    };
    const out = reqs.map(answer);
    route.fulfill({ contentType: "application/json", body: JSON.stringify(Array.isArray(parsed) ? out : out[0]) });
  });
}

test.describe("Swap journey strip — look-ahead (no wallet)", () => {
  test("shows a generic 3-step journey and no live states", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("swap-panel")).toBeVisible();
    // The generic journey renders as plan steps (no wallet → no personalization).
    await expect(page.locator(".leg-strip .leg")).toHaveCount(3);
    await expect(page.getByTestId("flow-tx-link")).toHaveCount(0);
  });
});

test.describe("Swap journey strip — truthful look-ahead (fresh EVM wallet)", () => {
  // Each test navigates itself: init scripts must ALL be registered before the
  // page loads (the rejection test layers an extra one on top).
  const arrive = async (page: import("@playwright/test").Page) => {
    await page.goto("/");
    await page.getByTestId("wallet-pill-evm").click();
  };
  test.beforeEach(async ({ page }) => {
    await mockFreshSolana(page);
    await page.addInitScript(ETH_FULL_SCRIPT);
  });

  test("with an amount, the plan includes the one-time approval step (fresh wallet truly needs it)", async ({ page }) => {
    await arrive(page);
    await page.getByTestId("swap-input").fill("1");
    await expect(page.getByTestId("quote-breakdown")).toBeVisible({ timeout: 15_000 });
    // Preflight reads the real (mocked) chain: no delegate → approval WILL happen.
    await expect(page.getByTestId("flow-step-approve")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("flow-step-approve")).toContainText(/one-?time/i);
    // The swap-confirmation and receive steps are always in the plan.
    await expect(page.getByTestId("flow-step-confirm")).toBeVisible();
    await expect(page.getByTestId("flow-step-receive")).toBeVisible();
  });

  test("driving the swap tracks steps live and lands the tx hash in the strip", async ({ page }) => {
    await arrive(page);
    await page.getByTestId("swap-input").fill("1");
    await expect(page.getByTestId("swap-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("swap-btn").click();
    await expect(page.getByTestId("confirm-modal")).toBeVisible();
    await page.getByTestId("confirm-swap-btn").click();

    // Success: every plan step settles to done and the strip carries the hash.
    await expect(page.getByTestId("flow-done")).toBeVisible({ timeout: 30_000 });
    const link = page.getByTestId("flow-tx-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", new RegExp(MOCK_HASH.slice(2, 18)));
    // No step left in a non-terminal state.
    await expect(page.locator('[data-flow-state="active"]')).toHaveCount(0);
    await expect(page.locator('[data-flow-state="todo"]')).toHaveCount(0);
  });

  test("a rejected wallet prompt marks the flow failed and says nothing moved", async ({ page }) => {
    // Every sendTransaction rejects like a user pressing Cancel. Registered
    // BEFORE navigation so it wraps the base mock.
    await page.addInitScript(`
      (() => {
        const orig = window.ethereum.request;
        window.ethereum.request = async (args) => {
          if (args.method === 'eth_sendTransaction') { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
          return orig(args);
        };
      })();
    `);
    await arrive(page);
    await page.getByTestId("swap-input").fill("1");
    await expect(page.getByTestId("swap-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("swap-btn").click();
    await page.getByTestId("confirm-swap-btn").click();

    await expect(page.getByTestId("flow-failed")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".leg-strip.card")).toContainText(/nothing moved/i);
    await expect(page.getByTestId("flow-tx-link")).toHaveCount(0);
  });
});
