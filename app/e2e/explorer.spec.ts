// Unit tests for lib/explorer.explorerUrl — the ONE lane-aware tx-link helper
// every panel (swap / liquidity / farms) must share. EVM tx hash (0x…) → Rome
// Via explorer; Solana signature (base58) → Solana explorer pinned to the Rome
// substrate cluster RPC. Pure logic, no browser needed.

import { test, expect } from "@playwright/test";
import { explorerUrl } from "../lib/explorer";

const EVM_HASH = "0x9a1fc4e2b3d05876a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef01";
const SOL_SIG = "5VERYrealLookingBase58SignatureXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

// explorerUrl now sources both endpoints from the active ChainConfig; a stub
// chain stands in for what the store would resolve at runtime.
const CHAIN = {
  explorerBase: "https://via-hadrian.testnet.romeprotocol.xyz/tx",
  solanaRpc: "https://api.devnet.solana.com",
};

test.describe("explorerUrl — lane-aware tx links", () => {
  test("EVM tx hash (0x…) → Rome Via explorer", () => {
    const url = explorerUrl(EVM_HASH, CHAIN);
    expect(url).toBe(`${CHAIN.explorerBase}/${EVM_HASH}`);
  });

  test("Solana signature (base58) → Solana explorer on the Rome substrate cluster", () => {
    const url = explorerUrl(SOL_SIG, CHAIN);
    expect(url).toContain(`https://explorer.solana.com/tx/${SOL_SIG}`);
    expect(url).toContain("cluster=custom");
    expect(url).toContain(encodeURIComponent(CHAIN.solanaRpc));
  });
});
