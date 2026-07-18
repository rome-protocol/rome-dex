"use client";

// CreateClmmPoolPanel — create a NEW concentrated (CLMM) pool over two tokens.
// DUAL-LANE: works from either the connected EVM or Solana wallet (CLMM pool
// creation needs no ephemeral signers — permissionless PDA InitPool + ATA vaults
// — proven on both lanes in harness/clmm-create-pool.test.mjs). Pick two tokens
// (dropdown of known tokens or paste any mint — decimals read on-chain), set the
// initial price and fee tier, choose a range, and create. Step 2 (adding your
// liquidity) is the existing position flow on the pool this produces.

import { useCallback, useMemo, useState } from "react";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { explorerUrl } from "@/lib/explorer";
import { toTxStatus } from "@/lib/txerror";
import { priceToTick, TICK_ARRAY_SIZE } from "@/lib/clmm-quote";
import { CLMM_CREATE_TIERS, orderMints, priceToSqrtPrice, vaultAtaFor } from "@/lib/clmm-create";
import { createClmmPoolSolana, createClmmPoolEvm, fetchMintDecimals } from "@/lib/clmm-create-actions";
import { addMyPool } from "@/lib/myPools";
import { knownTokens, type KnownToken } from "@/lib/knownTokens";
import { PublicKey } from "@solana/web3.js";

const CLMM_PROGRAM = "cLMkE4X3PN4qwLBjUksHAnYbQiNMMedCPEdYwRbLVjV";

type Step = { label: string; state: "todo" | "active" | "done" };
type Status = { kind: "err" | "cancelled" | "done"; msg: string } | null;
type Range = "full" | "custom";

// A chosen token: a known one, or a custom mint the user pasted (decimals on-chain).
interface Picked { mint: string; symbol: string; decimals: number | null; }
const EMPTY: Picked = { mint: "", symbol: "", decimals: null };

