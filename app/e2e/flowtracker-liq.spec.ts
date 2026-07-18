/**
 * flowtracker-liq.spec.ts — the truthful look-ahead + live tracker extended to
 * the two self-contained panels: LIQUIDITY (add / remove, pool detail) and
 * ORDERS (limit / DCA, swap surface). Mirrors flowtracker.spec (the swap hero):
 *
 *   • LOOK-AHEAD is truthful — a prep prompt (a one-time approval on the EVM
 *     lane; the account setup an EVM order needs) shows ONLY when a real chain
 *     read says it will happen. The Solana lane, which reads nothing extra, is
 *     one signature with no prep step.
 *   • Driving the flow advances the steps from the ACTUAL execution callbacks
 *     and lands the transaction hash in the strip on success.
 *   • A rejected wallet prompt marks the flow stopped and says nothing moved.
 *
 * Wallet + chain are fully mocked (same recipe as flowtracker.spec / solwallet):
 * the injected EVM provider walks the happy path (or rejects); the Solana RPC
 * intercept answers "no account" (fresh wallet → approval genuinely needed) and
 * a warm gas balance. Pool reserves + quotes stay live via same-origin /api.
 */
import { test, expect, type Page } from "@playwright/test";

const MOCK_HASH = "0x" + "cd".repeat(32);
const MOCK_EOA = "0x1111222233334444555566667777888899990000";
const PHANTOM_PK = "9wJGNGWdFaotGrqBEuAkujhnRi94vyadDS4vz8YeiAds";

