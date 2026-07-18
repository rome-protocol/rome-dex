// TypeScript twin of sdk/oracle.mjs — reads LIVE USD prices from Rome's
// Chainlink-compatible oracle feeds via eth_call. Pure fetch, no deps. Both
// this file and the .mjs original must stay in sync (same feeds, same math).
//
// Chainlink AggregatorV3: latestRoundData() 0xfeaf968c → 5 uint256 words
// (roundId, answer, startedAt, updatedAt, answeredInRound); decimals() 0x313ce567.
// Feed addresses come from the active ChainConfig (cfg.oracle.feeds, keyed by
// pair like "SOL/USD"), canonical in registry chains/<id>/oracle.json.

const SEL_LATEST_ROUND_DATA = "0xfeaf968c";
const SEL_DECIMALS = "0x313ce567";

export const STALE_AFTER_SECONDS = 300; // ~5 min

const SYMBOL_TO_PAIR: Record<string, string> = {
  SOL: "SOL/USD", WSOL: "SOL/USD",
  USDC: "USDC/USD", WUSDC: "USDC/USD",
  ETH: "ETH/USD", WETH: "ETH/USD",
};

export interface PriceResult {
  price: number;
  decimals: number;
  updatedAt: number;
  stale: boolean;
  answer: string;
  address: string;
}

// Resolve a token symbol OR a "X/USD" pair to a feed address, or null. Feeds are
// the active chain's cfg.oracle.feeds (keys like "SOL/USD").
export function feedFor(symbol: string | null | undefined, feeds: Record<string, string>): string | null {
  if (!symbol) return null;
  const s = String(symbol).trim();
  if (feeds[s]) return feeds[s];
  const pair = SYMBOL_TO_PAIR[s.toUpperCase()];
  return pair ? (feeds[pair] ?? null) : null;
}

async function ethCall(to: string, data: string, rpc: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    cache: "no-store",
  });
  const j = await res.json();
  if (j.error) throw new Error(`eth_call ${to}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result as string;
}

function toSignedBigInt(word: string): bigint {
  let v = BigInt("0x" + word);
  const MAX = 1n << 255n;
  if (v >= MAX) v -= 1n << 256n;
  return v;
}

// Read a live price for a feed pair OR token symbol. Returns null when no feed
// maps to the symbol (graceful — the caller renders no USD value).
export async function fetchPrice(symbolOrPair: string, rpc: string, feeds: Record<string, string>): Promise<PriceResult | null> {
  const address = feedFor(symbolOrPair, feeds);
  if (!address) return null;

  const [roundHex, decHex] = await Promise.all([
    ethCall(address, SEL_LATEST_ROUND_DATA, rpc),
    ethCall(address, SEL_DECIMALS, rpc),
  ]);

  const body = roundHex.slice(2);
  const word = (i: number) => body.slice(i * 64, i * 64 + 64);
  const answer = toSignedBigInt(word(1));
  const updatedAt = Number(BigInt("0x" + word(3)));
  const decimals = Number(BigInt(decHex));

  const price = Number(answer) / 10 ** decimals;
  const nowSec = Math.floor(Date.now() / 1000);
  const stale = updatedAt > 0 ? nowSec - updatedAt > STALE_AFTER_SECONDS : true;

  return { price, decimals, updatedAt, stale, answer: answer.toString(), address };
}

export async function fetchPrices(symbols: string[], rpc: string, feeds: Record<string, string>): Promise<Record<string, PriceResult | null>> {
  const out: Record<string, PriceResult | null> = {};
  // Per-feed containment: a reverting adapter (e.g. StalePriceFeed between its
  // keeper's refreshes) costs exactly its own USD figures — never the whole
  // map. One dead feed took down the entire analytics page (live, 2026-07-09).
  await Promise.all(symbols.map(async (s) => {
    try {
      out[s] = await fetchPrice(s, rpc, feeds);
    } catch {
      out[s] = null;
    }
  }));
  return out;
}
