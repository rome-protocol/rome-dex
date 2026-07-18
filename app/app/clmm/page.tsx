"use client";

// CLMM screen — multi-pool. A picker over the chain's config pools PLUS pools
// created/found on this device (deduped by pool address; device pools resolve
// their tick spacing + arrays from the chain on selection). The pool card and
// the provide-a-range panel both follow the selection, so ANY pool — including
// one somebody else created — can take third-party liquidity.

import { useEffect, useMemo, useState } from "react";
import { useActiveChain } from "@/lib/chains/store";
import {
  clmmPools, fetchClmmPool, poolBandPrices, resolveDevicePool,
  type ClmmPoolState, type ClmmConfigFlat,
} from "@/lib/clmm";
import { listMyPools, MY_POOLS_CHANGED, type MyPool } from "@/lib/myPools";
import ClmmPanel from "@/components/ClmmPanel";

function fmtPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "—";
  return p < 1 ? p.toPrecision(4) : p.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function ClmmScreen() {
  const { chain } = useActiveChain();
  const configPools = useMemo(() => (chain ? clmmPools(chain) : []), [chain]);

  // Device-local created/found CLMM pools (deduped against config).
  const [devicePools, setDevicePools] = useState<MyPool[]>([]);
  useEffect(() => {
    const read = () => {
      const configKeys = new Set(configPools.map((p) => p.pool));
      setDevicePools(listMyPools().filter((p) => p.kind === "clmm" && !configKeys.has(p.pool)));
    };
    read();
    window.addEventListener(MY_POOLS_CHANGED, read);
    return () => window.removeEventListener(MY_POOLS_CHANGED, read);
  }, [configPools]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Deep link: /clmm?pool=<pda> preselects the picker (rows on /pools and the
  // created-pools "provide" chip link here). Read once on mount; keep the URL
  // in sync on manual picks so the view stays shareable.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("pool");
    if (q) setSelectedKey(q);
  }, []);
  const pick = (key: string) => {
    setSelectedKey(key);
    const u = new URL(window.location.href);
    u.searchParams.set("pool", key);
    window.history.replaceState(null, "", u.toString());
  };
  const [resolved, setResolved] = useState<ClmmConfigFlat | null>(null);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [pool, setPool] = useState<ClmmPoolState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Resolve the selection into a flat pool config: config pools are immediate;
  // device pools read spacing + tick arrays from the chain once.
  const selKey = selectedKey ?? configPools[0]?.pool ?? null;
  useEffect(() => {
    let live = true;
    setResolveErr(null);
    setPool(null);
    const cfg = configPools.find((p) => p.pool === selKey);
    if (cfg) { setResolved(cfg); return; }
    const dev = devicePools.find((p) => p.pool === selKey);
    if (!dev || !chain) { setResolved(null); return; }
    setResolved(null);
    resolveDevicePool(chain, dev)
      .then((r) => { if (live) setResolved(r); })
      .catch((e) => { if (live) setResolveErr(String(e?.message ?? e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, chain, configPools, devicePools]);

  useEffect(() => {
    if (!chain || !resolved) return;
    let live = true;
    setErr(null);
    fetchClmmPool(chain, resolved)
      .then((p) => { if (live) setPool(p); })
      .catch((e) => { if (live) setErr(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [chain, resolved]);

  // Chains without a CLMM product: hide the whole surface.
  if (chain && configPools.length === 0 && devicePools.length === 0) {
    return (
      <div className="wrap page">
        <div className="eyebrow">Concentrated liquidity</div>
        <h1>CLMM pool</h1>
        <p className="sub" style={{ color: "var(--muted)" }}>CLMM is not available on {chain.name}.</p>
      </div>
    );
  }

  const clmm = resolved;
  const band = chain && clmm ? poolBandPrices(chain, clmm) : { lower: 0, upper: 0 };
  const pair = clmm ? `${clmm.symbol0} / ${clmm.symbol1}` : "—";
  const feePct = clmm ? (clmm.feePips / 10_000).toFixed(2) : "—";
  const sym0 = clmm?.symbol0 ?? "";
  const sym1 = clmm?.symbol1 ?? "";
  const inRange = pool ? pool.liquidity > 0n : false;

  return (
    <div className="wrap page">
      <div className="sc-head">
        <div>
          <div className="eyebrow">Concentrated liquidity</div>
          <h2>CLMM pool</h2>
        </div>
        <select
          className="in"
          data-testid="clmm-pool-picker"
          value={selKey ?? ""}
          onChange={(e) => pick(e.target.value)}
          style={{ maxWidth: 320, fontSize: 15 }}
        >
          {configPools.map((p) => (
            <option key={p.pool} value={p.pool}>
              {p.symbol0} / {p.symbol1} · {(p.feePips / 10_000).toFixed(2)}%
            </option>
          ))}
          {devicePools.map((p) => (
            <option key={p.pool} value={p.pool}>
              {p.symbolA} / {p.symbolB} · {p.tier} · added on this device
            </option>
          ))}
        </select>
      </div>

      <div className="stage">
        {resolveErr && (
          <div className="note err" data-testid="clmm-resolve-err" style={{ marginBottom: 12 }}>
            This pool couldn&apos;t be read from the chain: {resolveErr}
          </div>
        )}
        <div className="action-cols">
          <ClmmPanel cfg={clmm ?? undefined} />

          <aside className="card ctx-panel" data-testid="clmm-pool-card">
            <span className="eyebrow">Pool · {pair}</span>
            <div className="kv-list">
              <div className="kv-row"><span>Current price</span><b data-testid="clmm-price">{err ? "unavailable" : pool ? `${fmtPrice(pool.price)} ${sym1}/${sym0}` : "—"}</b></div>
              <div className="kv-row"><span>Active liquidity</span><b data-testid="clmm-active" className={inRange ? "up" : ""}>{pool ? (inRange ? "In range" : "Out of range") : "—"}</b></div>
              <div className="kv-row"><span>Fee tier</span><b>{feePct}%</b></div>
              <div className="kv-row"><span>Provider band</span><b data-testid="clmm-band">{fmtPrice(band.lower)} – {fmtPrice(band.upper)}</b></div>
            </div>

            <span className="eyebrow" style={{ marginTop: 18 }}>How a range works</span>
            <p className="sub" style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.55, marginTop: 2 }}>
              Instead of spreading your tokens across every price, you choose a band. While the price stays in your
              band your liquidity is active and earns fees; outside it, it waits. A tighter band earns more per token
              but needs the price to stay close. You keep your tokens the whole time — nothing is wrapped.
            </p>
          </aside>
        </div>

        <p className="sub" style={{ color: "var(--faint)", marginTop: 20, fontSize: 13.5 }}>
          Live on {chain?.name ?? "…"} · every figure read from the pool itself.
        </p>
      </div>
    </div>
  );
}
