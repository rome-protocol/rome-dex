"use client";

import { useCallback, useEffect, useState } from "react";
import UsdValue from "./UsdValue";
import { useActiveChain } from "@/lib/chains/store";
import { poolSymbols } from "@/lib/walletActions";

type PoolData = {
  reserveA: string; reserveB: string; lpSupply: string; feesAccrued: string;
  decimalsA: number; decimalsB: number; available: boolean;
  symbolA?: string; symbolB?: string;
};

function fmtRaw(raw: string | undefined, dec: number, maxFrac = 4): string {
  if (!raw) return "—";
  try {
    const n = BigInt(raw);
    const base = 10n ** BigInt(dec);
    const whole = n / base;
    const frac = (n % base).toString().padStart(dec, "0").slice(0, maxFrac).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch { return "—"; }
}

export default function PoolView() {
  const { chain } = useActiveChain();
  const [data, setData] = useState<PoolData | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      setData(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const live = Boolean(data?.available);
  const syms = chain ? poolSymbols(chain) : { A: "A", B: "B" };
  const symA = data?.symbolA ?? syms.A;
  const symB = data?.symbolB ?? syms.B;

  return (
    <div className="card dark interactive" data-testid="pool-card">
      <p className="label">
        <span>Pool · {symA.length <= 2 ? `Token ${symA}` : symA} / {symB.length <= 2 ? `Token ${symB}` : symB} · 0.30%</span>
        <span className="mono" style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 5 }}>
          <span
            data-testid="pool-status-dot"
            className={live ? "live-dot" : ""}
            style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              background: live ? "#2faa6a" : "rgba(251,248,244,.3)",
              display: "inline-block",
            }}
          />
          <span data-testid="pool-status-label">{live ? "live" : "connecting"}</span>
        </span>
      </p>

      <div className="pool-stat-grid">
        <div className="pool-stat-cell">
          <div className="k">Reserve {symA}</div>
          <div className="v" data-testid="reserve-a">{fmtRaw(data?.reserveA, data?.decimalsA ?? 6)}<small> {symA}</small></div>
          <div style={{ fontSize: 13.5, color: "var(--fg3)" }}>
            <UsdValue symbol={symA} rawAmount={data?.reserveA} decimals={data?.decimalsA ?? 6} />
          </div>
        </div>
        <div className="pool-stat-cell">
          <div className="k">Reserve {symB}</div>
          <div className="v" data-testid="reserve-b">{fmtRaw(data?.reserveB, data?.decimalsB ?? 9)}<small> {symB}</small></div>
          <div style={{ fontSize: 13.5, color: "var(--fg3)" }}>
            <UsdValue symbol={symB} rawAmount={data?.reserveB} decimals={data?.decimalsB ?? 9} />
          </div>
        </div>
        <div className="pool-stat-cell">
          <div className="k">LP supply</div>
          <div className="v" data-testid="lp-supply">{fmtRaw(data?.lpSupply, 6)}<small> LP</small></div>
        </div>
        <div className="pool-stat-cell">
          <div className="k">Fees accrued</div>
          <div className="v" data-testid="fees-accrued" style={{ color: "#5fcc8a" }}>{fmtRaw(data?.feesAccrued, 6)}<small> LP</small></div>
        </div>
      </div>
    </div>
  );
}