// Injected EVM provider that signs nothing but walks the whole happy path:
// every eth_sendTransaction resolves MOCK_HASH and the receipt confirms it.
const ETH_FULL_SCRIPT = `
  (() => {
    const HASH = '${MOCK_HASH}';
    const receipt = {
      status: '0x1', transactionHash: HASH, transactionIndex: '0x0',
      blockNumber: '0x10', blockHash: '0x' + '22'.repeat(32),
      from: '${MOCK_EOA}', to: '0x' + '33'.repeat(20),
      cumulativeGasUsed: '0x5208', gasUsed: '0x5208', logs: [], logsBloom: '0x' + '00'.repeat(256),
      type: '0x2', effectiveGasPrice: '0x0', contractAddress: null,
    };
    window.__sentTxs = [];
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${MOCK_EOA}'];
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

// Layered on top of the full script (before navigation): every send rejects,
// like a user pressing Cancel on the first prompt.
const ETH_REJECT_SCRIPT = `
  (() => {
    const orig = window.ethereum.request;
    window.ethereum.request = async (args) => {
      if (args.method === 'eth_sendTransaction') { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
      return orig(args);
    };
  })();
`;

// A single detected Solana wallet → connecting the SOL pill connects directly.
async function stubPhantom(page: Page) {
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
  }, { pk: PHANTOM_PK });
}

// Method-aware Solana RPC mock: fresh wallet (no token/order accounts exist),
// a healthy token balance, and a warm gas balance (so an EVM order is 2 prompts,
// not 3). Covers every read the look-ahead + placement make.
async function mockSolana(page: Page) {
  await page.route(/api\.devnet\.solana\.com/, (route) => {
    const bodyText = route.request().postData() ?? "{}";
    const parsed = JSON.parse(bodyText);
    const reqs = Array.isArray(parsed) ? parsed : [parsed];
    const answer = (r: { id: number; method: string }) => {
      switch (r.method) {
        case "getTokenAccountBalance":
          return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: { amount: "100000000000000", decimals: 6, uiAmount: 100000000, uiAmountString: "100000000" } } };
        case "getAccountInfo":
          return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: null } };
        case "getMultipleAccounts":
          return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: [null, null, null] } };
        case "getBalance":
          return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: 10_000_000 } };
        case "getLatestBlockhash":
          return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: { blockhash: "9bZkc5Cs1jGgW2KWjuDkC2gDDF3bBv9pJt3pmqjYSMAD", lastValidBlockHeight: 1000 } } };
        case "sendTransaction":
          return { jsonrpc: "2.0", id: r.id, result: "5j7s1Qb1x9rC6h2u3v4w5x6y7z8A9B1C2D3E4F5G6H7J8K9L1M2N3P4Q5R6S7T8U9V" };
        case "getSignatureStatuses":
          return { jsonrpc: "2.0", id: r.id, result: { context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }] } };
        case "getBlockHeight":
          return { jsonrpc: "2.0", id: r.id, result: 1 };
        default:
          return { jsonrpc: "2.0", id: r.id, result: null };
      }
    };
    const out = reqs.map(answer);
    route.fulfill({ contentType: "application/json", body: JSON.stringify(Array.isArray(parsed) ? out : out[0]) });
  });
}

// ── LIQUIDITY (pool detail) ──────────────────────────────────────────────────

test.describe("Liquidity flow strip — add", () => {
  test.beforeEach(async ({ page }) => {
    await mockSolana(page);
  });

  test("EVM look-ahead: the plan includes the one-time approval (a fresh wallet truly needs it)", async ({ page }) => {
    await page.addInitScript(ETH_FULL_SCRIPT);
    await page.goto("/pools/30");
    await expect(page.getByTestId("liquidity-panel")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("wallet-pill-evm").click();
    await page.getByTestId("liq-add-input").fill("1");

    const approve = page.getByTestId("liqflow-step-approve");
    await expect(approve).toBeVisible({ timeout: 15_000 });
    await expect(approve).toContainText(/one-?time/i);
    await expect(page.getByTestId("liqflow-step-confirm")).toBeVisible();
    await expect(page.getByTestId("liqflow-step-receive")).toBeVisible();
  });

  test("driving the EVM add tracks steps live and lands the tx hash in the strip", async ({ page }) => {
    await page.addInitScript(ETH_FULL_SCRIPT);
    await page.goto("/pools/30");
    await expect(page.getByTestId("liquidity-panel")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("wallet-pill-evm").click();
    await page.getByTestId("liq-add-input").fill("1");
    // Wait for the look-ahead plan to publish (the strip shows before you act).
    await expect(page.getByTestId("liqflow-step-confirm")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("add-liquidity-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("add-liquidity-btn").click();

    await expect(page.getByTestId("liqflow-done")).toBeVisible({ timeout: 30_000 });
    const link = page.getByTestId("liqflow-tx-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", new RegExp(MOCK_HASH.slice(2, 18)));
    const strip = page.getByTestId("liq-flow");
    await expect(strip.locator('[data-flow-state="active"]')).toHaveCount(0);
    await expect(strip.locator('[data-flow-state="todo"]')).toHaveCount(0);
  });

  test("a rejected wallet prompt marks the flow stopped and says nothing moved", async ({ page }) => {
    await page.addInitScript(ETH_FULL_SCRIPT);
    await page.addInitScript(ETH_REJECT_SCRIPT);
    await page.goto("/pools/30");
    await expect(page.getByTestId("liquidity-panel")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("wallet-pill-evm").click();
    await page.getByTestId("liq-add-input").fill("1");
    await expect(page.getByTestId("liqflow-step-confirm")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("add-liquidity-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("add-liquidity-btn").click();

    await expect(page.getByTestId("liqflow-failed")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("liq-flow")).toContainText(/nothing moved/i);
    await expect(page.getByTestId("liqflow-tx-link")).toHaveCount(0);
  });

  test("Solana look-ahead is one signature — no approval step (approval only when real)", async ({ page }) => {
    await stubPhantom(page);
    await page.goto("/pools/30");
    await expect(page.getByTestId("liquidity-panel")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("wallet-pill-solana").click();
    await page.getByTestId("liq-add-input").fill("1");

    await expect(page.getByTestId("liqflow-step-confirm")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("liqflow-step-receive")).toBeVisible();
    // The Solana lane reads no allowance, so it promises no approval prompt.
    await expect(page.getByTestId("liqflow-step-approve")).toHaveCount(0);
    await expect(page.getByTestId("liq-flow")).toContainText(/one signature/i);
  });
});

// ── ORDERS (swap surface, Limit tab) ─────────────────────────────────────────

test.describe("Orders flow strip — limit", () => {
  test.beforeEach(async ({ page }) => {
    await mockSolana(page);
  });

  const openLimit = async (page: Page) => {
    await page.goto("/");
    await page.getByTestId("order-tab-limit").click();
    await expect(page.getByTestId("orders-form")).toBeVisible();
  };
  const fillLimit = async (page: Page) => {
    await page.getByTestId("orders-amount").fill("10");
    await page.getByTestId("orders-price").fill("1");
  };

  test("EVM look-ahead names the honest prompt count (account setup, then the order)", async ({ page }) => {
    await page.addInitScript(ETH_FULL_SCRIPT);
    await openLimit(page);
    await page.getByTestId("wallet-pill-evm").click();
    await fillLimit(page);

    await expect(page.getByTestId("ordflow-step-setup")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("ordflow-step-confirm")).toBeVisible();
    await expect(page.getByTestId("ordflow-step-live")).toBeVisible();
    await expect(page.getByTestId("orders-flow")).toContainText(/account setup/i);
  });

  test("driving the EVM order tracks steps live and lands the tx hash in the strip", async ({ page }) => {
    await page.addInitScript(ETH_FULL_SCRIPT);
    await openLimit(page);
    await page.getByTestId("wallet-pill-evm").click();
    await fillLimit(page);
    // Wait for the look-ahead plan to publish (the strip shows before you act).
    await expect(page.getByTestId("ordflow-step-confirm")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("orders-place-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("orders-place-btn").click();

    await expect(page.getByTestId("ordflow-done")).toBeVisible({ timeout: 30_000 });
    const link = page.getByTestId("ordflow-tx-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", new RegExp(MOCK_HASH.slice(2, 18)));
    const strip = page.getByTestId("orders-flow");
    await expect(strip.locator('[data-flow-state="active"]')).toHaveCount(0);
    await expect(strip.locator('[data-flow-state="todo"]')).toHaveCount(0);
  });

  test("a rejected wallet prompt marks the order stopped and says nothing moved", async ({ page }) => {
    await page.addInitScript(ETH_FULL_SCRIPT);
    await page.addInitScript(ETH_REJECT_SCRIPT);
    await openLimit(page);
    await page.getByTestId("wallet-pill-evm").click();
    await fillLimit(page);
    await expect(page.getByTestId("ordflow-step-confirm")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("orders-place-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("orders-place-btn").click();

    await expect(page.getByTestId("ordflow-failed")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("orders-flow")).toContainText(/nothing moved/i);
    await expect(page.getByTestId("ordflow-tx-link")).toHaveCount(0);
  });

  test("Solana look-ahead is one signature — no account-setup step (setup only when real)", async ({ page }) => {
    await stubPhantom(page);
    await openLimit(page);
    await page.getByTestId("wallet-pill-solana").click();
    await fillLimit(page);

    await expect(page.getByTestId("ordflow-step-confirm")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("ordflow-step-live")).toBeVisible();
    await expect(page.getByTestId("ordflow-step-setup")).toHaveCount(0);
    await expect(page.getByTestId("orders-flow")).toContainText(/one signature/i);
  });
});
