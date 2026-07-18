"use client";

// UsdValue — renders a USD value next to a token amount, but ONLY when the
// token symbol has a live oracle feed. For the test A/B pool (no feed) it
// renders nothing (graceful absence) — USD lights up automatically once the
// real wUSDC/wSOL pool is active (symbols USDC/SOL → feeds exist).
//
// `usePrices` fetches /api/price?symbols=… once per symbol set and refreshes.
// Feed-less symbols come back null; UsdValue then renders null.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { feedFor } from "@/lib/oracle";
import { useActiveChain } from "@/lib/chains/store";

export interface PriceEntry {
  price: number | null;
  decimals: number | null;
  updatedAt: number | null;
  stale: boolean | null;
}
type PriceMap = Record<string, PriceEntry | null>;

const PriceContext = createContext<PriceMap>({});

// Provider: fetches USD prices for the given symbols (skips feed-less ones) and
// refreshes on an interval. Symbols with no feed are simply never fetched.
export function PriceProvider({ symbols, children }: { symbols: string[]; children: React.ReactNode }) {
  const { chain, chainId } = useActiveChain();
  const feeds = chain?.oracle.feeds ?? {};
  const [prices, setPrices] = useState<PriceMap>({});
  // Only symbols that actually map to a feed are worth fetching.
  const feedSymbols = useMemo(
    () => Array.from(new Set(symbols.filter((s) => feedFor(s, feeds) != null))),
    [symbols, feeds],
  );
  const key = feedSymbols.slice().sort().join(",");

  const load = useCallback(async () => {
    if (!key || !chainId) { setPrices({}); return; }
    try {
      const res = await fetch(`/api/price?symbols=${encodeURIComponent(key)}&chain=${chainId}`, { cache: "no-store" });
      const data = await res.json();
      if (data?.prices) setPrices(data.prices as PriceMap);
    } catch { /* leave last-known prices */ }
  }, [key, chainId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return <PriceContext.Provider value={prices}>{children}</PriceContext.Provider>;
}

export function usePrice(symbol: string): PriceEntry | null {
  const map = useContext(PriceContext);
  const { chain } = useActiveChain();
  // No feed for this symbol → no USD, ever (graceful).
  if (feedFor(symbol, chain?.oracle.feeds ?? {}) == null) return null;
  return map[symbol] ?? null;
}

// Convert a raw smallest-unit amount to a Number of whole tokens.
function rawToNumber(raw: string | bigint | null | undefined, decimals: number): number | null {
  if (raw == null || raw === "") return null;
  try {
    const n = typeof raw === "bigint" ? raw : BigInt(raw);
    return Number(n) / 10 ** decimals;
  } catch { return null; }
}

function fmtUsd(v: number): string {
  if (v === 0) return "$0.00";
  if (v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Render "$X.XX" for a token amount, or null when the symbol has no feed / no
// amount. Always carries data-testid="usd-value" when it renders.
export default function UsdValue({
  symbol,
  rawAmount,
  decimals,
  className,
}: {
  symbol: string;
  rawAmount: string | bigint | null | undefined;
  decimals: number;
  className?: string;
}) {
  const p = usePrice(symbol);
  if (!p || p.price == null) return null; // no feed or not yet loaded → nothing
  const tokens = rawToNumber(rawAmount, decimals);
  if (tokens == null) return null;
  const usd = tokens * p.price;
  return (
    <span data-testid="usd-value" className={className} title={p.stale ? "price may be stale" : undefined}>
      ≈ {fmtUsd(usd)}
    </span>
  );
}
