"use client";

import { useEffect, useState } from "react";
import { useActiveChain } from "@/lib/chains/store";
import type { AnalyticsResult, PoolIndex } from "./indexer";

export type { AnalyticsResult, PoolIndex };

/**
 * Fetch real analytics (volume / fees / APR / lane split) from /api/analytics.
 * On-demand indexer output; polled at a relaxed cadence (the server caches ~45s).
 * Returns a poolId→PoolIndex lookup for easy per-pool joins with usePools().
 */
export function useAnalytics(): {
  data: AnalyticsResult | null;
  byPoolId: Record<number, PoolIndex>;
  error: string | null;
} {
  const { chainId } = useActiveChain();
  const [data, setData] = useState<AnalyticsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!chainId) return; // wait for the active chain to resolve
      try {
        const r = await fetch(`/api/analytics?chain=${chainId}`, { cache: "no-store" });
        const d = await r.json();
        if (cancelled) return;
        if (d.ok === false) setError(d.error ?? "failed to load analytics");
        else { setData(d as AnalyticsResult); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const id = setInterval(load, 45_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [chainId]);

  const byPoolId: Record<number, PoolIndex> = {};
  for (const p of data?.pools ?? []) byPoolId[p.poolId] = p;
  return { data, byPoolId, error };
}

/** Human "indexed since <date>" label, or null when unknown. */
export function indexedSinceLabel(blockTime: number | null | undefined): string | null {
  if (!blockTime) return null;
  const d = new Date(blockTime * 1000);
  return `indexed since ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
