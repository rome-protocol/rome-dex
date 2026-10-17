// indexer-core.test.mjs — the swap scan must ask the RPC for v1 transactions.
// Rome EVM-lane txs are Solana v1 txs; with maxSupportedTransactionVersion 0 the
// RPC answers -32015 and the swap was silently dropped (analytics showed EVM 0%).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanPoolSwaps } from "./indexer-core.mjs";

const POOL = {
  program: "DexProgram1111111111111111111111111111111111",
  swapState: "SwapState111111111111111111111111111111111",
  vaultA: "VaultA11111111111111111111111111111111111",
  vaultB: "VaultB11111111111111111111111111111111111",
  mintA: "MintA111111111111111111111111111111111111",
  mintB: "MintB111111111111111111111111111111111111",
  decimalsA: 6, decimalsB: 9, symbolA: "USDC", symbolB: "SOL",
};
const ROME_EVM = "RomeEvm11111111111111111111111111111111111";
const bal = (accountIndex, amount) => ({ accountIndex, uiTokenAmount: { amount: String(amount) } });

// A v1 EVM-lane swap: rome-evm top-level, dex as an inner (CPI) instruction, tag 1.
const v1EvmSwap = {
  version: 1,
  blockTime: 1_760_000_000,
  transaction: {
    message: {
      accountKeys: [{ pubkey: ROME_EVM }, { pubkey: POOL.vaultA }, { pubkey: POOL.vaultB }],
      instructions: [{ programId: ROME_EVM, data: "" }],
    },
  },
  meta: {
    innerInstructions: [{ instructions: [{ programId: POOL.program, data: "2" }] }], // base58 "2" = byte 0x01
    preTokenBalances: [bal(1, 0), bal(2, 5_000)],
    postTokenBalances: [bal(1, 1_000_000), bal(2, 4_000)],
  },
};

test("scan requests v1 transactions and indexes a v1 EVM-lane swap", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    let result;
    if (body.method === "getSignaturesForAddress") result = [{ signature: "sig1", err: null, blockTime: 1_760_000_000 }];
    else if (body.method === "getTransaction") {
      if (body.params[1].maxSupportedTransactionVersion < 1) {
        return { json: async () => ({ error: { code: -32015, message: "Transaction version (1) is not supported" } }) };
      }
      result = v1EvmSwap;
    }
    return { json: async () => ({ result }) };
  };
  try {
    const out = await scanPoolSwaps(POOL, { url: "http://rpc.invalid", romeEvm: ROME_EVM });
    const getTx = calls.find((c) => c.method === "getTransaction");
    assert.equal(getTx.params[1].maxSupportedTransactionVersion, 1);
    assert.equal(out.swaps.length, 1);
    assert.equal(out.swaps[0].lane, "evm");
    assert.equal(out.swaps[0].inputRaw, 1_000_000n);
  } finally {
    globalThis.fetch = realFetch;
  }
});
