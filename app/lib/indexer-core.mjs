// indexer-core.mjs — canonical, dependency-free on-chain swap indexer core for
// rome-dex. Pure scan + aggregate over a pool's Solana tx history. The
// server-side TypeScript wrapper (lib/indexer.ts) mirrors this (adds oracle USD,
// TTL cache, JSON shaping); the harness test (harness/indexer.test.mjs) exercises
// this module directly. Keep both in sync — same convention as
// sdk/quote.mjs ↔ app/lib/quote.ts.
//
// What it reads: for a pool it pages getSignaturesForAddress(swapState), fetches
// each tx (jsonParsed), decodes the rome-dex swap instruction tag (1 = swap
// exact-in, 6 = swap exact-out; deposit=2 / withdraw=3 are excluded), and derives
// the realized INPUT amount from the pool's vault token-balance deltas (the vault
// that INCREASED is the input side). Volume = input; LP fee = input × trade-fee
// rate. Lane is derived from tx origination: a Solana-lane swap calls the dex
// program as a TOP-LEVEL instruction; an EVM-lane swap is a CPI — the dex program
// runs as an INNER instruction of the rome-evm program's atomic tx.

export const SOL_RPC = "https://api.devnet.solana.com";
export const ROME_EVM = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf";

// rome-dex instruction tags that move trade volume (SwapInstruction::pack).
const SWAP_TAGS = new Set([1, 6]); // 1 = exact-in, 6 = exact-out

const DAY = 86_400;
const WEEK = 7 * DAY;

// --- minimal base58 decode (no dep — safe in both the Next bundle and node) ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58MAP = (() => { const m = {}; for (let i = 0; i < B58.length; i++) m[B58[i]] = i; return m; })();
function b58decode(str) {
  if (typeof str !== "string" || str.length === 0) return null;
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const v = B58MAP[str[i]];
    if (v === undefined) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry = carry >> 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry = carry >> 8; }
  }
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

async function rpc(method, params, url = SOL_RPC) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

function symOf(p, side) {
  if (side === "A") return p.symbolA ?? p.symbols?.A ?? "A";
  return p.symbolB ?? p.symbols?.B ?? "B";
}

/**
 * Parse one jsonParsed tx into a swap record, or null if it's not a rome-dex
 * swap on this pool. cfg = { program, vaultA, vaultB, mintA, mintB, decA, decB,
 * symA, symB, tradeNum, tradeDen }.
 */
export function parseSwapTx(t, cfg) {
  const msg = t?.transaction?.message;
  if (!msg || !Array.isArray(msg.instructions)) return null;
  const keys = msg.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const topProgs = msg.instructions.map((ix) => ix.programId);

  const romeEvm = cfg.romeEvm ?? ROME_EVM;
  const lane = topProgs.includes(cfg.program)
    ? "solana"
    : topProgs.includes(romeEvm)
      ? "evm"
      : null;
  if (!lane) return null;

  // Locate the dex instruction data (top-level for the Solana lane, inner for the
  // EVM CPI lane). jsonParsed encodes unrecognized-program data as base58.
  let data = null;
  for (const ix of msg.instructions) {
    if (ix.programId === cfg.program && ix.data) data = b58decode(ix.data);
  }
  for (const grp of t.meta?.innerInstructions ?? []) {
    for (const ix of grp.instructions) {
      if (ix.programId === cfg.program && ix.data) data = b58decode(ix.data);
    }
  }
  if (!data || data.length === 0) return null;
  if (!SWAP_TAGS.has(data[0])) return null; // exclude deposit/withdraw/init/etc

  // Realized input = the pool vault that increased (token balance delta).
  const pre = t.meta?.preTokenBalances ?? [];
  const post = t.meta?.postTokenBalances ?? [];
  const idxA = keys.indexOf(cfg.vaultA);
  const idxB = keys.indexOf(cfg.vaultB);
  const amt = (arr, idx) => {
    const b = arr.find((x) => x.accountIndex === idx);
    return b ? BigInt(b.uiTokenAmount.amount) : 0n;
  };
  const dA = amt(post, idxA) - amt(pre, idxA);
  const dB = amt(post, idxB) - amt(pre, idxB);

  let inputRaw, decimals, inputSymbol, inputMint;
  if (dA > 0n && dB <= 0n) { inputRaw = dA; decimals = cfg.decA; inputSymbol = cfg.symA; inputMint = cfg.mintA; }
  else if (dB > 0n && dA <= 0n) { inputRaw = dB; decimals = cfg.decB; inputSymbol = cfg.symB; inputMint = cfg.mintB; }
  else return null; // ambiguous / no net flow

  return {
    lane,
    inputRaw,        // BigInt
    decimals,
    inputSymbol,
    inputMint,
    tradeNum: cfg.tradeNum,
    tradeDen: cfg.tradeDen,
  };
}

/**
 * Scan a pool's swap history. Returns { swaps, earliestBlockTime,
 * latestBlockTime, truncated, scanned }. `truncated` is true when the scan hit
 * `maxSigs` (history beyond that point exists but was not read) — the caller
 * should label windows "indexed since <earliestBlockTime>".
 *
 * opts: { maxSigs=600, pageSize=200, concurrency=8, commitment="confirmed",
 * url, getTx } — getTx is an injectable tx fetcher (used by tests).
 */
