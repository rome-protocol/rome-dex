// Unit tests for lib/txerror.toTxStatus — the cancel-aware, safe error mapper
// every wallet-action catch block uses (swap / liquidity / farms). Pure logic,
// no browser needed. Runs in the Playwright suite (transpiles TS).

import { test, expect } from "@playwright/test";
import { toTxStatus } from "../lib/txerror";

test.describe("toTxStatus — cancel detection", () => {
  test("MetaMask EIP-1193 user rejection (code 4001) → cancelled", () => {
    const r = toTxStatus({ code: 4001, message: "MetaMask Tx Signature: User denied transaction signature." });
    expect(r.cancelled).toBe(true);
    expect(r.message).toMatch(/cancelled/i);
    expect(r.message).not.toMatch(/\{|error|0x/i); // no raw blob leaks
  });

  test("ethers v6 ACTION_REJECTED → cancelled", () => {
    const r = toTxStatus({ code: "ACTION_REJECTED", shortMessage: "user rejected action" });
    expect(r.cancelled).toBe(true);
  });

  test("Phantom 'User rejected the request' → cancelled", () => {
    const r = toTxStatus(new Error("User rejected the request."));
    expect(r.cancelled).toBe(true);
  });

  test("plain-string rejection message → cancelled", () => {
    const r = toTxStatus("Error: user rejected the transaction");
    expect(r.cancelled).toBe(true);
  });
});

test.describe("toTxStatus — friendly, non-cancel errors", () => {
  test("on-chain mollusk failure is humanized, not cancelled", () => {
    const r = toTxStatus(new Error("mollusk error: Failure(InvalidAccountData) [program Fv2…]"));
    expect(r.cancelled).toBe(false);
    expect(r.message).toMatch(/account isn't set up yet/i);
  });

  test("slippage failure is humanized", () => {
    const r = toTxStatus(new Error("mollusk error: Failure(ExceededSlippage)"));
    expect(r.cancelled).toBe(false);
    expect(r.message).toMatch(/slippage/i);
  });

  test("GUIDE: pre-flight guidance surfaces verbatim, never as a revert", () => {
    const r = toTxStatus(new Error("GUIDE: Staking needs a one-time account setup that isn't possible from the EVM lane yet. Connect a Solana wallet once and stake any amount."));
    expect(r.cancelled).toBe(false);
    expect(r.message).toMatch(/^Staking needs a one-time account setup/);
    expect(r.message).toMatch(/Connect a Solana wallet/);
    expect(r.message).not.toMatch(/GUIDE:|Reverted/);
  });

  test("unimplemented precompile method → lane guidance (the live create-pool break)", () => {
    const r = toTxStatus(new Error("execution reverted: the feature is unimplemented: method is not supported by HelperProgram 0x8b0caf87 "));
    expect(r.cancelled).toBe(false);
    expect(r.message).toMatch(/isn't available on the EVM lane yet/);
    expect(r.message).toMatch(/Solana lane/);
    expect(r.message).not.toMatch(/0x8b0caf87/);
  });

  test("Failure(Custom(1)) → balance-first humanization (the live provide break)", () => {
    const r = toTxStatus(new Error("RPC submit: execution reverted: SimulateTransactionError: mollusk error: Failure(Custom(1)) [program cLMkE4X3PN4qwLBjUksHAnYbQiNMMedCPEdYwRbLVjV]"));
    expect(r.cancelled).toBe(false);
    expect(r.message).toMatch(/not enough token balance/i);
  });

  test("execution-revert reason is extracted", () => {
    const r = toTxStatus(new Error('execution reverted: "LpBelowMinimum"'));
    expect(r.cancelled).toBe(false);
    expect(r.message).toMatch(/LpBelowMinimum/);
  });

  test("giant blob is trimmed to a short one-liner", () => {
    const r = toTxStatus(new Error("x".repeat(5000)));
    expect(r.cancelled).toBe(false);
    expect(r.message.length).toBeLessThanOrEqual(160);
  });

  // The error UI must NEVER render an empty box (standing rule: errors never
  // break the UI). An error with an empty/whitespace message still yields a
  // usable, non-empty status — the empty-string message isn't swallowed.
  test("empty-message Error → non-empty, useful status", () => {
    const r = toTxStatus(new Error(""));
    expect(r.cancelled).toBe(false);
    expect(r.message.trim().length).toBeGreaterThan(0);
  });

  test("object with empty message → non-empty status", () => {
    const r = toTxStatus({ message: "" });
    expect(r.cancelled).toBe(false);
    expect(r.message.trim().length).toBeGreaterThan(0);
  });

  test("whitespace-only message → non-empty status", () => {
    const r = toTxStatus(new Error("   "));
    expect(r.cancelled).toBe(false);
    expect(r.message.trim().length).toBeGreaterThan(0);
  });
});
