"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import CreatePoolPanel from "@/components/CreatePoolPanel";
import CreateClmmPoolPanel from "@/components/CreateClmmPoolPanel";
import MyPoolsSection from "@/components/MyPoolsSection";
import FindPoolPanel from "@/components/FindPoolPanel";
import { usePrice } from "@/components/UsdValue";
import { usePools, tvlUsd, type PoolRow } from "@/lib/usePools";
import { useAnalytics, indexedSinceLabel, type PoolIndex } from "@/lib/useAnalytics";
import { useActiveChain } from "@/lib/chains/store";
import { clmmPools, type ClmmConfigFlat } from "@/lib/clmm";
import { ataBalance } from "@/lib/balances";
import { PublicKey } from "@solana/web3.js";
import { rawToNum, fmtUsd, fmtPct } from "@/lib/format";
import { PairGlyphs } from "@/components/PairGlyphs";
import { SparklineData } from "@/components/Charts";

function usePriceMap(): Record<string, number | null> {
  const usdc = usePrice("USDC")?.price ?? null;
  const sol = usePrice("SOL")?.price ?? null;
  const eth = usePrice("ETH")?.price ?? null;
  return { USDC: usdc, SOL: sol, ETH: eth, WSOL: sol, WUSDC: usdc, WETH: eth };
}

/** The chain's concentrated pools + live vault-read TVL (USD when both symbols
 *  have a price feed; null otherwise — shown as "—", never a fake number). */
