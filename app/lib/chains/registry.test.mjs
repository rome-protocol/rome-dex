import { test } from "node:test";
import assert from "node:assert/strict";
import { registryChainFields, publishedChainIds } from "./registry.mjs";

test("registryChainFields(200010) maps Hadrian, with the PUBLIC Solana RPC", () => {
  const f = registryChainFields("200010");
  assert.equal(f.chainId, "200010");
  assert.equal(f.solanaRpc, "https://api.devnet.solana.com"); // the leak-killed field
  assert.equal(f.solanaCluster, "devnet");
  assert.equal(f.romeEvmProgramId, "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
  assert.match(f.evmRpc, /^https:\/\/hadrian.*romeprotocol\.xyz\/?$/);
  assert.match(f.explorerBase, /\/tx$/); // rome-dex appends /tx to the registry explorer base
  assert.equal(f.oracle.feeds["SOL/USD"], "0x76b92646D63FB1AFEa687C7Dac48b437bF99C1B4");
});

test("no internal Solana RPC host can leak through the registry mapping", () => {
  for (const id of publishedChainIds()) {
    const f = registryChainFields(id);
    assert.doesNotMatch(f.solanaRpc, /devnet-eu-sol-api|node1\./); // internal host must never appear
    assert.match(f.solanaRpc, /^https:\/\/api\.(devnet|testnet|mainnet-beta)\.solana\.com/);
  }
});

test("publishedChainIds = the registry allowlist (Hadrian + Martius, R13)", () => {
  assert.deepEqual(publishedChainIds().sort(), ["121214", "200010"]);
});

test("an unpublished chain id throws (fail-closed)", () => {
  assert.throws(() => registryChainFields("999999"), /no published chain/);
});
