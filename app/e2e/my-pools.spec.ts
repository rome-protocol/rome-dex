/**
 * my-pools.spec.ts — the client-side "pools you created" registry (pure logic).
 * Exercises add / list / dedup / remove against an in-memory store, so the
 * created-pools-on-/pools feature can't silently regress its storage contract.
 */
import { test, expect } from "@playwright/test";
import { addMyPool, listMyPools, removeMyPool, type MyPool } from "../lib/myPools";

function fakeStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

const pool = (over: Partial<MyPool>): MyPool => ({
  kind: "simple", pool: "P1", program: "PROG",
  mintA: "MA", mintB: "MB", symbolA: "USDC", symbolB: "SOL", decimalsA: 6, decimalsB: 9,
  vaultA: "VA", vaultB: "VB", feeBps: 30, tier: "0.30%", createdSig: "sig1", createdAt: 1,
  ...over,
});

test.describe("myPools registry", () => {
  test("empty store lists nothing", () => {
    expect(listMyPools(fakeStore())).toEqual([]);
  });

  test("add stores + lists newest-first", () => {
    const s = fakeStore();
    addMyPool(pool({ pool: "P1" }), s);
    addMyPool(pool({ pool: "P2", symbolB: "ETH" }), s);
    const list = listMyPools(s);
    expect(list.map((p) => p.pool)).toEqual(["P2", "P1"]);
  });

  test("add dedups by pool address (re-adding updates, no duplicate)", () => {
    const s = fakeStore();
    addMyPool(pool({ pool: "P1", tier: "0.30%" }), s);
    addMyPool(pool({ pool: "P1", tier: "1.00%" }), s);
    const list = listMyPools(s);
    expect(list).toHaveLength(1);
    expect(list[0].tier).toBe("1.00%");
  });

  test("remove drops the entry by address", () => {
    const s = fakeStore();
    addMyPool(pool({ pool: "P1" }), s);
    addMyPool(pool({ pool: "P2" }), s);
    removeMyPool("P1", s);
    expect(listMyPools(s).map((p) => p.pool)).toEqual(["P2"]);
  });

  test("bad JSON in the store degrades to empty, never throws", () => {
    const s = fakeStore();
    s.setItem("rome-dex:my-pools", "{not json");
    expect(listMyPools(s)).toEqual([]);
  });

  test("null store (SSR) is safe", () => {
    expect(listMyPools(null)).toEqual([]);
    expect(() => addMyPool(pool({}), null)).not.toThrow();
  });
});