function useClmmRows(prices: Record<string, number | null>) {
  const { chain } = useActiveChain();
  const cfgs = useMemo(() => (chain ? clmmPools(chain) : []), [chain]);
  const [tvls, setTvls] = useState<Record<string, number | null>>({});
  const p0 = prices[cfgs[0]?.symbol0 ?? ""] ?? null;
  useEffect(() => {
    if (!chain || cfgs.length === 0) return;
    let live = true;
    (async () => {
      const out: Record<string, number | null> = {};
      for (const c of cfgs) {
        const [b0, b1] = await Promise.all([
          ataBalance(chain.solanaRpc, new PublicKey(c.vault0)),
          ataBalance(chain.solanaRpc, new PublicKey(c.vault1)),
        ]);
        const pr0 = prices[c.symbol0] ?? null, pr1 = prices[c.symbol1] ?? null;
        out[c.pool] = pr0 != null && pr1 != null
          ? rawToNum(b0, c.decimals0) * pr0 + rawToNum(b1, c.decimals1) * pr1
          : null;
      }
      if (live) setTvls(out);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, cfgs, p0]);
  return { cfgs, tvls };
}

export default function PoolsScreen() {
  const { pools, error } = usePools();
  const prices = usePriceMap();
  const { data: analytics, byPoolId } = useAnalytics();
  const { cfgs: clmmCfgs, tvls: clmmTvls } = useClmmRows(prices);

  const rows = (pools ?? []).map((p) => ({ p, tvl: tvlUsd(p, prices), a: byPoolId[p.poolId] }));

  const totalTvl = rows.reduce((s, r) => s + (r.tvl ?? 0), 0);
  const anyTvl = rows.some((r) => r.tvl != null);
  const totalVol = analytics?.totals.volumeUsd24h ?? 0;
  const totalFees = analytics?.totals.feesUsd24h ?? 0;
  const pairCount = new Set((pools ?? []).map((p) => p.pairId)).size;
  const since = indexedSinceLabel(analytics?.indexedSinceBlockTime);
  const [creating, setCreating] = useState(false);
  const [poolType, setPoolType] = useState<"simple" | "concentrated" | null>(null);
  const [finding, setFinding] = useState(false);
  const closeCreate = () => { setCreating(false); setPoolType(null); };

  return (
    <div className="wrap page">
      <div className="sc-head">
        <div>
          <div className="eyebrow">Liquidity</div>
          <h2>Pools</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" data-testid="find-pool-toggle" aria-pressed={finding} onClick={() => { setFinding((v) => !v); closeCreate(); }}>
            {finding ? "Close" : "Find a pool"}
          </button>
          <button className="btn ghost" data-testid="create-pool-toggle" aria-pressed={creating} onClick={() => { creating ? closeCreate() : setCreating(true); setFinding(false); }}>
            {creating ? "Close" : "+ Create pool"}
          </button>
          <Link className="btn ghost" href="/pools/30">+ Add liquidity</Link>
        </div>
      </div>

      {finding && (
        <div style={{ marginBottom: 22, display: "flex", justifyContent: "center" }}>
          <FindPoolPanel onFound={() => setFinding(false)} />
        </div>
      )}

      {creating && !poolType && (
        <div className="stage" style={{ marginBottom: 22 }} data-testid="create-pool-chooser">
          <div className="eyebrow" style={{ marginBottom: 4 }}>Create pool</div>
          <p className="sub" style={{ marginBottom: 16 }}>What kind of liquidity pool would you like to create?</p>
          <button className="card" data-testid="choose-simple" onClick={() => setPoolType("simple")}
            style={{ width: "100%", textAlign: "left", cursor: "pointer", marginBottom: 14, border: "1px solid var(--line)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <b style={{ fontSize: 18 }}>Simple pool</b><span style={{ color: "var(--bridge)" }}>→</span>
            </div>
            <div className="sub" style={{ marginTop: 6 }}>The fastest way to make two tokens tradable. One even price across the whole range. <b style={{ color: "var(--ink)" }}>Best for new tokens.</b></div>
          </button>
          <button className="card" data-testid="choose-concentrated" onClick={() => setPoolType("concentrated")}
            style={{ width: "100%", textAlign: "left", cursor: "pointer", border: "1px solid var(--line)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <b style={{ fontSize: 18 }}>Concentrated pool</b><span style={{ color: "var(--bridge)" }}>→</span>
            </div>
            <div className="sub" style={{ marginTop: 6 }}>Set a price band so liquidity earns more where it trades. Works from an EVM or Solana wallet. <b style={{ color: "var(--ink)" }}>Best for experienced LPs.</b></div>
          </button>
        </div>
      )}

      {creating && poolType === "simple" && (
        <div style={{ marginBottom: 22, display: "flex", justifyContent: "center" }}>
          <CreatePoolPanel onBack={() => setPoolType(null)} />
        </div>
      )}
      {creating && poolType === "concentrated" && (
        <div style={{ marginBottom: 22, display: "flex", justifyContent: "center" }}>
          <CreateClmmPoolPanel onBack={() => setPoolType(null)} />
        </div>
      )}

      <MyPoolsSection />

      <div className="stats">
        <div className="stat card">
          <div className="k">Total value locked</div>
          <div className="v">{anyTvl ? fmtUsd(totalTvl) : "—"}</div>
          <div className="sub" style={{ color: "var(--muted)" }}>live on-chain value</div>
        </div>
        <div className="stat card">
          <div className="k">Volume · 24h</div>
          <div className="v">{analytics ? fmtUsd(totalVol) : "—"}</div>
          <div className="sub" style={{ color: "var(--muted)" }}>from real trades</div>
        </div>
        <div className="stat card">
          <div className="k">Fees · 24h</div>
          <div className="v">{analytics ? fmtUsd(totalFees) : "—"}</div>
          <div className="sub" style={{ color: "var(--muted)" }}>earned by liquidity providers</div>
        </div>
        <div className="stat card">
          <div className="k">Pools</div>
          <div className="v">{pools ? pools.length : "—"}</div>
          <div className="sub" style={{ color: "var(--muted)" }}>{pairCount} pair{pairCount === 1 ? "" : "s"} · {pools?.length ?? 0} pools</div>
        </div>
      </div>

      <div className="card" style={{ padding: "8px 4px", overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Pool</th>
              <th>Fee</th>
              <th>Access</th>
              <th className="th-right">TVL</th>
              <th className="th-right">Volume 24h</th>
              <th className="th-right">APR</th>
              <th className="th-right">7d</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, tvl, a }) => (
              <PoolRowView key={p.poolId} p={p} tvl={tvl} a={a} />
            ))}
            {clmmCfgs.map((c) => (
              <ClmmRowView key={c.pool} c={c} tvl={clmmTvls[c.pool] ?? null} />
            ))}
            {!pools && !error && (
              <tr><td colSpan={7} style={{ color: "var(--muted)" }}>Loading live pools…</td></tr>
            )}
            {error && (
              <tr><td colSpan={7} style={{ color: "var(--down)" }}>Could not load pools: {error}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="provenance">
        <b>Data provenance.</b>{" "}
        <span className="live">All figures are live on-chain</span> — value, volume, fees and APR come from the pool itself and its real trades; nothing here is simulated.{" "}
        {since && <span className="warn">{since}</span>}
      </div>
    </div>
  );
}

// A concentrated pool row: liquidity lives in price bands on /clmm, so the row
// links there with the pool preselected. TVL is a live vault read; volume/APR
// aren't indexed for concentrated pools yet — shown as "—", never simulated.
function ClmmRowView({ c, tvl }: { c: ClmmConfigFlat; tvl: number | null }) {
  return (
    <tr className="clickable" data-testid="clmm-pool-row" onClick={() => (window.location.href = `/clmm?pool=${c.pool}`)}>
      <td>
        <div className="pair">
          <PairGlyphs a={c.symbol0} b={c.symbol1} />
          <b>{c.symbol0} / {c.symbol1}</b>
        </div>
      </td>
      <td><span className="badge tier">{(c.feePips / 10_000).toFixed(2)}% · concentrated</span></td>
      <td><span className="badge dual">◆ ⇄ ◎ dual-lane</span></td>
      <td className="r-right num" data-testid="clmm-row-tvl">{tvl == null ? "—" : fmtUsd(tvl)}</td>
      <td className="r-right num">—</td>
      <td className="r-right num">—</td>
      <td className="r-right"><span style={{ color: "var(--muted)" }}>provide →</span></td>
    </tr>
  );
}

function PoolRowView({ p, tvl, a }: { p: PoolRow; tvl: number | null; a: PoolIndex | undefined }) {
  const vol = a?.volumeUsd24h ?? null;
  const apr = a?.aprPct ?? null;
  const spark7d = (a?.dailyVolumeUsd ?? []).slice(-7);
  return (
    <tr className="clickable" data-testid="pool-row" onClick={() => (window.location.href = `/pools/${p.poolId}`)}>
      <td>
        <div className="pair">
          <PairGlyphs a={p.symbolA} b={p.symbolB} />
          <b>{p.symbolA} / {p.symbolB}</b>
        </div>
      </td>
      <td><span className="badge tier">{p.tier}</span></td>
      <td><span className="badge dual">◆ ⇄ ◎ dual-lane</span></td>
      <td className="r-right num">{tvl == null ? "—" : fmtUsd(tvl)}</td>
      <td className="r-right num">{vol == null ? "—" : fmtUsd(vol)}</td>
      <td className="r-right num">{apr == null ? "—" : fmtPct(apr)}</td>
      <td className="r-right">{spark7d.length ? <SparklineData data={spark7d} /> : <span style={{ color: "var(--muted)" }}>—</span>}</td>
    </tr>
  );
}