export async function scanPoolSwaps(pool, opts = {}) {
  const { maxSigs = 600, pageSize = 200, concurrency = 8, commitment = "confirmed", url = SOL_RPC, romeEvm = ROME_EVM, getTx } = opts;
  const cfg = {
    program: pool.program,
    romeEvm,
    vaultA: pool.vaultA,
    vaultB: pool.vaultB,
    mintA: pool.mintA,
    mintB: pool.mintB,
    decA: pool.decimalsA ?? 6,
    decB: pool.decimalsB ?? 9,
    symA: symOf(pool, "A"),
    symB: symOf(pool, "B"),
    tradeNum: Number(pool.feeTradeNum ?? 25),
    tradeDen: Number(pool.feeTradeDen ?? 10000),
  };

  // Page signatures oldest-newest is not guaranteed; getSignaturesForAddress
  // returns newest-first. Page with `before` until we run out or hit the cap.
  const sigInfos = [];
  let before;
  let truncated = false;
  while (sigInfos.length < maxSigs) {
    const limit = Math.min(pageSize, maxSigs - sigInfos.length);
    const params = before
      ? [pool.swapState, { limit, before, commitment }]
      : [pool.swapState, { limit, commitment }];
    const batch = await rpc("getSignaturesForAddress", params, url);
    if (!batch || batch.length === 0) break;
    sigInfos.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < limit) break; // reached the end of retained history
    if (sigInfos.length >= maxSigs) { truncated = true; break; }
  }

  const fetchTx = getTx
    ? (sig) => getTx(sig)
    : (sig) => rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment }], url);

  const swaps = [];
  let earliest = null;
  let latest = null;
  for (let i = 0; i < sigInfos.length; i += concurrency) {
    const slice = sigInfos.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(async (si) => {
      if (si.err) return null; // failed txs move no volume
      const t = await fetchTx(si.signature).catch(() => null);
      if (!t) return null;
      const parsed = parseSwapTx(t, cfg);
      if (!parsed) return null;
      parsed.sig = si.signature;
      parsed.blockTime = t.blockTime ?? si.blockTime ?? null;
      return parsed;
    }));
    for (const p of results) {
      if (!p) continue;
      swaps.push(p);
      if (p.blockTime != null) {
        earliest = earliest == null ? p.blockTime : Math.min(earliest, p.blockTime);
        latest = latest == null ? p.blockTime : Math.max(latest, p.blockTime);
      }
    }
  }

  return { swaps, earliestBlockTime: earliest, latestBlockTime: latest, truncated, scanned: sigInfos.length };
}

/**
 * Aggregate scanned swaps into USD volume / LP fees, windowed (24h / 7d / all)
 * and split by lane. priceBySymbol maps token symbol → USD (null → that swap
 * contributes 0 USD but still counts raw + swap count). nowSec overridable for
 * deterministic tests.
 */
export function aggregate(swaps, priceBySymbol = {}, nowSec = Math.floor(Date.now() / 1000)) {
  let volumeUsdAll = 0, feesUsdAll = 0;
  let volumeUsd24h = 0, feesUsd24h = 0;
  let volumeUsd7d = 0, feesUsd7d = 0;
  let volumeUsd30d = 0, feesUsd30d = 0;
  let evmSwaps = 0, solSwaps = 0, evmVolumeUsd = 0, solVolumeUsd = 0;
  const rawVolBySymbol = {};
  // Real daily buckets (index 0 = 29 days ago … 29 = today), oldest → newest.
  const DAYS = 30;
  const dailyVolumeUsd = new Array(DAYS).fill(0);
  const dailyFeesUsd = new Array(DAYS).fill(0);

  for (const s of swaps) {
    const amt = Number(s.inputRaw) / 10 ** s.decimals;
    rawVolBySymbol[s.inputSymbol] = (rawVolBySymbol[s.inputSymbol] || 0) + amt;
    const price = priceBySymbol[s.inputSymbol];
    const usd = price == null ? 0 : amt * price;
    const feeUsd = usd * (s.tradeNum / s.tradeDen);

    volumeUsdAll += usd;
    feesUsdAll += feeUsd;
    if (s.lane === "evm") { evmSwaps++; evmVolumeUsd += usd; }
    else { solSwaps++; solVolumeUsd += usd; }

    if (s.blockTime != null) {
      const age = nowSec - s.blockTime;
      if (age <= DAY) { volumeUsd24h += usd; feesUsd24h += feeUsd; }
      if (age <= WEEK) { volumeUsd7d += usd; feesUsd7d += feeUsd; }
      if (age <= DAYS * DAY) {
        volumeUsd30d += usd; feesUsd30d += feeUsd;
        const daysAgo = Math.floor(age / DAY);            // 0..29
        const bucket = DAYS - 1 - Math.min(DAYS - 1, daysAgo);
        dailyVolumeUsd[bucket] += usd;
        dailyFeesUsd[bucket] += feeUsd;
      }
    }
  }

  return {
    swapCount: swaps.length,
    volumeUsdAll, feesUsdAll,
    volumeUsd24h, feesUsd24h,
    volumeUsd7d, feesUsd7d,
    volumeUsd30d, feesUsd30d,
    evmSwaps, solSwaps, evmVolumeUsd, solVolumeUsd,
    dailyVolumeUsd, dailyFeesUsd,
    rawVolBySymbol,
  };
}
