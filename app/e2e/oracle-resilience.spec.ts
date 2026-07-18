// Unit tests for lib/oracle price-map containment (node-side, txerror.spec
// pattern). Live break 2026-07-09: the ETH/USD adapter reverting
// StalePriceFeed() (0x1087e109 — its keeper refreshes every 180s against a 60s
// on-chain window) took down the ENTIRE analytics page: fetchPrice throws on a
// revert and fetchPrices' bare Promise.all rejected the whole map. One dead
// feed must cost exactly its own USD figures, nothing else.
import { test, expect } from "@playwright/test";
import { fetchPrices, fetchPrice } from "../lib/oracle";

const FEEDS = {
  "SOL/USD": "0x63C28E0adE03B38e32b9cD85f2dD9B9fbB89185F",
  "USDC/USD": "0xFf1adC858a6e16aD146b020da1CBfa5891a76f97",
  "ETH/USD": "0xbE869FCA226545927E671E60F32720dB9dEc5980",
};

// A fetch stub for the oracle's eth_call shapes: healthy feeds answer
// latestRoundData/decimals; the ETH feed reverts StalePriceFeed().
function stubFetch() {
  const now = Math.floor(Date.now() / 1000);
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  const round = "0x" + word(1n) + word(78_000_000_00n) + word(BigInt(now)) + word(BigInt(now)) + word(1n);
  const dec = "0x" + word(8n);
  global.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    const to = String(body?.params?.[0]?.to ?? "").toLowerCase();
    const data = String(body?.params?.[0]?.data ?? "");
    const json =
      to === FEEDS["ETH/USD"].toLowerCase()
        ? { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: ", data: "0x1087e109" } }
        : { jsonrpc: "2.0", id: 1, result: data === "0x313ce567" ? dec : round };
    return { json: async () => json } as Response;
  }) as typeof fetch;
}

test.describe("oracle price map — per-feed containment", () => {
  test("one reverting feed nulls ONLY its own price; the rest resolve", async () => {
    stubFetch();
    const prices = await fetchPrices(["USDC", "SOL", "ETH"], "http://stub", FEEDS);
    expect(prices.ETH).toBeNull();
    expect(prices.SOL?.price).toBeCloseTo(78, 0);
    expect(prices.USDC?.price).toBeCloseTo(78, 0); // stub returns one canned answer for healthy feeds
  });

  test("fetchPrice (single-feed API) still surfaces the revert to direct callers", async () => {
    stubFetch();
    await expect(fetchPrice("ETH", "http://stub", FEEDS)).rejects.toThrow(/0x1087e109|eth_call/);
  });
});
