"use client";

import { useAnalytics, indexedSinceLabel } from "@/lib/useAnalytics";
import { fmtUsd } from "@/lib/format";
import { PairGlyphs } from "@/components/PairGlyphs";
import { AreaChartData, BarsChartData } from "@/components/Charts";

export default function AnalyticsScreen() {
  const { data, error } = useAnalytics();

  const totals = data?.totals;
  const daily = data?.dailyVolumeUsd ?? [];
  // Cumulative volume series (real) for the headline area chart.
  const cumulative = daily.reduce<number[]>((acc, v) => {
    acc.push((acc[acc.length - 1] ?? 0) + v);
    return acc;
  }, []);
  const lane = data?.laneSplit ?? null;
  const since = indexedSinceLabel(data?.indexedSinceBlockTime);
  const top = [...(data?.pools ?? [])].sort((a, b) => b.volumeUsd24h - a.volumeUsd24h);

  return (
    <div className="wrap page">
      <div className="sc-head">
        <div>
          <div className="eyebrow">Protocol</div>
          <h2>Analytics</h2>
        </div>
      </div>

      <div className="analytics-grid">
        <div className="chartcard card">
          <div className="ch-head">
            <div>
              <div className="eyebrow">Total value locked</div>
              <div className="big">{totals ? fmtUsd(totals.tvlUsd) : "—"}</div>
            </div>
            <span className="badge up">live</span>
          </div>
          <div style={{ fontSize: 13.5, color: "var(--faint)", marginTop: 2 }}>
            live on-chain value · <span style={{ color: "var(--muted)" }}>all-time traded volume below</span>
          </div>
          <AreaChartData data={cumulative} color="#B45CE6" emptyLabel="No trades yet — the curve appears once the pool has volume" />
        </div>

        <div className="chartcard card">
          <div className="eyebrow">Volume by lane · 30d</div>
          <div className="big">{totals ? fmtUsd(totals.volumeUsd30d) : "—"}</div>
          {lane ? (
            <>
              <div className="lanebar"><div className="e" style={{ width: `${lane.evmPct}%` }} /><div className="s" style={{ width: `${lane.solPct}%` }} /></div>
              <div className="legend">
                <span className="k"><span className="swatch" style={{ background: "var(--evm)" }} />◆ EVM lane {lane.evmPct}%</span>
                <span className="k"><span className="swatch" style={{ background: "var(--sol)" }} />◎ Solana lane {lane.solPct}%</span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 8 }}>No trades yet.</div>
          )}
          <div style={{ marginTop: 20 }} className="eyebrow">Fees to LPs · 30d</div>
          <div className="big" style={{ fontSize: 24 }}>{totals ? fmtUsd(totals.feesUsd30d) : "—"}</div>
          <div style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 4 }}>distributed identically to both lanes — no lane pays more.</div>
        </div>
      </div>

      <div className="chartcard card" style={{ marginBottom: 20 }}>
        <div className="eyebrow">Daily volume · 30d</div>
        <BarsChartData data={daily} color="#52A6DE" emptyLabel="No daily volume yet" />
      </div>

      <div className="card" style={{ padding: "8px 4px", overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Top pools by volume</th>
              <th className="th-right">TVL</th>
              <th className="th-right">Vol 24h</th>
              <th className="th-right">Fees 24h</th>
              <th className="th-right">EVM / SOL split</th>
            </tr>
          </thead>
          <tbody>
            {top.map((p) => {
              const laneTotal = p.evmSwaps + p.solSwaps;
              const evmPct = laneTotal > 0
                ? Math.round(((p.evmVolumeUsd + p.solVolumeUsd) > 0 ? p.evmVolumeUsd / (p.evmVolumeUsd + p.solVolumeUsd) : p.evmSwaps / laneTotal) * 100)
                : null;
              return (
                <tr key={p.poolId}>
                  <td>
                    <div className="pair">
                      <PairGlyphs a={p.symbolA} b={p.symbolB} />
                      <b>{p.symbolA} / {p.symbolB}</b> <span className="badge tier">{p.tier}</span>
                    </div>
                  </td>
                  <td className="r-right num">{p.tvlUsd == null ? "—" : fmtUsd(p.tvlUsd)}</td>
                  <td className="r-right num">{fmtUsd(p.volumeUsd24h)}</td>
                  <td className="r-right num">{fmtUsd(p.feesUsd24h)}</td>
                  <td className="r-right">
                    {evmPct == null
                      ? <span style={{ color: "var(--muted)" }}>—</span>
                      : <><span className="badge evm">{evmPct}%</span> <span className="badge sol">{100 - evmPct}%</span></>}
                  </td>
                </tr>
              );
            })}
            {!data && !error && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>Loading trades…</td></tr>}
            {error && <tr><td colSpan={5} style={{ color: "var(--down)" }}>Could not load analytics: {error}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="provenance">
        <b>Data provenance.</b>{" "}
        <span className="live">All figures are live on-chain</span> — value, volume, fees and the 30-day history come from real trades on the pool; the EVM/Solana split reflects where each trade actually came from.{" "}
        {(since || data?.truncated) && (
          <span className="warn">{since ?? "windowed"}{data?.truncated ? " · history truncated to the most recent scan window" : ""}</span>
        )}
      </div>
    </div>
  );
}
