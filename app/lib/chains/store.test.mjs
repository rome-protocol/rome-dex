import { test } from "node:test";
import assert from "node:assert/strict";
import { pickInitialChainId } from "./core.mjs";
import { CHAIN_STORAGE_KEY } from "./store-constants.mjs";

test("storage key is stable", () => { assert.equal(CHAIN_STORAGE_KEY, "rome-dex.chainId"); });

test("initial selection uses persisted then first", () => {
  // pickInitialChainId is pure over the chainId field — no registry/normalize needed.
  const cs = [{ chainId: "1" }, { chainId: "2" }];
  assert.equal(pickInitialChainId(cs, "2"), "2");
  assert.equal(pickInitialChainId(cs, null), "1");
});