export default function CreateClmmPoolPanel({ onBack }: { onBack?: () => void }) {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const tokens = useMemo(() => (chain ? knownTokens(chain) : []), [chain]);
  // Dual-lane: EVM takes priority when both connected (matches the swap card).
  const lane: "evm" | "solana" | null = wallet.evm ? "evm" : wallet.solana ? "solana" : null;

  const [tokenA, setTokenA] = useState<Picked>(EMPTY);
  const [tokenB, setTokenB] = useState<Picked>(EMPTY);
  const [price, setPrice] = useState("");
  const [tierIdx, setTierIdx] = useState(1); // default 0.30%
  const [range, setRange] = useState<Range>("full");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [poolAddr, setPoolAddr] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const tier = CLMM_CREATE_TIERS[tierIdx];

  // Canonical order (mint0 < mint1) — the price is quoted token1 per token0, so
  // the label follows the canonical direction to match how the program reads it.
  const canonical = useMemo(() => {
    if (!tokenA.mint || !tokenB.mint || tokenA.decimals == null || tokenB.decimals == null) return null;
    try {
      const { mint0, mint1, flipped } = orderMints(new PublicKey(tokenA.mint), new PublicKey(tokenB.mint));
      const t0 = flipped ? tokenB : tokenA, t1 = flipped ? tokenA : tokenB;
      return { mint0: mint0.toBase58(), mint1: mint1.toBase58(), sym0: t0.symbol || "token0", sym1: t1.symbol || "token1", dec0: t0.decimals!, dec1: t1.decimals! };
    } catch { return null; }
  }, [tokenA, tokenB]);

  const priceNum = parseFloat(price);
  const ready =
    !!lane && !!canonical && tokenA.mint !== tokenB.mint && priceNum > 0 && !busy &&
    (range === "full" || (parseFloat(minPrice) > 0 && parseFloat(maxPrice) > parseFloat(minPrice)));

  // Map initial price + range → the tick bounds whose arrays we initialize.
  function tickBounds(): { lower: number; upper: number } {
    const { dec0, dec1 } = canonical!;
    const span = TICK_ARRAY_SIZE * tier.tickSpacing;
    const at = priceToTick(priceNum, 1, dec0, dec1);
    if (range === "custom") {
      return { lower: priceToTick(parseFloat(minPrice), 1, dec0, dec1), upper: priceToTick(parseFloat(maxPrice), 1, dec0, dec1) };
    }
    return { lower: at - span, upper: at + span }; // Full = a wide band around the price
  }

  async function onCreate() {
    if (!ready || !canonical || !lane) return;
    setStatus(null); setPoolAddr(null); setLastTx(null); setBusy(true);
    setSteps([
      { label: "Create the pool and its vaults", state: "active" },
      { label: "Prepare the price range", state: "todo" },
    ]);
    try {
      const { lower, upper } = tickBounds();
      const params = {
        mintA: canonical.mint0, mintB: canonical.mint1,
        feePips: tier.feePips, tickSpacing: tier.tickSpacing,
        sqrtPrice: priceToSqrtPrice(priceNum, canonical.dec0, canonical.dec1),
        tickLower: lower, tickUpper: upper,
      };
      const onStep = (i: number, total: number, label: string) =>
        setSteps(Array.from({ length: total }, (_, k) => ({ label: k === i ? label : (k < i ? label : ""), state: k < i ? "done" : k === i ? "active" : "todo" })));
      if (!chain) throw new Error("chain not ready");
      const res = lane === "solana"
        ? await createClmmPoolSolana(chain, wallet.solana!, params, onStep)
        : await createClmmPoolEvm(chain, wallet.evm!, params, onStep);
      const sigs = "signatures" in res ? res.signatures : res.txHashes;
      setSteps((prev) => prev.map((s) => ({ ...s, state: "done" })));
      setPoolAddr(res.poolPda);
      setLastTx(sigs[sigs.length - 1] ?? null);
      // Record it so it shows on /pools immediately. Vaults are the pool PDA's
      // ATAs of the two mints (deterministic).
      const poolPk = new PublicKey(res.poolPda);
      addMyPool({
        kind: "clmm", pool: res.poolPda, program: CLMM_PROGRAM,
        mintA: canonical.mint0, mintB: canonical.mint1,
        symbolA: canonical.sym0, symbolB: canonical.sym1,
        decimalsA: canonical.dec0, decimalsB: canonical.dec1,
        vaultA: vaultAtaFor(poolPk, new PublicKey(canonical.mint0)).toBase58(),
        vaultB: vaultAtaFor(poolPk, new PublicKey(canonical.mint1)).toBase58(),
        feeBps: CLMM_CREATE_TIERS[tierIdx].feePips / 100, tier: CLMM_CREATE_TIERS[tierIdx].tier,
        createdSig: sigs[sigs.length - 1] ?? "", createdAt: Date.now(),
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
    <div className="card" data-testid="create-clmm-panel" style={{ maxWidth: 520 }}>
      <div className="rowhead" style={{ marginBottom: 16 }}>
        <span className="side">{onBack ? <button className="chip" data-testid="clmm-create-back" onClick={onBack}>← Back</button> : "Concentrated pool"}</span>
        <span className="side mono" style={{ color: "var(--faint)" }}>two tokens · price band</span>
      </div>

      {!lane && (
        <div className="note" data-testid="create-clmm-connect">Connect a wallet to create a pool — works from either an EVM or Solana wallet.</div>
      )}

      <TokenSelect label="First token" testid="clmm-token-a" picked={tokenA} onPick={setTokenA} disabledMint={tokenB.mint} tokens={tokens} solanaRpc={chain?.solanaRpc ?? ""} />
      <TokenSelect label="Second token" testid="clmm-token-b" picked={tokenB} onPick={setTokenB} disabledMint={tokenA.mint} tokens={tokens} solanaRpc={chain?.solanaRpc ?? ""} />

      <div className="rowhead" style={{ marginTop: 14, marginBottom: 6 }}>
        <span className="side">Initial price</span>
        {canonical && <span className="side mono" style={{ color: "var(--faint)" }}>{canonical.sym1} per {canonical.sym0}</span>}
      </div>
      <div className="tokenrow">
        <div className="mid">
          <input className="amt" data-testid="clmm-price" inputMode="decimal" placeholder="0.0" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
      </div>

      <div className="rowhead" style={{ marginTop: 16, marginBottom: 6 }}><span className="side">Liquidity range</span></div>
      <div className="seg" style={{ width: "100%" }} data-testid="clmm-range">
        <button style={{ flex: 1 }} aria-selected={range === "full"} data-testid="clmm-range-full" onClick={() => setRange("full")}>Full range</button>
        <button style={{ flex: 1 }} aria-selected={range === "custom"} data-testid="clmm-range-custom" onClick={() => setRange("custom")}>Custom range</button>
      </div>
      {range === "custom" && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <div className="tokenrow" style={{ flex: 1 }}><div className="mid"><input className="amt" style={{ fontSize: 20 }} data-testid="clmm-min" inputMode="decimal" placeholder="Min price" value={minPrice} onChange={(e) => setMinPrice(e.target.value.replace(/[^0-9.]/g, ""))} /></div></div>
          <div className="tokenrow" style={{ flex: 1 }}><div className="mid"><input className="amt" style={{ fontSize: 20 }} data-testid="clmm-max" inputMode="decimal" placeholder="Max price" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.replace(/[^0-9.]/g, ""))} /></div></div>
        </div>
      )}

      <div className="rowhead" style={{ marginTop: 16, marginBottom: 6 }}><span className="side">Fee tier</span></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {CLMM_CREATE_TIERS.map((t, i) => (
          <button key={t.tier} data-testid={`clmm-tier-${t.tier}`} className={`tier-chip${tierIdx === i ? " active" : ""}`} aria-pressed={tierIdx === i} onClick={() => setTierIdx(i)}>{t.tier}</button>
        ))}
      </div>

      <div className="sub" style={{ marginTop: 12 }}>
        You set the opening price; adding your liquidity is the next step on the new pool.
        {lane && <> Creating via your {lane === "evm" ? "EVM" : "Solana"} wallet.</>}
      </div>

      <button className="btn block" data-testid="create-clmm-btn" style={{ marginTop: 16 }} onClick={onCreate} disabled={!ready}>
        {busy ? "Creating…" : "Create pool"}
      </button>

      {steps.length > 0 && (
        <div className="flow-strip-inline" data-testid="create-clmm-steps">
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
        <div className={`note ${status.kind === "done" ? "ok" : status.kind}`} data-testid="create-clmm-status" style={{ marginTop: 14 }}>
          {status.msg}
          {poolAddr && (
            <> Pool <span className="mono">{poolAddr.slice(0, 8)}…</span>{lastTx && chain && <> · <a data-testid="create-clmm-tx" href={explorerUrl(lastTx, chain)} target="_blank" rel="noopener noreferrer">view tx ↗</a></>}</>
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
