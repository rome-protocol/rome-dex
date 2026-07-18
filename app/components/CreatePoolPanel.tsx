"use client";

// CreatePoolPanel — create a NEW simple (constant-product) pool over two tokens.
// DUAL-LANE: works from either the connected EVM or Solana wallet (CreatePool =
// tag 7 creates the pool/LP-mint/fee/destination PDAs internally, no ephemeral
// signers — proven on both lanes in harness/create-simple-pool.test.mjs). Pick two
// tokens (dropdown of known tokens or paste any mint — decimals read on-chain),
// enter a starting amount for each side (the ratio sets the opening price), pick a
// fee tier, create. Adding more liquidity later is the normal add-liquidity flow.

import { useCallback, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { explorerUrl } from "@/lib/explorer";
import { toTxStatus } from "@/lib/txerror";
import { CREATE_FEE_TIERS } from "@/lib/createPool";
import { createSimplePoolSolana, createSimplePoolEvm, fetchMintDecimals, type CreateResult } from "@/lib/createPool-actions";
import { addMyPool } from "@/lib/myPools";
import { knownTokens, type KnownToken } from "@/lib/knownTokens";

type Step = { label: string; state: "todo" | "active" | "done" };
type Status = { kind: "err" | "cancelled" | "done"; msg: string } | null;
interface Picked { mint: string; symbol: string; decimals: number | null; }
const EMPTY: Picked = { mint: "", symbol: "", decimals: null };

export default function CreatePoolPanel({ onBack }: { onBack?: () => void }) {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const tokens = useMemo(() => (chain ? knownTokens(chain) : []), [chain]);
  const lane: "evm" | "solana" | null = wallet.evm ? "evm" : wallet.solana ? "solana" : null;

  const [tokenA, setTokenA] = useState<Picked>(EMPTY);
  const [tokenB, setTokenB] = useState<Picked>(EMPTY);
  const [seedA, setSeedA] = useState("");
  const [seedB, setSeedB] = useState("");
  const [tierIdx, setTierIdx] = useState(1); // 0.30%
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [result, setResult] = useState<CreateResult | null>(null);

  const tier = CREATE_FEE_TIERS[tierIdx];
  const ready =
    !!chain && !!lane && !!tokenA.mint && !!tokenB.mint && tokenA.mint !== tokenB.mint &&
    tokenA.decimals != null && tokenB.decimals != null &&
    parseFloat(seedA) > 0 && parseFloat(seedB) > 0 && !busy;

  const priceHint = useMemo(() => {
    const a = parseFloat(seedA), b = parseFloat(seedB);
    if (!(a > 0) || !(b > 0) || !tokenA.symbol || !tokenB.symbol) return null;
    return `Opening price ≈ ${(b / a).toPrecision(4)} ${tokenB.symbol} per ${tokenA.symbol}`;
  }, [seedA, seedB, tokenA.symbol, tokenB.symbol]);

  async function onCreate() {
    if (!ready || !chain || !lane || tokenA.decimals == null || tokenB.decimals == null) return;
    setStatus(null); setResult(null); setBusy(true);
    setSteps([{ label: "Set up the pool's vaults", state: "active" }, { label: "Create the pool and open it", state: "todo" }]);
    try {
      const params = {
        mintA: tokenA.mint, mintB: tokenB.mint, decimalsA: tokenA.decimals, decimalsB: tokenB.decimals,
        feeBps: tier.feeBps, seedAHuman: seedA, seedBHuman: seedB,
      };
      const onStep = (i: number, total: number, label: string) =>
        setSteps(Array.from({ length: total }, (_, k) => ({ label: k === i ? label : (k < i ? label : ""), state: k < i ? "done" : k === i ? "active" : "todo" })));
      const res = lane === "solana"
        ? await createSimplePoolSolana(chain, wallet.solana!, params, onStep)
        : await createSimplePoolEvm(chain, wallet.evm!, params, onStep);
      setSteps((prev) => prev.map((s) => ({ ...s, state: "done" })));
      setResult(res);
      // Record it so it shows on /pools immediately (created pools aren't in the
      // static list / can't be RPC-scanned — see lib/myPools.ts).
      addMyPool({
        kind: "simple", pool: res.pool, program: chain.dex.dexProgram,
        mintA: tokenA.mint, mintB: tokenB.mint,
        symbolA: tokenA.symbol, symbolB: tokenB.symbol,
        decimalsA: tokenA.decimals, decimalsB: tokenB.decimals,
        vaultA: res.vaultA, vaultB: res.vaultB, feeBps: tier.feeBps, tier: tier.tier,
        createdSig: res.signatures[res.signatures.length - 1] ?? "", createdAt: Date.now(),
      });
      setStatus({ kind: "done", msg: "Your pool is live." });
    } catch (e: unknown) {
      const { cancelled, message } = toTxStatus(e);
      setStatus({ kind: cancelled ? "cancelled" : "err", msg: message });
      setSteps((prev) => prev.map((s) => (s.state === "active" ? { ...s, state: "todo" } : s)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="create-pool-panel" style={{ maxWidth: 520 }}>
      <div className="rowhead" style={{ marginBottom: 16 }}>
        <span className="side">{onBack ? <button className="chip" data-testid="simple-create-back" onClick={onBack}>← Back</button> : "Simple pool"}</span>
        <span className="side mono" style={{ color: "var(--faint)" }}>two tokens · one price</span>
      </div>

      {!lane && (
        <div className="note" data-testid="create-pool-connect">Connect a wallet to create a pool — works from either an EVM or Solana wallet.</div>
      )}

      <TokenSelect label="First token" testid="pool-token-a" picked={tokenA} onPick={setTokenA} disabledMint={tokenB.mint} tokens={tokens} solanaRpc={chain?.solanaRpc ?? ""} />
      <TokenSelect label="Second token" testid="pool-token-b" picked={tokenB} onPick={setTokenB} disabledMint={tokenA.mint} tokens={tokens} solanaRpc={chain?.solanaRpc ?? ""} />

      <div className="rowhead" style={{ marginTop: 16, marginBottom: 6 }}><span className="side">Starting liquidity</span></div>
      <div className="tokenrow">
        <div className="mid">
          <input className="amt" data-testid="seed-a" inputMode="decimal" placeholder="0.0" value={seedA} onChange={(e) => setSeedA(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="tselect">{tokenA.symbol || "First"}</span>
        </div>
      </div>
      <div className="tokenrow" style={{ marginTop: 6 }}>
        <div className="mid">
          <input className="amt" data-testid="seed-b" inputMode="decimal" placeholder="0.0" value={seedB} onChange={(e) => setSeedB(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="tselect">{tokenB.symbol || "Second"}</span>
        </div>
      </div>
      <div className="sub" style={{ marginTop: 8 }}>{priceHint ?? "The ratio you set becomes the opening price."}</div>

      <div className="rowhead" style={{ marginTop: 16, marginBottom: 6 }}><span className="side">Fee tier</span></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {CREATE_FEE_TIERS.map((t, i) => (
          <button key={t.tier} data-testid={`pool-tier-${t.tier}`} className={`tier-chip${tierIdx === i ? " active" : ""}`} aria-pressed={tierIdx === i} onClick={() => setTierIdx(i)}>{t.tier}</button>
        ))}
      </div>

      {lane && <div className="sub" style={{ marginTop: 12 }}>Creating via your {lane === "evm" ? "EVM" : "Solana"} wallet.</div>}

      <button className="btn block" data-testid="create-pool-btn" style={{ marginTop: 16 }} onClick={onCreate} disabled={!ready}>
        {busy ? "Creating…" : "Create pool"}
      </button>

      {steps.length > 0 && (
        <div className="flow-strip-inline" data-testid="create-pool-steps">
          <div className="legs">
            {steps.map((s, i) => (
              <div className="leg" data-flow-state={s.state} key={i}>
                <div className="rail"><div className={`dot ${lane === "evm" ? "evm" : "sol"}`}>{lane === "evm" ? "◆" : "◎"}</div>{i < steps.length - 1 && <div className="spine" />}</div>
                <div className="body"><div className="t">{s.label || "…"}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {status && (
        <div className={`note ${status.kind === "done" ? "ok" : status.kind}`} data-testid="create-pool-status" style={{ marginTop: 14 }}>
          {status.msg}
          {result && (
            <> Pool <span className="mono">{result.pool.slice(0, 8)}…</span>{result.signatures.length > 0 && chain && <> · <a data-testid="create-pool-tx" href={explorerUrl(result.signatures[result.signatures.length - 1], chain)} target="_blank" rel="noopener noreferrer">view tx ↗</a></>}</>
          )}
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
            {tokens.filter((t) => t.mint !== disabledMint).map((t) => (
              <option key={t.mint} value={t.mint}>{t.symbol}</option>
            ))}
            <option value="__custom">Custom mint…</option>
          </select>
        </div>
      )}
      {err && <div className="sub" data-testid={`${testid}-err`} style={{ color: "var(--down)", marginTop: 4 }}>{err}</div>}
    </div>
  );
}
