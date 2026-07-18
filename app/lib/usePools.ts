"use client";

import { useEffect, useState } from "react";
import { usePrice } from "@/components/UsdValue";
import { useActiveChain } from "@/lib/chains/store";
import { rawToNum } from "./format";

export interface PoolRow {
  pairId: string;
  pairName: string;
  poolId: number;
  tier: string;
  bps: number;
  program: string;
  swapState: string;
  reserveA: string;
  reserveB: string;
  lpSupply: string;
  feesAccrued: string;
  decimalsA: number;
  decimalsB: number;
  symbolA: string;
  symbolB: string;
}

/** Fetch live per-tier pool state from /api/pools. */
export function usePools(): { pools: PoolRow[] | null; error: string | null } {
  const { chainId } = useActiveChain();
  const [pools, setPools] = useState<PoolRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!chainId) return; // wait for the active chain to resolve
      try {
        const r = await fetch(`/api/pools?chain=${chainId}`, { cache: "no-store" });
        const d = await r.json();
        if (cancelled) return;
        if (d.ok === false) setError(d.error ?? "failed to load pools");
        else setPools(d.pools as PoolRow[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [chainId]);

  return { pools, error };
}

/** Pure real-TVL from a pool + a symbol→USD price map. null if no price known. */
export function tvlUsd(pool: PoolRow, priceBySymbol: Record<string, number | null>): number | null {
  const priceA = priceBySymbol[pool.symbolA] ?? null;
  const priceB = priceBySymbol[pool.symbolB] ?? null;
  if (priceA == null && priceB == null) return null;
  const usdA = (priceA ?? 0) * rawToNum(pool.reserveA, pool.decimalsA);
  const usdB = (priceB ?? 0) * rawToNum(pool.reserveB, pool.decimalsB);
  return usdA + usdB;
}

/**
 * Real USD TVL of a pool = reserveA·priceA + reserveB·priceB, using live oracle
 * prices. Returns null while prices are loading (caller shows "—").
 */
export function usePoolTvl(pool: PoolRow | null | undefined): number | null {
  const pA = usePrice(pool?.symbolA ?? "");
  const pB = usePrice(pool?.symbolB ?? "");
  if (!pool) return null;
  const priceA = pA?.price ?? null;
  const priceB = pB?.price ?? null;
  if (priceA == null && priceB == null) return null;
  const usdA = (priceA ?? 0) * rawToNum(pool.reserveA, pool.decimalsA);
  const usdB = (priceB ?? 0) * rawToNum(pool.reserveB, pool.decimalsB);
  return usdA + usdB;
}
