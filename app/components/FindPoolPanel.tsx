"use client";

// FindPoolPanel — find a pool NOT created on this device and add it to your list
// (then it's tradable via the inline trade panel). Pools are deterministic PDAs,
// so we derive + check on-chain (findPool) rather than scan. Works for Simple +
// Concentrated pools of any two tokens (dropdown or custom mint).

import { useCallback, useMemo, useState } from "react";
import { useActiveChain } from "@/lib/chains/store";
import { PublicKey } from "@solana/web3.js";
import { addMyPool } from "@/lib/myPools";
import { findPool, type FindToken } from "@/lib/findPool";
import { fetchMintDecimals } from "@/lib/createPool-actions";
import { knownTokens, type KnownToken } from "@/lib/knownTokens";

type Status = { kind: "ok" | "err" | "none" | "pending"; msg: string } | null;
interface Picked { mint: string; symbol: string; decimals: number | null; }
const EMPTY: Picked = { mint: "", symbol: "", decimals: null };
const TIERS = [{ label: "0.05%", bps: 5 }, { label: "0.30%", bps: 30 }, { label: "1.00%", bps: 100 }];

export default function FindPoolPanel({ onFound }: { onFound?: () => void }) {
  const { chain } = useActiveChain();
  const tokens = useMemo(() => (chain ? knownTokens(chain) : []), [chain]);
  const [tokenA, setTokenA] = useState<Picked>(EMPTY);
  const [tokenB, setTokenB] = useState<Picked>(EMPTY);
  const [type, setType] = useState<"simple" | "clmm">("simple");
  const [bps, setBps] = useState(30);
  const [status, setStatus] = useState<Status>(null);

  const ready = !!chain && !!tokenA.mint && !!tokenB.mint && tokenA.mint !== tokenB.mint && tokenA.decimals != null && tokenB.decimals != null && status?.kind !== "pending";

  const onFind = useCallback(async () => {
    if (!ready || !chain || tokenA.decimals == null || tokenB.decimals == null) return;
    setStatus({ kind: "pending", msg: "Looking…" });
    try {
      const a: FindToken = { mint: tokenA.mint, symbol: tokenA.symbol, decimals: tokenA.decimals };
      const b: FindToken = { mint: tokenB.mint, symbol: tokenB.symbol, decimals: tokenB.decimals };
      const res = await findPool(chain, type, a, b, bps);
      if (res.found) {
        addMyPool(res.entry);
        setStatus({ kind: "ok", msg: "Found — added to your pools below." });
        onFound?.();
      } else {
        setStatus({ kind: "none", msg: `No ${type === "clmm" ? "concentrated" : "simple"} ${TIERS.find((t) => t.bps === bps)?.label} pool for this pair yet. Create one?` });
      }
    } catch (e: unknown) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    }
  }, [ready, chain, tokenA, tokenB, type, bps, onFound]);

  return (
    <div className="card" data-testid="find-pool-panel" style={{ maxWidth: 520 }}>
      <div className="rowhead" style={{ marginBottom: 16 }}>
        <span className="side">Find a pool</span>
        <span className="side mono" style={{ color: "var(--faint)" }}>by tokens + tier</span>
      </div>

      <div className="seg" style={{ width: "100%", marginBottom: 12 }} data-testid="find-type">
        <button style={{ flex: 1 }} aria-selected={type === "simple"} data-testid="find-type-simple" onClick={() => { setType("simple"); setStatus(null); }}>Simple</button>
        <button style={{ flex: 1 }} aria-selected={type === "clmm"} data-testid="find-type-clmm" onClick={() => { setType("clmm"); setStatus(null); }}>Concentrated</button>
      </div>

      <TokenSelect label="First token" testid="find-token-a" picked={tokenA} onPick={(p) => { setTokenA(p); setStatus(null); }} disabledMint={tokenB.mint} tokens={tokens} solanaRpc={chain?.solanaRpc ?? ""} />
      <TokenSelect label="Second token" testid="find-token-b" picked={tokenB} onPick={(p) => { setTokenB(p); setStatus(null); }} disabledMint={tokenA.mint} tokens={tokens} solanaRpc={chain?.solanaRpc ?? ""} />

      <div className="rowhead" style={{ marginTop: 14, marginBottom: 6 }}><span className="side">Fee tier</span></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {TIERS.map((t) => (
          <button key={t.bps} data-testid={`find-tier-${t.label}`} className={`tier-chip${bps === t.bps ? " active" : ""}`} aria-pressed={bps === t.bps} onClick={() => { setBps(t.bps); setStatus(null); }}>{t.label}</button>
        ))}
      </div>

      <button className="btn block" data-testid="find-pool-btn" style={{ marginTop: 16 }} onClick={onFind} disabled={!ready}>
        {status?.kind === "pending" ? "Looking…" : "Find pool"}
      </button>

      {status && status.kind !== "pending" && (
        <div className={`note ${status.kind === "ok" ? "ok" : status.kind === "err" ? "err" : ""}`} data-testid="find-pool-status" style={{ marginTop: 14 }}>
          {status.msg}
        </div>
      )}
    </div>
  );
}

function TokenSelect({ label, testid, picked, onPick, disabledMint, tokens, solanaRpc }: {
  label: string; testid: string; picked: Picked; onPick: (p: Picked) => void; disabledMint: string;
  tokens: KnownToken[]; solanaRpc: string;
}) {
  const [custom, setCustom] = useState(false);
  const [addr, setAddr] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const resolveCustom = useCallback(async (a: string) => {
    setErr(null);
    if (!a.trim()) { onPick(EMPTY); return; }
    try {
      new PublicKey(a.trim());
      const decimals = await fetchMintDecimals(a.trim(), solanaRpc);
      onPick({ mint: a.trim(), symbol: `${a.trim().slice(0, 4)}…`, decimals });
    } catch { setErr("Not a valid token mint on this chain"); onPick(EMPTY); }
  }, [onPick, solanaRpc]);

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="rowhead" style={{ marginBottom: 6 }}>
        <span className="side">{label}</span>
        {picked.decimals != null && <span className="side mono" style={{ color: "var(--up)" }}>{picked.decimals} decimals ✓</span>}
      </div>
      {custom ? (
        <div className="amount-row">
          <input data-testid={`${testid}-mint`} placeholder="Paste the token mint address" value={addr}
            onChange={(e) => setAddr(e.target.value)} onBlur={() => resolveCustom(addr)} style={{ fontSize: 14, fontFamily: "var(--mono)" }} />
          <button className="chip" data-testid={`${testid}-known`} onClick={() => { setCustom(false); setAddr(""); setErr(null); onPick(EMPTY); }}>known</button>
        </div>
      ) : (
        <div className="amount-row">
          <select className="select-bare" data-testid={testid} value={picked.mint}
            onChange={(e) => {
              if (e.target.value === "__custom") { setCustom(true); onPick(EMPTY); return; }
              const t = tokens.find((k) => k.mint === e.target.value);
              onPick(t ? { mint: t.mint, symbol: t.symbol, decimals: t.decimals } : EMPTY);
            }}>
            <option value="">Select token</option>
            {tokens.filter((t) => t.mint !== disabledMint).map((t) => (<option key={t.mint} value={t.mint}>{t.symbol}</option>))}
            <option value="__custom">Custom mint…</option>
          </select>
        </div>
      )}
      {err && <div className="sub" data-testid={`${testid}-err`} style={{ color: "var(--down)", marginTop: 4 }}>{err}</div>}
    </div>
  );
}
