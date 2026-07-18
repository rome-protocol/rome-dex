// Analytics API — pure read, no signing. Returns REAL protocol metrics derived
// on demand from on-chain data: TVL (live vault reserves × oracle USD), realized
// swap volume + LP fees per window (24h / 7d / all-time) from the tx-history
// indexer, per-pool APR (annualized fees_24h / TVL), and the EVM/Solana lane
// split (derived from tx origination: Solana-lane = direct dex ix; EVM-lane = dex
// ix nested under the rome-evm CPI). Cached in-process ~45s so repeated hits
// don't re-scan. Windows are retention-honest via indexedSinceBlockTime.
import { NextResponse } from "next/server";
import { indexAll } from "@/lib/indexer";
import { resolveChain } from "@/lib/chains/server.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const cfg = resolveChain(new URL(req.url).searchParams.get("chain"));
    const data = await indexAll(cfg);
    return NextResponse.json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
