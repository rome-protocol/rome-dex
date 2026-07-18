// Price API — pure read, no signing. Returns live USD prices from Rome's
// Chainlink-compatible oracle feeds (lib/oracle.ts). A symbol with no feed maps
// to null (graceful: the UI shows no USD value). Powers the app's USD wiring.
// Per-chain: feeds + RPC come from the active chain config (resolveChain).
//
// Resilience: the oracle read can be slow under load, which used to hang every
// price-dependent page. We serve a short-TTL in-memory cache (keyed per chain +
// symbol) and bound each upstream read with a timeout — a slow oracle returns the
// last-known price (or null) instead of stalling the page. Helps users + e2e.
import { NextResponse } from "next/server";
import { fetchPrices } from "@/lib/oracle";
import { resolveChain } from "@/lib/chains/server.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Entry = Awaited<ReturnType<typeof fetchPrices>>[string];
const CACHE_TTL_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 4_000;
const cache = new Map<string, { v: Entry; at: number }>(); // key: `${chainId}:${symbol}`

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("price upstream timeout")), ms))]);
}

/** Resolve prices for `list` on a chain: fresh cache hits return instantly; misses
 *  go upstream (chain's evmRpc + feeds) under a timeout; a slow/failed upstream
 *  falls back to cached (even if stale) or null — never hangs. */
async function resolve(list: string[], chainId: string, evmRpc: string, feeds: Record<string, string>): Promise<Record<string, Entry>> {
  const now = Date.now();
  const out: Record<string, Entry> = {};
  const misses: string[] = [];
  for (const s of list) {
    const hit = cache.get(`${chainId}:${s}`);
    if (hit && now - hit.at < CACHE_TTL_MS) out[s] = hit.v;
    else misses.push(s);
  }
  if (misses.length) {
    try {
      const fresh = await withTimeout(fetchPrices(misses, evmRpc, feeds), UPSTREAM_TIMEOUT_MS);
      for (const s of misses) {
        const v = fresh[s] ?? null;
        cache.set(`${chainId}:${s}`, { v, at: Date.now() });
        out[s] = v;
      }
    } catch {
      // Slow/failed upstream → last-known (even if past TTL), else null. Bounded.
      for (const s of misses) out[s] = cache.get(`${chainId}:${s}`)?.v ?? null;
    }
  }
  return out;
}

// GET /api/price?symbol=SOL&chain=<chainId>           → { symbol, price, decimals, updatedAt, stale }
// GET /api/price?symbols=SOL,USDC,ETH&chain=<chainId> → { prices: { SOL: {...}|null, ... } }
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cfg = resolveChain(url.searchParams.get("chain"));
    const feeds = cfg.oracle.feeds as Record<string, string>;
    const symbol = url.searchParams.get("symbol");
    const symbols = url.searchParams.get("symbols");

    if (symbols) {
      const list = symbols.split(",").map((s) => s.trim()).filter(Boolean);
      return NextResponse.json({ prices: await resolve(list, cfg.chainId, cfg.evmRpc, feeds) });
    }

    const sym = symbol ?? "SOL";
    const p = (await resolve([sym], cfg.chainId, cfg.evmRpc, feeds))[sym];
    return NextResponse.json({ symbol: sym, ...(p ?? { price: null, decimals: null, updatedAt: null, stale: null }) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
