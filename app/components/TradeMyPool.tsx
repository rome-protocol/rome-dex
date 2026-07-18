"use client";

// TradeMyPool — a focused swap for a SIMPLE pool you created, shown inline on its
// /pools row. The main swap card is static (can't see a device-local pool), so we
// trade this one directly: client-side quote (lib/quote.ts) + direct execution
// (Solana ix / EVM direct-CPI, no router) via lib/myPoolTrade.ts. Dual-lane.
// CLMM created pools aren't tradable here (tick-array swap path is separate).

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { explorerUrl } from "@/lib/explorer";
import { toTxStatus } from "@/lib/txerror";
import { quoteMyPool, tradeMyPool, type TradeQuote } from "@/lib/myPoolTrade";
import { quoteClmmMyPool, tradeClmmMyPool } from "@/lib/clmmPoolTrade";
import type { MyPool } from "@/lib/myPools";

type Status = { kind: "ok" | "err" | "cancelled" | "pending"; msg: string; tx?: string } | null;

const toRaw = (human: string, dec: number): bigint => {
  const [w, f = ""] = human.trim().split(".");
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f)) return 0n;
  return BigInt((w || "0") + (f + "0".repeat(dec)).slice(0, dec) || "0");
};
const fmtRaw = (raw: bigint, dec: number, places = 4): string => {
  const s = raw.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, -dec) || "0";
  const frac = s.slice(-dec).slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

export default function TradeMyPool({ entry }: { entry: MyPool }) {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const lane: "evm" | "solana" | null = wallet.evm ? "evm" : wallet.solana ? "solana" : null;
  const [dir, setDir] = useState<"AtoB" | "BtoA">("AtoB");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [status, setStatus] = useState<Status>(null);

  const [symIn, symOut] = dir === "AtoB" ? [entry.symbolA, entry.symbolB] : [entry.symbolB, entry.symbolA];
  const [decIn, decOut] = dir === "AtoB" ? [entry.decimalsA, entry.decimalsB] : [entry.decimalsB, entry.decimalsA];
  const raw = toRaw(amount, decIn);

  const quoteFn = entry.kind === "clmm" ? quoteClmmMyPool : quoteMyPool;
  const tradeFn = entry.kind === "clmm" ? tradeClmmMyPool : tradeMyPool;

  // Live quote (debounced) whenever the amount or direction changes.
  useEffect(() => {
    if (raw <= 0n || !chain) { setQuote(null); return; }
    let live = true;
    const t = setTimeout(() => {
      quoteFn(chain, entry, dir, raw).then((q) => { if (live) setQuote(q); }).catch(() => { if (live) setQuote(null); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [chain, entry, dir, raw, quoteFn]);

  const busy = status?.kind === "pending";
  const canTrade = !!chain && !!lane && raw > 0n && !!quote && quote.amountOut > 0n && !busy;

  const onTrade = useCallback(async () => {
    if (!canTrade || !chain || !lane || !quote) return;
    setStatus({ kind: "pending", msg: "Confirm in your wallet…" });
    try {
      const addr = lane === "solana" ? wallet.solana! : wallet.evm!;
      const tx = await tradeFn(chain, entry, lane, addr, dir, raw, quote.minOut);
      setStatus({ kind: "ok", msg: `Swapped ${amount} ${symIn} → ~${fmtRaw(quote.amountOut, decOut)} ${symOut}`, tx });
      setAmount(""); setQuote(null);
    } catch (e: unknown) {
      const { cancelled, message } = toTxStatus(e);
      setStatus({ kind: cancelled ? "cancelled" : "err", msg: message });
    }
  }, [canTrade, chain, lane, quote, wallet, entry, dir, raw, amount, symIn, symOut, decOut, tradeFn]);

  return (
    <div data-testid="trade-my-pool" style={{ padding: "6px 2px" }}>
      <div className="rowhead" style={{ marginBottom: 6 }}>
        <span className="side">Trade this pool</span>
        <button className="chip" data-testid="trade-flip" onClick={() => { setDir((d) => (d === "AtoB" ? "BtoA" : "AtoB")); setQuote(null); }}>
          {symIn} → {symOut} ⇅
        </button>
      </div>
      <div className="tokenrow">
        <div className="mid">
          <input className="amt" data-testid="trade-amount" inputMode="decimal" placeholder="0.0" value={amount}
            onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setStatus(null); }} style={{ fontSize: 20 }} />
          <span className="tselect">{symIn}</span>
        </div>
      </div>
      {quote && raw > 0n && (
        <div className="sub" data-testid="trade-quote" style={{ marginTop: 6 }}>
          ≈ {fmtRaw(quote.amountOut, decOut)} {symOut} · min {fmtRaw(quote.minOut, decOut)} (0.5% slippage)
        </div>
      )}
      <button className="btn block" data-testid="trade-btn" style={{ marginTop: 10 }} onClick={onTrade} disabled={!canTrade}>
        {!lane ? "Connect wallet" : busy ? "Swapping…" : !raw ? "Enter an amount" : !quote?.amountOut ? "No liquidity" : `Swap ${symIn} → ${symOut}`}
      </button>
      {status && status.kind !== "pending" && (
        <div className={`note ${status.kind}`} data-testid="trade-status" style={{ marginTop: 10 }}>
          {status.msg}
          {status.kind === "ok" && status.tx && chain && <> · <a href={explorerUrl(status.tx, chain)} target="_blank" rel="noopener noreferrer">view tx ↗</a></>}
        </div>
      )}
    </div>
  );
}
