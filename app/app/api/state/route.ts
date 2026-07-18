import { NextResponse } from "next/server";
import { poolState } from "@/lib/chain";
import { resolveChain } from "@/lib/chains/server.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const cfg = resolveChain(new URL(req.url).searchParams.get("chain"));
    return NextResponse.json({ available: true, ...(await poolState(cfg)) });
  } catch (e: any) {
    return NextResponse.json({ available: false, error: String(e?.message || e) });
  }
}
