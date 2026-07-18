// Pools API — pure read, no signing. Returns live on-chain state for EVERY fee
// tier of the active chain's pairs (reserves, LP supply, accrued fees) so the
// Pools / Pool detail / Positions / Analytics screens can compute REAL TVL
// (reserves × oracle USD, done client-side). Realized volume / fees / APR /
// history come from the on-demand indexer at /api/analytics (lib/indexer.ts).
import { NextResponse } from "next/server";
import { buildTiers, poolState } from "@/lib/chain";
import { resolveChain } from "@/lib/chains/server.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const cfg = resolveChain(new URL(req.url).searchParams.get("chain"));
    const pools = await Promise.all(
      buildTiers(cfg).map(async (t) => {
        const s = await poolState(cfg, t);
        return {
          pairId: s.pairId,
          pairName: s.pairName,
          poolId: s.poolId,
          tier: t.tier,
          bps: t.bps,
          program: s.program,
          swapState: s.swapState,
          reserveA: s.reserveA,
          reserveB: s.reserveB,
          lpSupply: s.lpSupply,
          feesAccrued: s.feesAccrued,
          decimalsA: s.decimalsA,
          decimalsB: s.decimalsB,
          symbolA: s.symbolA,
          symbolB: s.symbolB,
        };
      }),
    );
    return NextResponse.json({ ok: true, pools });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
