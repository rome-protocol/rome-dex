"use client";

// MyPoolsSection — "Pools you created" on /pools. Created pools aren't in the
// static list and can't be RPC-scanned (getProgramAccounts throttled), so we list
// them from the local registry (lib/myPools.ts) and read each one's live reserves
// client-side to confirm it's real + funded. Renders nothing if you've created none.

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { explorerUrl } from "@/lib/explorer";
import { rawToNum } from "@/lib/format";
import { PairGlyphs } from "@/components/PairGlyphs";
import { listMyPools, readMyPoolState, removeMyPool, MY_POOLS_CHANGED, type MyPool } from "@/lib/myPools";
import { useActiveChain } from "@/lib/chains/store";
import TradeMyPool from "@/components/TradeMyPool";

interface Row { p: MyPool; reserveA: bigint; reserveB: bigint; loading: boolean; }

export default function MyPoolsSection() {
  const { chain } = useActiveChain();
  const solanaRpc = chain?.solanaRpc;
  const [rows, setRows] = useState<Row[]>([]);
  const [tradingPool, setTradingPool] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const mine = listMyPools();
      setRows(mine.map((p) => ({ p, reserveA: 0n, reserveB: 0n, loading: true })));
      if (!solanaRpc) return;
      (async () => {
        for (const p of mine) {
          const s = await readMyPoolState(p, solanaRpc).catch(() => ({ reserveA: 0n, reserveB: 0n }));
          if (cancelled) return;
          setRows((prev) => prev.map((r) => (r.p.pool === p.pool ? { ...r, ...s, loading: false } : r)));
        }
      })();
    };
    load();
    // Re-read when a pool is created / found / forgotten anywhere in the app.
    window.addEventListener(MY_POOLS_CHANGED, load);
    return () => { cancelled = true; window.removeEventListener(MY_POOLS_CHANGED, load); };
  }, [solanaRpc]);

  if (rows.length === 0) return null;

  const forget = (pool: string) => setRows(() => removeMyPool(pool).map((p) => ({ p, reserveA: 0n, reserveB: 0n, loading: true })));

  return (
    <div style={{ marginBottom: 22 }} data-testid="my-pools">
      <div className="rowhead" style={{ marginBottom: 10 }}>
        <span className="eyebrow">Pools you created</span>
        <span className="side mono" style={{ color: "var(--faint)" }}>on this device</span>
      </div>
      <div className="card" style={{ padding: "6px 4px", overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Pool</th><th>Type</th><th>Fee</th>
              <th className="th-right">Reserves</th><th className="th-right">Created</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, reserveA, reserveB, loading }) => (
              <Fragment key={p.pool}>
              <tr data-testid="my-pool-row">
                <td>
                  <div className="pair">
                    <PairGlyphs a={p.symbolA} b={p.symbolB} />
                    <b>{p.symbolA} / {p.symbolB}</b>
                  </div>
                </td>
                <td><span className="badge">{p.kind === "clmm" ? "Concentrated" : "Simple"}</span></td>
                <td><span className="badge tier">{p.tier}</span></td>
                <td className="r-right num">
                  {loading ? "…" : `${rawToNum(reserveA.toString(), p.decimalsA).toLocaleString(undefined, { maximumFractionDigits: 4 })} / ${rawToNum(reserveB.toString(), p.decimalsB).toLocaleString(undefined, { maximumFractionDigits: 4 })}`}
                </td>
                <td className="r-right">
                  {p.createdSig
                    ? <Link href={chain ? explorerUrl(p.createdSig, chain) : "#"} target="_blank" rel="noopener noreferrer" style={{ color: "var(--bridge)" }}>view tx ↗</Link>
                    : <span style={{ color: "var(--muted)" }}>—</span>}
                </td>
                <td className="r-right" style={{ whiteSpace: "nowrap" }}>
                  {p.kind === "clmm" && (
                    <Link className="chip" data-testid="my-pool-provide" style={{ marginRight: 6 }}
                      href={`/clmm?pool=${p.pool}`} title="Open the range screen with this pool selected">
                      provide
                    </Link>
                  )}
                  <button className="chip" data-testid="my-pool-trade" style={{ marginRight: 6 }}
                    aria-pressed={tradingPool === p.pool}
                    onClick={() => setTradingPool((cur) => (cur === p.pool ? null : p.pool))}>
                    {tradingPool === p.pool ? "close" : "trade"}
                  </button>
                  <button className="chip" data-testid="my-pool-forget" title="Remove from this list (doesn't touch the pool)" onClick={() => forget(p.pool)}>forget</button>
                </td>
              </tr>
              {tradingPool === p.pool && (
                <tr data-testid="my-pool-trade-row">
                  <td colSpan={6} style={{ background: "var(--panel-2)" }}>
                    <TradeMyPool entry={p} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sub" style={{ marginTop: 8 }}>
        Live from chain. This list is stored on your device — a pool created elsewhere won&apos;t appear here.
      </div>
    </div>
  );
}
