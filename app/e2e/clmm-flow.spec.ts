/**
 * clmm-flow.spec.ts — the CLMM provide-a-range panel (Solana lane, ⑤b).
 *
 * Headless scope (mirrors swap.spec's Solana boundary): a real Solana-lane
 * submit needs a real signature, so we prove the parts that don't — the
 * no-wallet gate, the deposit preview computed from the LIVE pool, band
 * validation, and the rejected-sign → "nothing moved" tracker path. The
 * happy-path open is covered by the operator's real-wallet pass on :3200.
 *
 * The pool reads hit the live pool (as /clmm's render smoke already does); the
 * fresh wallet's position PDA doesn't exist, so "no positions" is truthful.
 */
import { test, expect, type Page } from "@playwright/test";
import { collectErrors } from "./helpers";

const PK = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// The open button gates on the wallet's REAL balances of the pool's two tokens
// (a truthful "top up first" instead of an on-chain Custom(1)). These specs
// model "a user who holds both tokens": answer getTokenAccountBalance with a
// big amount, let every other Solana read stay live.
async function mockTokenBalances(page: Page) {
  await page.route((url) => url.hostname.includes("api.devnet.solana.com"), async (route) => {
    const body = route.request().postDataJSON() as { method?: string; id?: number } | null;
    if (body?.method === "getTokenAccountBalance") {
      return route.fulfill({ json: { jsonrpc: "2.0", id: body.id ?? 1, result: { context: { slot: 1 }, value: { amount: "1000000000000", decimals: 6, uiAmount: 1_000_000, uiAmountString: "1000000" } } } });
    }
    return route.fallback();
  });
}

async function connectSolana(page: Page, opts: { rejectSign?: boolean } = {}) {
  await page.addInitScript(({ pk, reject }) => {
    const provider = {
      isPhantom: true,
      publicKey: null as { toString(): string } | null,
      connect: async () => ({ publicKey: { toString: () => pk } }),
      disconnect: async () => {},
      signTransaction: async (tx: unknown) => {
        if (reject) { const e = new Error("User rejected the request."); (e as { code?: number }).code = 4001; throw e; }
        return tx;
      },
    };
    const w = window as unknown as Record<string, unknown>;
    w.phantom = { solana: provider };
    w.solana = provider;
  }, { pk: PK, reject: !!opts.rejectSign });
}

// EVM full-happy-path provider (mirrors flowtracker.spec): signs nothing, every
// sendTransaction resolves a fixed hash + a confirming receipt. Solana reads hit
// the live pool (the fresh EOA's PDA has 0 SOL + no position — truthful).
const MOCK_HASH = "0x" + "cd".repeat(32);
async function connectEvm(page: Page, opts: { reject?: boolean } = {}) {
  await page.addInitScript(({ hash, reject }) => {
    const receipt = { status: "0x1", transactionHash: hash, transactionIndex: "0x0", blockNumber: "0x10", blockHash: "0x" + "22".repeat(32), from: "0x1111222233334444555566667777888899990000", to: "0x" + "33".repeat(20), cumulativeGasUsed: "0x5208", gasUsed: "0x5208", logs: [], logsBloom: "0x" + "00".repeat(256), type: "0x2", effectiveGasPrice: "0x0", contractAddress: null };
    (window as unknown as Record<string, unknown>).ethereum = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return ["0x1111222233334444555566667777888899990000"];
        if (method === "eth_chainId") return "0x30D4A";
        if (method === "net_version") return "200010";
        if (method === "eth_maxPriorityFeePerGas" || method === "eth_gasPrice") return "0x0";
        if (method === "eth_blockNumber") return "0x10";
        if (method === "eth_estimateGas") return "0x5208";
        if (method === "eth_getTransactionCount") return "0x0";
        if (method === "eth_sendTransaction") { if (reject) { const e = new Error("User rejected the request."); (e as { code?: number }).code = 4001; throw e; } return hash; }
        if (method === "eth_getTransactionByHash") return { hash, blockNumber: "0x10", blockHash: receipt.blockHash, transactionIndex: "0x0", from: receipt.from, to: receipt.to, nonce: "0x0", value: "0x0", gas: "0x5208", input: "0x", type: "0x2", chainId: "0x30D4A", gasPrice: "0x0", maxFeePerGas: "0x0", maxPriorityFeePerGas: "0x0", accessList: [], v: "0x1", r: "0x" + "11".repeat(32), s: "0x" + "12".repeat(32) };
        if (method === "eth_getTransactionReceipt") return receipt;
        return null;
      },
      on: () => {}, removeListener: () => {},
    };
  }, { hash: MOCK_HASH, reject: !!opts.reject });
}

