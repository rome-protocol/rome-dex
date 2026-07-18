// Tiers API — pure read, no signing. Fetches live reserves of EVERY fee tier of
// the A/B pair and returns per-tier quotes + the best tier for the request,
// using the same fee math as the on-chain curve (lib/quote.ts mirrors
// sdk/quote.mjs). Powers the tier-aware swap UI. All amounts in smallest unit.
import { NextResponse } from "next/server";
import { tierStates, pairDecimals, defaultPairId } from "@/lib/chain";
import { resolveChain } from "@/lib/chains/server.mjs";
import { bestTier, spotPrice, type TierState } from "@/lib/quote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tiers?amountIn=1000000&dir=AtoB&pairId=USDC-SOL   → exact-in quotes + best
// GET /api/tiers?amountOut=500000000&dir=AtoB&pairId=USDC-ETH → exact-out quotes + best
// GET /api/tiers?dir=AtoB                                     → just the tier list + spot
// pairId defaults to the default pair.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cfg = resolveChain(url.searchParams.get("chain"));
    const dir = url.searchParams.get("dir") === "BtoA" ? "BtoA" : "AtoB";
    const pairId = url.searchParams.get("pairId") || defaultPairId(cfg);
    const rawAmountIn = url.searchParams.get("amountIn");
    const rawAmountOut = url.searchParams.get("amountOut");

    const states = await tierStates(cfg, pairId);
    const dec = pairDecimals(cfg, pairId);

    // Orient reserves for `dir` (reserveIn = the token being sold).
    const oriented: (TierState & { bps: number; spotPrice: number })[] = states.map((s) => {
      const [reserveIn, reserveOut] = dir === "AtoB" ? [s.reserveA, s.reserveB] : [s.reserveB, s.reserveA];
      return {
        tier: s.tier, bps: s.bps, swapState: s.swapState, fees: s.fees,
        reserveIn, reserveOut, spotPrice: spotPrice({ reserveIn, reserveOut }),
      };
    });

    const amountIn = rawAmountIn && BigInt(rawAmountIn) > 0n ? BigInt(rawAmountIn) : undefined;
    const amountOut = rawAmountOut && BigInt(rawAmountOut) > 0n ? BigInt(rawAmountOut) : undefined;

    let bestTierLabel: string | null = null;
    let quotesOut: {
      tier: string; bps: number; swapState?: string; spotPrice: number;
      amountIn: string | null; amountOut: string | null; feePaid: string | null; isBest: boolean;
    }[] = oriented.map((o) => ({
      tier: o.tier, bps: o.bps, swapState: o.swapState, spotPrice: o.spotPrice,
      amountIn: null, amountOut: null, feePaid: null, isBest: false,
    }));

    if (amountIn != null || amountOut != null) {
      const { best, quotes } = bestTier({ amountIn, amountOut, tiers: oriented });
      bestTierLabel = best?.tier ?? null;
      quotesOut = quotes.map((q) => {
        const o = oriented.find((x) => x.tier === q.tier)!;
        return {
          tier: q.tier, bps: o.bps, swapState: q.swapState, spotPrice: o.spotPrice,
          amountIn: q.quote ? q.quote.amountIn.toString() : null,
          amountOut: q.quote ? q.quote.amountOut.toString() : null,
          feePaid: q.quote ? q.quote.feePaid.toString() : null,
          isBest: q.tier === bestTierLabel,
        };
      });
    }

    return NextResponse.json({
      pairId,
      dir,
      mode: amountOut != null ? "exactOut" : "exactIn",
      bestTier: bestTierLabel,
      tiers: quotesOut,
      decimalsA: dec.decimalsA,
      decimalsB: dec.decimalsB,
      symbolA: dec.symbolA,
      symbolB: dec.symbolB,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
