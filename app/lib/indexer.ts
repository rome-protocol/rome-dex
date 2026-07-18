// indexer.ts — server-side analytics indexer for rome-dex. Thin typed wrapper
// over the canonical scan/aggregate core (lib/indexer-core.mjs), adding live
// oracle USD pricing, per-pool TVL + APR, an in-process TTL cache (devnet pools
// are sparse — on-demand scan, no always-on daemon), and JSON-safe shaping.
//
// Every number here is derived from real on-chain data: swap volume + LP fees
// from realized tx flow, TVL from live vault reserves × oracle USD. Windows are
// honest about retention — see `truncated` / `indexedSinceBlockTime`.
import { buildTiers, poolState, type TierPool } from "./chain";
import { fetchPrices } from "./oracle";
import type { ChainConfig } from "./chains/types";
// Canonical JS core (mirrored, like sdk/quote.mjs ↔ lib/quote.ts).
import { scanPoolSwaps, aggregate } from "./indexer-core.mjs";

const TTL_MS = 45_000; // repeated /api hits within this window reuse the scan
const DAY = 86_400;

export interface PoolIndex {
  poolId: number;
  pairId: string;
  tier: string;
  bps: number;
  symbolA: string;
  symbolB: string;
  tvlUsd: number | null;
  volumeUsd24h: number;
  volumeUsd7d: number;
  volumeUsd30d: number;
  volumeUsdAll: number;
  feesUsd24h: number;
  feesUsd7d: number;
  feesUsd30d: number;
  feesUsdAll: number;
  aprPct: number | null;       // annualized fees_24h / TVL
  swapCount: number;
  evmSwaps: number;
  solSwaps: number;
  evmVolumeUsd: number;
  solVolumeUsd: number;
  dailyVolumeUsd: number[];    // 30 buckets, oldest → newest (real)
  dailyFeesUsd: number[];
  lpSupply: string;            // raw LP mint supply (for per-position share)
  indexedSinceBlockTime: number | null;
  truncated: boolean;          // history beyond the scan window exists
}

export interface AnalyticsResult {
  ok: true;
  pools: PoolIndex[];
  totals: {
    tvlUsd: number;
    volumeUsd24h: number;
    volumeUsd7d: number;
    volumeUsd30d: number;
    volumeUsdAll: number;
    feesUsd24h: number;
    feesUsd7d: number;
    feesUsd30d: number;
    feesUsdAll: number;
    swapCount: number;
  };
  dailyVolumeUsd: number[];    // protocol-wide, 30 buckets oldest → newest (real)
  dailyFeesUsd: number[];
  laneSplit: {
    evmSwaps: number;
    solSwaps: number;
    evmVolumeUsd: number;
    solVolumeUsd: number;
    evmPct: number;            // by volume; falls back to count when volume is 0
    solPct: number;
  } | null;
  indexedSinceBlockTime: number | null;
  truncated: boolean;
  generatedAt: number;
}

type PriceMap = Record<string, number | null>;

async function priceMap(cfg: ChainConfig): Promise<PriceMap> {
  const p = await fetchPrices(["USDC", "SOL", "ETH"], cfg.evmRpc, cfg.oracle.feeds);
  const out: PriceMap = {};
  for (const [k, v] of Object.entries(p)) out[k] = v?.price ?? null;
  // Wrapper aliases share the underlying feed.
  out.WUSDC = out.USDC; out.WSOL = out.SOL; out.WETH = out.ETH;
  return out;
}

function tvlOf(reserveA: string, reserveB: string, t: TierPool, prices: PriceMap): number | null {
  const pa = prices[t.symbolA ?? ""] ?? prices[t.symbols?.A ?? ""] ?? null;
  const pb = prices[t.symbolB ?? ""] ?? prices[t.symbols?.B ?? ""] ?? null;
  if (pa == null && pb == null) return null;
  const usdA = (pa ?? 0) * (Number(reserveA) / 10 ** (t.decimalsA ?? 6));
  const usdB = (pb ?? 0) * (Number(reserveB) / 10 ** (t.decimalsB ?? 9));
  return usdA + usdB;
}

interface CacheEntry { at: number; data: PoolIndex; }
// Keyed by "<chainId>:<poolId>" — poolIds are not unique across chains.
const cache = new Map<string, CacheEntry>();

