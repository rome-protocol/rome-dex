// rome-dex oracle SDK — reads LIVE USD prices from Rome's Chainlink-compatible
// oracle feeds via eth_call to the EVM RPC. Pure fetch, no dependencies —
// importable by the harness and (as the .ts twin app/lib/oracle.ts) the app.
//
// Feeds are Chainlink AggregatorV3-compatible: latestRoundData() selector
// 0xfeaf968c returns (roundId, answer, startedAt, updatedAt, answeredInRound),
// decimals() selector 0x313ce567 returns uint8. Addresses come from the
// registry (chains/200010-hadrian/oracle.json); mirrored here so the pure SDK
// stays dependency-free. If these drift in the registry, update both twins.

export const EVM_RPC = "https://hadrian-lt.testnet.romeprotocol.xyz/";

// Chainlink AggregatorV3Interface selectors.
const SEL_LATEST_ROUND_DATA = "0xfeaf968c";
const SEL_DECIMALS = "0x313ce567";

// Staleness window: a feed is `stale` if its updatedAt is older than this.
export const STALE_AFTER_SECONDS = 300; // ~5 min

// Feed registry: symbol → { address, pair }. Canonical source is
// registry chains/200010-hadrian/oracle.json.
export const FEEDS = {
  "SOL/USD": { address: "0x63C28E0adE03B38e32b9cD85f2dD9B9fbB89185F", pair: "SOL/USD" },
  "USDC/USD": { address: "0xFf1adC858a6e16aD146b020da1CBfa5891a76f97", pair: "USDC/USD" },
  "ETH/USD": { address: "0xbE869FCA226545927E671E60F32720dB9dEc5980", pair: "ETH/USD" },
};

// Token symbol → feed pair. Wrapped Rome tokens alias to the underlying feed.
const SYMBOL_TO_PAIR = {
  SOL: "SOL/USD", WSOL: "SOL/USD",
  USDC: "USDC/USD", WUSDC: "USDC/USD",
  ETH: "ETH/USD", WETH: "ETH/USD",
};

// Resolve a token symbol OR a "X/USD" pair to a feed address, or null if none.
export function feedFor(symbol) {
  if (!symbol) return null;
  const s = String(symbol).trim();
  if (FEEDS[s]) return FEEDS[s].address; // already a pair label
  const pair = SYMBOL_TO_PAIR[s.toUpperCase()];
  return pair ? FEEDS[pair].address : null;
}

async function ethCall(to, data, rpc) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`eth_call ${to}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

// Parse a signed 256-bit hex word as a BigInt (two's complement).
function toSignedBigInt(word) {
  let v = BigInt("0x" + word);
  const MAX = 1n << 255n;
  if (v >= MAX) v -= 1n << 256n;
  return v;
}

// Read a live price for a feed pair ("SOL/USD") OR a token symbol ("SOL"/"wSOL").
// Returns { price, decimals, updatedAt, stale, answer, address } or null when
// no feed maps to the symbol (graceful — caller shows no USD).
export async function fetchPrice(symbolOrPair, rpc = EVM_RPC) {
  const address = feedFor(symbolOrPair);
  if (!address) return null;

  const [roundHex, decHex] = await Promise.all([
    ethCall(address, SEL_LATEST_ROUND_DATA, rpc),
    ethCall(address, SEL_DECIMALS, rpc),
  ]);

  // latestRoundData packs 5 uint256 words: roundId, answer, startedAt, updatedAt, answeredInRound.
  const body = roundHex.slice(2);
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  const answer = toSignedBigInt(word(1));
  const updatedAt = Number(BigInt("0x" + word(3)));
  const decimals = Number(BigInt(decHex));

  const price = Number(answer) / 10 ** decimals;
  const nowSec = Math.floor(Date.now() / 1000);
  const stale = updatedAt > 0 ? nowSec - updatedAt > STALE_AFTER_SECONDS : true;

  return { price, decimals, updatedAt, stale, answer: answer.toString(), address };
}

// Batch helper: fetch several symbols/pairs at once. Unknown symbols map to null.
export async function fetchPrices(symbols, rpc = EVM_RPC) {
  const out = {};
  await Promise.all(symbols.map(async (s) => { out[s] = await fetchPrice(s, rpc); }));
  return out;
}
