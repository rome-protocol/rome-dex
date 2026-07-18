// Quote API — pure read, no signing. Fetches live reserves from the pool and
// returns exact-in AND exact-out quotes using the same fee math as the on-chain
// curve (lib/quote.ts mirrors sdk/quote.mjs). All amounts in smallest token unit.
import { NextResponse } from "next/server";
import { poolState } from "@/lib/chain";
import { resolveChain } from "@/lib/chains/server.mjs";
import { quoteExactIn, quoteExactOut, spotPrice } from "@/lib/quote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/quote?amountIn=1000000&dir=AtoB   → exact-in quote
// GET /api/quote?amountOut=500000000&dir=AtoB → exact-out quote
// dir: "AtoB" (default) or "BtoA"
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dir = url.searchParams.get("dir") ?? "AtoB";
    const rawAmountIn = url.searchParams.get("amountIn");
    const rawAmountOut = url.searchParams.get("amountOut");

    const cfg = resolveChain(url.searchParams.get("chain"));
    const state = await poolState(cfg);
    const rA = BigInt(state.reserveA);
    const rB = BigInt(state.reserveB);
    const [reserveIn, reserveOut] = dir === "AtoB" ? [rA, rB] : [rB, rA];
    const spot = spotPrice({ reserveIn, reserveOut });

    let exactIn: object | null = null;
    let exactOut: object | null = null;

    if (rawAmountIn) {
      const amountIn = BigInt(rawAmountIn);
      if (amountIn > 0n) {
        const q = quoteExactIn({ amountIn, reserveIn, reserveOut });
        const impact = amountIn === 0n ? 0 : Math.max(0, (1 - q.price / spot) * 100);
        const minReceived = (q.amountOut * 995n) / 1000n;
        exactIn = {
          amountIn: q.amountIn.toString(),
          amountOut: q.amountOut.toString(),
          tradeFee: q.tradeFee.toString(),
          ownerFee: q.ownerFee.toString(),
          feePaid: q.feePaid.toString(),
          price: q.price,
          priceImpactPct: impact,
          minReceived: minReceived.toString(),
        };
      }
    }

    if (rawAmountOut) {
      const amountOut = BigInt(rawAmountOut);
      if (amountOut > 0n) {
        const q = quoteExactOut({ amountOut, reserveIn, reserveOut });
        if (q) {
          // impact: how much more expensive than spot?
          const execRate = Number(q.amountIn) / Number(q.amountOut);
          const impact = Math.max(0, (execRate / spot - 1) * 100);
          const maxSold = (q.amountIn * 1005n) / 1000n;
          exactOut = {
            amountIn: q.amountIn.toString(),
            amountOut: q.amountOut.toString(),
            tradeFee: q.tradeFee.toString(),
            ownerFee: q.ownerFee.toString(),
            feePaid: q.feePaid.toString(),
            price: q.price,
            priceImpactPct: impact,
            maxSold: maxSold.toString(),
          };
        }
      }
    }

    return NextResponse.json({
      dir,
      spotPrice: spot,
      reserveA: state.reserveA,
      reserveB: state.reserveB,
      decimalsA: state.decimalsA,
      decimalsB: state.decimalsB,
      exactIn,
      exactOut,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
