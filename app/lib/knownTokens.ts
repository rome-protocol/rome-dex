// knownTokens.ts — the curated token list the create-pool dropdown offers,
// derived from the active chain's live pool config (chain.dex.tiers). Users pick a
// known token OR paste any SPL mint (decimals fetched on-chain); this just
// seeds the convenient options so the common case is a dropdown, not a paste.

import type { ChainConfig } from "./chains/types";

export interface KnownToken { symbol: string; mint: string; decimals: number; }

// chains.yaml tiers carry `symbols: {A,B}` (not on the PoolTier type); read it
// loosely, falling back to the pairId split ("USDC-SOL" → USDC / SOL).
type TierRow = {
  pairId?: string;
  symbols?: { A?: string; B?: string };
  mintA?: string; mintB?: string; decimalsA?: number; decimalsB?: number;
};

/** Curated tokens for `chain`, deduped by mint, sorted by symbol. */
export function knownTokens(chain: ChainConfig): KnownToken[] {
  const by: Record<string, KnownToken> = {};
  for (const r of (chain.dex.tiers as unknown as TierRow[])) {
    const [pa, pb] = (r.pairId ?? "").split("-");
    const a = r.symbols?.A ?? pa, b = r.symbols?.B ?? pb;
    if (a && r.mintA && r.decimalsA != null) by[r.mintA] = { symbol: a, mint: r.mintA, decimals: r.decimalsA };
    if (b && r.mintB && r.decimalsB != null) by[r.mintB] = { symbol: b, mint: r.mintB, decimals: r.decimalsB };
  }
  return Object.values(by).sort((x, y) => x.symbol.localeCompare(y.symbol));
}