/** Index one pool (cached ~45s). prices is shared across a scan pass. */
export async function indexPool(cfg: ChainConfig, t: TierPool, prices: PriceMap): Promise<PoolIndex> {
  const key = `${cfg.chainId}:${t.poolId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const [scan, state] = await Promise.all([
    scanPoolSwaps({ ...t }, { url: cfg.solanaRpc, romeEvm: cfg.romeEvmProgramId }),
    poolState(cfg, t),
  ]);
  const agg = aggregate(scan.swaps, prices);
  const tvlUsd = tvlOf(state.reserveA, state.reserveB, t, prices);
  const aprPct =
    tvlUsd != null && tvlUsd > 0 ? (agg.feesUsd24h * 365) / tvlUsd * 100 : null;

  const data: PoolIndex = {
    poolId: t.poolId,
    pairId: t.pairId,
    tier: t.tier,
    bps: t.bps,
    symbolA: state.symbolA,
    symbolB: state.symbolB,
    tvlUsd,
    volumeUsd24h: agg.volumeUsd24h,
    volumeUsd7d: agg.volumeUsd7d,
    volumeUsd30d: agg.volumeUsd30d,
    volumeUsdAll: agg.volumeUsdAll,
    feesUsd24h: agg.feesUsd24h,
    feesUsd7d: agg.feesUsd7d,
    feesUsd30d: agg.feesUsd30d,
    feesUsdAll: agg.feesUsdAll,
    aprPct,
    swapCount: agg.swapCount,
    evmSwaps: agg.evmSwaps,
    solSwaps: agg.solSwaps,
    evmVolumeUsd: agg.evmVolumeUsd,
    solVolumeUsd: agg.solVolumeUsd,
    dailyVolumeUsd: agg.dailyVolumeUsd,
    dailyFeesUsd: agg.dailyFeesUsd,
    lpSupply: state.lpSupply,
    indexedSinceBlockTime: scan.earliestBlockTime,
    truncated: scan.truncated,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Index every pool and roll up protocol totals + lane split. */
export async function indexAll(cfg: ChainConfig): Promise<AnalyticsResult> {
  const prices = await priceMap(cfg);
  const pools = await Promise.all(buildTiers(cfg).map((t) => indexPool(cfg, t, prices)));

  const totals = {
    tvlUsd: 0, volumeUsd24h: 0, volumeUsd7d: 0, volumeUsd30d: 0, volumeUsdAll: 0,
    feesUsd24h: 0, feesUsd7d: 0, feesUsd30d: 0, feesUsdAll: 0, swapCount: 0,
  };
  const dailyVolumeUsd = new Array(30).fill(0);
  const dailyFeesUsd = new Array(30).fill(0);
  let evmSwaps = 0, solSwaps = 0, evmVol = 0, solVol = 0;
  let indexedSince: number | null = null;
  let truncated = false;
  for (const p of pools) {
    totals.tvlUsd += p.tvlUsd ?? 0;
    totals.volumeUsd24h += p.volumeUsd24h;
    totals.volumeUsd7d += p.volumeUsd7d;
    totals.volumeUsd30d += p.volumeUsd30d;
    totals.volumeUsdAll += p.volumeUsdAll;
    totals.feesUsd24h += p.feesUsd24h;
    totals.feesUsd7d += p.feesUsd7d;
    totals.feesUsd30d += p.feesUsd30d;
    totals.feesUsdAll += p.feesUsdAll;
    totals.swapCount += p.swapCount;
    for (let i = 0; i < 30; i++) {
      dailyVolumeUsd[i] += p.dailyVolumeUsd[i] ?? 0;
      dailyFeesUsd[i] += p.dailyFeesUsd[i] ?? 0;
    }
    evmSwaps += p.evmSwaps; solSwaps += p.solSwaps;
    evmVol += p.evmVolumeUsd; solVol += p.solVolumeUsd;
    if (p.indexedSinceBlockTime != null)
      indexedSince = indexedSince == null ? p.indexedSinceBlockTime : Math.min(indexedSince, p.indexedSinceBlockTime);
    if (p.truncated) truncated = true;
  }

  const totalSwaps = evmSwaps + solSwaps;
  const totalVol = evmVol + solVol;
  let laneSplit: AnalyticsResult["laneSplit"] = null;
  if (totalSwaps > 0) {
    // Prefer a volume-weighted split; if all priced volume is 0, fall back to count.
    const evmPct = totalVol > 0
      ? Math.round((evmVol / totalVol) * 100)
      : Math.round((evmSwaps / totalSwaps) * 100);
    laneSplit = { evmSwaps, solSwaps, evmVolumeUsd: evmVol, solVolumeUsd: solVol, evmPct, solPct: 100 - evmPct };
  }

  return {
    ok: true,
    pools,
    totals,
    dailyVolumeUsd,
    dailyFeesUsd,
    laneSplit,
    indexedSinceBlockTime: indexedSince,
    truncated,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}

export { DAY };
