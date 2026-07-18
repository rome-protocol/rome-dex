"use client";

import { use } from "react";
import Link from "next/link";
import { usePools, usePoolTvl, type PoolRow } from "@/lib/usePools";
import { useAnalytics, indexedSinceLabel } from "@/lib/useAnalytics";
import { fmtUsd, fmtPct, fmtCompact, rawToNum } from "@/lib/format";
import { PairGlyphs } from "@/components/PairGlyphs";
import { AreaChartData } from "@/components/Charts";
import LiquidityPanel from "@/components/LiquidityPanel";

export default function PoolDetailScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { pools, error } = usePools();
  const pool = pools?.find((p) => String(p.poolId) === id);

  if (error) return <Msg text={`Could not load pool: ${error}`} err />;
  if (!pools) return <Msg text="Loading live pool…" />;
  if (!pool) return <Msg text={`No pool for tier id "${id}".`} err />;

  return <Detail pool={pool} />;
}

function Detail({ pool }: { pool: PoolRow }) {
  const tvl = usePoolTvl(pool);
  const { byPoolId } = useAnalytics();
  const a = byPoolId[pool.poolId];
  const daily = a?.dailyVolumeUsd ?? [];
  const since = indexedSinceLabel(a?.indexedSinceBlockTime);

  return (
    <div className="wrap page">
      <div className="sc-head">
        <div>
          <div className="eyebrow"><Link href="/pools">← Pools</Link></div>
          <h2 style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <PairGlyphs a={pool.symbolA} b={pool.symbolB} />
            {pool.symbolA} / {pool.symbolB}
            <span className="badge tier">{pool.tier}</span>
            <span className="badge dual">◆ ⇄ ◎ dual-lane</span>
          </h2>
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="chartcard card" data-testid="pool-chart">
            <div className="ch-head">
              <div>
                <div className="eyebrow">Daily volume · 30d</div>
                <div className="big">{a ? fmtUsd(a.volumeUsd30d) : "—"} <span style={{ fontSize: 13.5, color: "var(--muted)" }}>· spot {tvl == null ? "—" : fmtCompact(spot(pool))} {pool.symbolA}/{pool.symbolB}</span></div>
              </div>
            </div>
            <AreaChartData data={daily} color="#B45CE6" emptyLabel="No trades yet — the chart fills in as this pool trades" />
          </div>

          <div className="kv" style={{ marginTop: 16 }}>
            <Cell k="TVL" v={tvl == null ? "—" : fmtUsd(tvl)} live />
            <Cell k="Volume · 24h" v={a ? fmtUsd(a.volumeUsd24h) : "—"} />
            <Cell k="Fees · 24h" v={a ? fmtUsd(a.feesUsd24h) : "—"} />
            <Cell k="APR" v={a?.aprPct == null ? "—" : fmtPct(a.aprPct)} />
            <Cell k={`Reserve ${pool.symbolA}`} v={fmtCompact(rawToNum(pool.reserveA, pool.decimalsA))} live />
            <Cell k={`Reserve ${pool.symbolB}`} v={fmtCompact(rawToNum(pool.reserveB, pool.decimalsB))} live />
          </div>
        </div>

        <LiquidityPanel pool={pool} />
      </div>

      <div className="provenance">
        <b>Data provenance.</b>{" "}
        <span className="live">Live on-chain</span> — value, volume, fees and APR come from the pool itself and its real trades.{" "}
        {since && <span className="warn">{since}</span>}
      </div>
    </div>
  );
}

function spot(pool: PoolRow): number {
  const a = rawToNum(pool.reserveA, pool.decimalsA);
  const b = rawToNum(pool.reserveB, pool.decimalsB);
  return b === 0 ? 0 : a / b; // price of B in A (e.g. USDC per SOL)
}

function Cell({ k, v, live, up }: { k: string; v: string; live?: boolean; up?: boolean }) {
  return (
    <div className="c">
      <div className="k">{k}</div>
      <div className={`v ${up ? "up" : ""}`}>{v}{live && <span style={{ fontSize: 13.5, color: "var(--up)", marginLeft: 6 }}>● live</span>}</div>
    </div>
  );
}

function Msg({ text, err }: { text: string; err?: boolean }) {
  return (
    <div className="wrap page">
      <div style={{ color: err ? "var(--down)" : "var(--muted)" }}>{text}</div>
      <div style={{ marginTop: 12 }}><Link href="/pools" className="badge tier">← Back to pools</Link></div>
    </div>
  );
}