test.describe("CLMM provide-a-range panel", () => {
  test("no wallet → panel asks to connect a lane", async ({ page }) => {
    await page.goto("/clmm");
    await expect(page.getByTestId("clmm-panel")).toBeVisible();
    await expect(page.getByTestId("clmm-panel")).toContainText(/connect an evm or solana wallet/i);
  });

  test("connected + preset + amount → truthful deposit preview and an enabled Open", async ({ page }) => {
    await connectSolana(page);
    await mockTokenBalances(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("clmm-preset-±5%")).toBeVisible({ timeout: 15_000 });
    // Wait for the live pool to load (preset needs the current price).
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
    await page.getByTestId("clmm-preset-±5%").click();
    await page.getByTestId("clmm-amount").fill("10");
    // Preview computes both provided tokens from the live pool + chosen band.
    await expect(page.getByTestId("clmm-preview")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("clmm-preview")).toContainText(/SOL/); // pools[0] = the real SOL/USDC pool
    const btn = page.getByTestId("clmm-open-btn");
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText("Open position");
  });

  test("wallet without the pool's tokens → Open gated with a top-up note, nothing submitted", async ({ page }) => {
    // No balance mock: the fake pubkey's token accounts don't exist on the live
    // chain, so balances read 0 — the gate must explain instead of letting the
    // chain reject with an opaque error (the live break this guards against).
    await connectSolana(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
    await page.getByTestId("clmm-preset-±5%").click();
    await page.getByTestId("clmm-amount").fill("10");
    await expect(page.getByTestId("clmm-preview")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("clmm-balance-note")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("clmm-balance-note")).toContainText(/top up/i);
    await expect(page.getByTestId("clmm-open-btn")).toBeDisabled();
    await expect(page.getByTestId("clmm-open-btn")).toContainText(/not enough/i);
  });

  test("min ≥ max → band is rejected and Open is disabled", async ({ page }) => {
    await connectSolana(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("clmm-lower")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("clmm-lower").fill("2");
    await page.getByTestId("clmm-upper").fill("1");
    await page.getByTestId("clmm-amount").fill("10");
    await expect(page.getByTestId("clmm-band-invalid")).toBeVisible();
    await expect(page.getByTestId("clmm-open-btn")).toBeDisabled();
  });

  test("rejected signature → the flow says nothing moved, no tx link", async ({ page }) => {
    await connectSolana(page, { rejectSign: true });
    await mockTokenBalances(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
    await page.getByTestId("clmm-preset-±5%").click();
    await page.getByTestId("clmm-amount").fill("10");
    await expect(page.getByTestId("clmm-open-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("clmm-open-btn").click();
    await expect(page.getByTestId("clmmflow-failed")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("clmm-open-flow")).toContainText(/nothing moved/i);
    await expect(page.getByTestId("clmmflow-tx-link")).toHaveCount(0);
  });

  test("fresh wallet → no positions yet", async ({ page }) => {
    await connectSolana(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("clmm-no-positions")).toBeVisible({ timeout: 15_000 });
  });

  // ⑤c: the EVM lane now provides a range too (no more "coming next" note).
  test("EVM lane → range picker (not a 'coming next' note)", async ({ page }) => {
    await connectEvm(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-evm").click();
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
    await expect(page.getByTestId("clmm-preset-±5%")).toBeVisible();
    await expect(page.getByTestId("clmm-panel")).not.toContainText(/coming next/i);
  });

  test("EVM lane → driving Open tracks the flow and lands the tx link", async ({ page }) => {
    await connectEvm(page);
    await mockTokenBalances(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-evm").click();
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
    await page.getByTestId("clmm-preset-±5%").click();
    await page.getByTestId("clmm-amount").fill("2");
    await expect(page.getByTestId("clmm-open-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("clmm-open-btn").click();
    await expect(page.getByTestId("clmmflow-done")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("clmmflow-tx-link")).toBeVisible();
  });

  test("EVM lane → rejected prompt says nothing moved, no tx link", async ({ page }) => {
    await connectEvm(page, { reject: true });
    await mockTokenBalances(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-evm").click();
    await expect(page.getByTestId("clmm-price")).not.toHaveText("—", { timeout: 20_000 });
    await page.getByTestId("clmm-preset-±5%").click();
    await page.getByTestId("clmm-amount").fill("2");
    await expect(page.getByTestId("clmm-open-btn")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("clmm-open-btn").click();
    await expect(page.getByTestId("clmmflow-failed")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("clmm-open-flow")).toContainText(/nothing moved/i);
    await expect(page.getByTestId("clmmflow-tx-link")).toHaveCount(0);
  });

  // REGRESSION: a connected wallet must not trigger a render loop. `owner` was
  // rebuilt (new PublicKey) every render, so the loadPositions effect re-fired
  // endlessly → "Maximum update depth exceeded". render.spec missed it (it never
  // connects a wallet); this asserts console-clean WITH a wallet connected.
  test("connected wallet → no render-loop / console errors", async ({ page }) => {
    const getErrors = collectErrors(page);
    await connectSolana(page);
    await page.goto("/clmm");
    await page.getByTestId("wallet-pill-solana").click();
    await expect(page.getByTestId("clmm-panel")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2500); // let any loop manifest
    expect(getErrors(), `console errors with a wallet connected: ${getErrors().join(" | ")}`).toEqual([]);
  });
});
