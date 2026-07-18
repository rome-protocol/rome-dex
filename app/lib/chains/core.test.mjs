import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeChains, getChainConfig, pickInitialChainId } from "./core.mjs";

// Local config now carries ONLY pool data (chainId + dex + clmm); chain metadata
// is merged from the public registry (published: 200010 Hadrian, 121214 Martius).
const RAW = {
  chains: [
    {
      chainId: "200010",
      dex: { dexProgram: "Fv2…", router: "0xcC", tiers: [{ pairId: "USDC-SOL", tier: "0.05%", bps: 5, swapState: "7B" }] },
      clmm: {
        program: "cLM…", router: "0x654",
        pools: [{ pool: "CD9", mint0: "m0", mint1: "m1", vault0: "v0", vault1: "v1", feePips: 3000, tickSpacing: 64, symbol0: "A", symbol1: "B", decimals0: 6, decimals1: 6, tickArrays: { "0": "T0" } }],
      },
    },
    { chainId: "121214", dex: { dexProgram: "P2", router: "0x02", tiers: [] } },
  ],
};

test("normalizeChains merges registry chain metadata with local pool data", () => {
  const cs = normalizeChains(RAW);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].chainId, "200010");
  assert.equal(cs[0].dex.tiers[0].swapState, "7B"); // local pool data passes through
  assert.equal(cs[0].solanaRpc, "https://api.devnet.solana.com"); // registry → PUBLIC RPC (leak killed)
  assert.match(cs[0].evmRpc, /romeprotocol\.xyz/);
  assert.equal(cs[0].romeEvmProgramId, "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
  assert.ok(cs[0].oracle.feeds["SOL/USD"]);
  assert.equal(cs[1].dex.farm, undefined); // optional omitted
});

test("normalizeChains rejects a chain missing chainId or dex", () => {
  assert.throws(() => normalizeChains({ chains: [{ dex: {} }] }), /chainId/);
  assert.throws(() => normalizeChains({ chains: [{ chainId: "200010" }] }), /dex/);
});

test("an unpublished chain id is rejected (fail-closed to the registry allowlist)", () => {
  assert.throws(
    () => normalizeChains({ chains: [{ chainId: "210000", dex: { dexProgram: "p", router: "r" } }] }),
    /no published chain/,
  );
});

test("getChainConfig finds by id, undefined when absent", () => {
  const cs = normalizeChains(RAW);
  assert.equal(getChainConfig(cs, "121214").chainId, "121214");
  assert.equal(getChainConfig(cs, "999"), undefined);
});

test("pickInitialChainId prefers a valid persisted id, else first", () => {
  const cs = normalizeChains(RAW);
  assert.equal(pickInitialChainId(cs, "121214"), "121214");
  assert.equal(pickInitialChainId(cs, "nope"), "200010");
  assert.equal(pickInitialChainId(cs, null), "200010");
});

test("clmm is passed through when present and undefined when absent", () => {
  const cs = normalizeChains(RAW);
  assert.equal(cs[0].clmm.program, "cLM…");
  assert.equal(cs[0].clmm.pools[0].tickArrays["0"], "T0");
  assert.equal(cs[1].clmm, undefined);
});
