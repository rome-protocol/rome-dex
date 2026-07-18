"use client";

// Liquidity panel for a single pool (tier). Add / Remove / Zap-in.
//   • EVM lane (the EVM wallet) → the RomeDexRouter: approve-once then a single-leg
//     atomic add/remove. Tier-aware.
//   • Solana lane (the Solana wallet) → native solanaDeposit/solanaWithdraw.
//   • No wallet → the CTA reads "Connect wallet" and is disabled. There is NO
//     backend/demo signer — liquidity only ever signs with the user's wallet.
//
// The compact flow strip below the CTA is a TRUTHFUL look-ahead + live tracker:
// the one-time-approval step appears only when a real allowance read says that
// prompt is coming; steps advance from the actual add/remove callbacks; on
// success the tx hash lands in the strip; on failure it says nothing moved.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { useActionFlow } from "./useActionFlow";
import FlowStrip, { type FlowCopy } from "./FlowStrip";
import type { FlowStep } from "@/lib/flowState";
import {
  solanaDeposit,
  solanaWithdraw,
  evmPdaFor,
  ataFor,
  poolForTier,
} from "@/lib/walletActions";
import { routerAddLiquidity, routerRemoveLiquidity, allowanceOk } from "@/lib/router";
import { ataBalance } from "@/lib/balances";
import { fmtRaw } from "@/lib/format";
import { tokenMeta } from "@/lib/tokens";
import type { PoolRow } from "@/lib/usePools";
import { toTxStatus } from "@/lib/txerror";
import { explorerUrl } from "@/lib/explorer";

type Mode = "add" | "remove" | "zap";
type ActiveLane = "evm" | "solana";

function parseHuman(s: string, dec: number): bigint | null {
  if (!s || s === ".") return null;
  try {
    const [whole, frac = ""] = s.split(".");
    return BigInt(whole || "0") * 10n ** BigInt(dec) + BigInt(frac.slice(0, dec).padEnd(dec, "0") || "0");
  } catch {
    return null;
  }
}

/** Honest wallet-prompt count for the EVM look-ahead (approvals + the tx). */
function evmLiqHint(approveCount: number, mode: Mode): string {
  if (approveCount <= 0) return "One confirmation in your wallet";
  const total = approveCount + 1;
  const totalWord = total === 2 ? "Two" : total === 3 ? "Three" : String(total);
  const appr = approveCount > 1 ? "two one-time approvals" : "a one-time approval";
  return `${totalWord} wallet prompts: ${appr}, then ${mode === "add" ? "adding" : "removing"} your liquidity`;
}

export default function LiquidityPanel({ pool }: { pool: PoolRow }) {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const flowApi = useActionFlow();
  const [mode, setMode] = useState<Mode>("add");
  const [addAmt, setAddAmt] = useState("");   // token A (human) — canonical for the deposit math
  const [addAmtB, setAddAmtB] = useState(""); // token B (human) — linked view of the same deposit
  const [removeAmt, setRemoveAmt] = useState(""); // LP (human)
  const [zapAmt, setZapAmt] = useState("");   // token A (human)
  const [userLp, setUserLp] = useState<bigint>(0n);
  const [planHint, setPlanHint] = useState("");

  const activeLane: ActiveLane | null = wallet.evm ? "evm" : wallet.solana ? "solana" : null;
  const noWallet = !activeLane;

  const SYM_A = pool.symbolA, SYM_B = pool.symbolB;
  const decA = pool.decimalsA, decB = pool.decimalsB, decLp = 6;
  const rA = BigInt(pool.reserveA), rB = BigInt(pool.reserveB), lpS = BigInt(pool.lpSupply);
  const tierPool = useMemo(() => (chain ? poolForTier(chain, pool.tier, pool.pairId) : null), [chain, pool.tier, pool.pairId]);

  // Owner's LP balance for THIS tier's LP mint (real, per lane).
  const loadLp = useCallback(async () => {
    if (!chain || !tierPool) { setUserLp(0n); return; }
    let owner: PublicKey | null = null;
    if (activeLane === "evm" && wallet.evm) owner = evmPdaFor(wallet.evm, chain.romeEvmProgramId);
    else if (activeLane === "solana" && wallet.solana) {
      try { owner = new PublicKey(wallet.solana); } catch { owner = null; }
    }
    if (!owner) {
      // No wallet → no position to read.
      setUserLp(0n);
      return;
    }
    const lpAta = await ataFor(owner, tierPool.poolMint);
    setUserLp(await ataBalance(chain.solanaRpc, lpAta));
    // mode is a dep so switching to the Remove tab re-reads the (now-settled)
    // LP balance — the read right after an add-liquidity tx can land before the
    // LP mints on the Solana side, so a one-shot fetch would show a stale 0.
  }, [chain, activeLane, wallet.evm, wallet.solana, tierPool, pool.tier, pool.pairId, mode]);

  useEffect(() => { loadLp(); }, [loadLp]);

  // A pool deposit always moves BOTH tokens at the live reserve ratio — so both
  // sides are real inputs, editing either computes the other (live-user report:
  // a single "Deposit USDC" box read as a one-sided deposit). Plain digits (no
  // thousands grouping) so values round-trip through the inputs.
  const toPlain = (raw: bigint, dec: number, places = 6): string => {
    const s = raw.toString().padStart(dec + 1, "0");
    const whole = s.slice(0, -dec) || "0";
    const frac = s.slice(-dec).slice(0, places).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  };
  const onEditA = (v: string) => {
    setAddAmt(v);
    const rawA = parseHuman(v, decA);
    if (rawA && rawA > 0n && rA > 0n) setAddAmtB(toPlain((rawA * rB) / rA, decB));
    else setAddAmtB("");
  };
  const onEditB = (v: string) => {
    setAddAmtB(v);
    const rawB = parseHuman(v, decB);
    if (rawB && rawB > 0n && rB > 0n) setAddAmt(toPlain((rawB * rA) / rB, decA));
    else setAddAmt("");
  };

  const addPreview = useMemo(() => {
    const rawA = parseHuman(addAmt, decA);
    if (!rawA || rawA <= 0n || rA === 0n || lpS === 0n) return null;
    const lpToMint = (rawA * lpS) / rA;
    const propB = lpS > 0n ? (lpToMint * rB) / lpS : 0n;
    const sharePct = (Number(lpToMint) / (Number(lpS) + Number(lpToMint))) * 100;
    return { rawA, lpToMint, propB, sharePct };
  }, [addAmt, rA, rB, lpS, decA]);

  const removePreview = useMemo(() => {
    const rawLp = parseHuman(removeAmt, decLp);
    if (!rawLp || rawLp <= 0n || lpS === 0n) return null;
    return { rawLp, outA: (rawLp * rA) / lpS, outB: (rawLp * rB) / lpS };
  }, [removeAmt, rA, rB, lpS]);

  const zapPreview = useMemo(() => {
    const rawA = parseHuman(zapAmt, decA);
    if (!rawA || rawA <= 0n) return null;
    return { rawA };
  }, [zapAmt, decA]);

  const busy = flowApi.flow.phase === "running";
  const laneLabel = activeLane === "evm" ? "EVM lane" : activeLane === "solana" ? "Solana lane" : "No wallet connected";

  // ── Journey look-ahead ────────────────────────────────────────────────────
  // Publish a TRUTHFUL per-user plan whenever there's a valid add/remove preview
  // and a wallet: on the EVM lane a real allowance read decides whether (and for
  // which tokens) the one-time approval prompt will actually happen.
  const activeAmt = mode === "add" ? addAmt : mode === "remove" ? removeAmt : "";
  const preview = mode === "add" ? addPreview : mode === "remove" ? removePreview : null;
  const planKey =
    preview && activeLane && mode !== "zap"
      ? `${activeLane}|${mode}|${pool.pairId}|${pool.tier}|${activeAmt}`
      : null;
  const plannedKey = useRef<string | null>(null);
  useEffect(() => {
    const phase = flowApi.flow.phase;
    if (phase === "running") return;
    if (!planKey || !preview || !activeLane) {
      plannedKey.current = null;
      if (phase === "idle") flowApi.reset();
      return;
    }
    if (phase !== "idle" && planKey === plannedKey.current) return;

    let cancelled = false;
    const tail: FlowStep[] =
      mode === "add"
        ? [
            { id: "confirm", title: "Confirm adding liquidity in your wallet", state: "todo" },
            { id: "receive", title: `Your ${SYM_A} / ${SYM_B} position lands in your wallet`, sub: "your share of the pool, held in both worlds", state: "todo" },
          ]
        : [
            { id: "confirm", title: "Confirm removing liquidity in your wallet", state: "todo" },
            { id: "receive", title: `${SYM_A} and ${SYM_B} land in your wallet`, sub: "your share of the pool", state: "todo" },
          ];

    if (activeLane === "solana") {
      plannedKey.current = planKey;
      setPlanHint("One quick signature in your wallet");
      flowApi.plan("sol", tail, false);
      return;
    }

    // EVM lane: read the chain to see which approval prompt(s) will happen.
    (async () => {
      let approveCount = 0;
      let approveTitle = "";
      try {
        if (!chain || !tierPool) throw new Error("chain not ready");
        const userPda = evmPdaFor(wallet.evm!, chain.romeEvmProgramId);
        if (mode === "add") {
          const { rawA, propB } = addPreview!;
          const maxA = (rawA * 101n) / 100n, maxB = (propB * 101n) / 100n;
          const [ataA, ataB] = [await ataFor(userPda, tierPool.mintA), await ataFor(userPda, tierPool.mintB)];
          const okA = await allowanceOk(chain, ataA, maxA);
          const okB = await allowanceOk(chain, ataB, maxB);
          const names = [okA ? null : SYM_A, okB ? null : SYM_B].filter(Boolean).join(" and ");
          approveCount = (okA ? 0 : 1) + (okB ? 0 : 1);
          approveTitle = `One-time approval for your ${names}`;
        } else {
          const { rawLp } = removePreview!;
          const lpAta = await ataFor(userPda, tierPool.poolMint);
          approveCount = (await allowanceOk(chain, lpAta, rawLp)) ? 0 : 1;
          approveTitle = "One-time approval for your pool position";
        }
      } catch {
        // Unknown → don't promise it away; show the approval as possible.
        approveCount = 1;
        approveTitle = "One-time approval";
      }
      if (cancelled) return;
      const needsApproval = approveCount > 0;
      const steps: FlowStep[] = needsApproval
        ? [{ id: "approve", title: approveTitle, sub: "a quick extra confirmation — only needed the first time", state: "todo" }, ...tail]
        : tail;
      plannedKey.current = planKey;
      setPlanHint(evmLiqHint(approveCount, mode));
      flowApi.plan("evm", steps, needsApproval);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, flowApi.flow.phase]);

  const flowCopy: FlowCopy = {
    eyebrow: mode === "add" ? "Adding liquidity · step by step" : "Removing liquidity · step by step",
    doneVerb: mode === "add" ? "added" : "removed",
    extraTag: "includes a one-time approval",
    idleHint: planHint,
    successHint: mode === "add" ? "Done — your liquidity is in the pool" : "Done — your tokens are back in your wallet",
  };

  // Advance the flow from the ACTUAL router stage callbacks (EVM lane).
  const evmStage = (stage: "approve" | "approved" | "sign") => {
    if (stage === "approve") flowApi.step("approve", "active");
    if (stage === "approved") flowApi.step("approve", "done");
    if (stage === "sign") flowApi.step("confirm", "active");
  };

  async function submit() {
    if (mode === "zap") return; // zap is disabled (single-sided rework); no flow wired
    const isAdd = mode === "add";
    if (isAdd ? !addPreview : !removePreview) return;
    if (!activeLane) return; // defensive — CTA is disabled without a wallet
    if (!chain) return; // defensive — wait for the active chain
    flowApi.start();
    try {
      let tx: string;
      if (isAdd) {
        const { rawA, lpToMint, propB } = addPreview!;
        const maxA = (rawA * 101n) / 100n, maxB = (propB * 101n) / 100n;
        if (activeLane === "evm" && wallet.evm) {
          tx = await routerAddLiquidity({ chain, eoa: wallet.evm, tier: pool.tier, pairId: pool.pairId, lp: lpToMint, a: maxA, b: maxB, onStage: evmStage });
        } else if (activeLane === "solana" && wallet.solana) {
          tx = await solanaDeposit({ chain, userPubkey: wallet.solana, tier: pool.tier, pairId: pool.pairId, lp: lpToMint, maxA, maxB, onSign: () => flowApi.step("confirm", "active") });
        } else return;
        setAddAmt("");
      } else {
        const { rawLp, outA, outB } = removePreview!;
        const minA = (outA * 99n) / 100n, minB = (outB * 99n) / 100n;
        if (activeLane === "evm" && wallet.evm) {
          tx = await routerRemoveLiquidity({ chain, eoa: wallet.evm, tier: pool.tier, pairId: pool.pairId, lp: rawLp, a: minA, b: minB, onStage: evmStage });
        } else if (activeLane === "solana" && wallet.solana) {
          tx = await solanaWithdraw({ chain, userPubkey: wallet.solana, tier: pool.tier, pairId: pool.pairId, lp: rawLp, minA, minB, onSign: () => flowApi.step("confirm", "active") });
        } else return;
        setRemoveAmt("");
      }
      flowApi.succeed(tx, explorerUrl(tx, chain));
      await loadLp();
      // Re-read after Solana settlement lag so the LP balance reflects the tx
      // even if the first read landed before the mint/burn settled.
      setTimeout(() => { loadLp(); }, 4000);
    } catch (e: unknown) {
      const { cancelled, message } = toTxStatus(e);
      flowApi.fail(cancelled ? "Cancelled in your wallet — nothing moved." : `${message} Nothing moved.`);
    }
  }

  const switchMode = (m: Mode) => { setMode(m); flowApi.reset(); setPlanHint(""); };

  const glyphA = tokenMeta(SYM_A), glyphB = tokenMeta(SYM_B);

  return (
    <div className="swapcard card" data-testid="liquidity-panel">
      <div className="eyebrow" style={{ marginBottom: 14 }}>Provide liquidity · {pool.tier}</div>

      <div className="liq-lane-bar" data-testid="liq-lane-indicator">
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, letterSpacing: ".03em", textTransform: "uppercase" }}>{laneLabel}</span>
        {noWallet && <span style={{ fontSize: 13.5, color: "var(--faint)" }}>— connect a wallet to use your funds</span>}
      </div>

      <div className="seg" style={{ width: "100%", marginBottom: 14 }}>
        {(["add", "remove", "zap"] as Mode[]).map((m) => (
          <button key={m} data-testid={`liq-tab-${m}`} aria-selected={mode === m} style={{ flex: 1, textTransform: "capitalize" }} onClick={() => switchMode(m)}>
            {m === "zap" ? "Zap in" : m}
          </button>
        ))}
      </div>

      {mode === "add" && (
        <>
          <TokenRow label={`Deposit ${SYM_A}`} value={addAmt} onChange={onEditA} sym={SYM_A} grad={glyphA.grad} glyph={glyphA.glyph} testid="liq-add-input" />
          <TokenRow label={`Deposit ${SYM_B}`} value={addAmtB} onChange={onEditB} sym={SYM_B} grad={glyphB.grad} glyph={glyphB.glyph} testid="liq-add-input-b" />
          {addPreview && (
            <div className="route" data-testid="add-preview">
              <div className="r"><span>You deposit</span><b data-testid="paired-b">{fmtRaw(addPreview.rawA, decA)} {SYM_A} + {fmtRaw(addPreview.propB, decB)} {SYM_B}</b></div>
              <div className="r"><span>LP minted</span><b data-testid="lp-minted">{fmtRaw(addPreview.lpToMint, decLp)}</b></div>
              <div className="r"><span>New pool share</span><b data-testid="pool-share">{addPreview.sharePct.toFixed(4)}%</b></div>
              <div className="r"><span>Held in</span><span className="routepath"><span className="badge evm">◆ EVM</span><span className="badge sol">◎ Solana</span></span></div>
            </div>
          )}
          <button className="btn block" data-testid="add-liquidity-btn" style={{ marginTop: 14 }} onClick={submit} disabled={noWallet || !addPreview || busy}>
            {noWallet ? "Connect wallet" : busy ? "Adding…" : "Add liquidity"}
          </button>
        </>
      )}

      {mode === "remove" && (
        <>
          <div className="rowhead"><span className="side">Burn LP</span><span className="bal" data-testid="lp-balance">bal {fmtRaw(userLp, decLp)} LP</span></div>
          <TokenRow value={removeAmt} onChange={(v) => { setRemoveAmt(v); }} sym="LP" grad="linear-gradient(135deg,#6E5A78,#A692AE)" glyph="LP" />
          <div className="chips">
            {[25, 50, 75, 100].map((pct) => (
              <button key={pct} className="chip" data-testid={`chip-${pct}`} onClick={() => { setRemoveAmt(fmtRaw((userLp * BigInt(pct)) / 100n, decLp, 6)); }}>{pct}%</button>
            ))}
          </div>
          {removePreview && (
            <div className="route">
              <div className="r"><span>Receive {SYM_A}</span><b>{fmtRaw(removePreview.outA, decA)} {SYM_A}</b></div>
              <div className="r"><span>Receive {SYM_B}</span><b>{fmtRaw(removePreview.outB, decB)} {SYM_B}</b></div>
            </div>
          )}
          <button className="btn block" data-testid="remove-liquidity-btn" style={{ marginTop: 14 }} onClick={submit} disabled={noWallet || !removePreview || busy}>
            {noWallet ? "Connect wallet" : busy ? "Removing…" : "Remove liquidity"}
          </button>
        </>
      )}

      {mode === "zap" && (
        <>
          <TokenRow label={`Zap in with ${SYM_A}`} value={zapAmt} onChange={(v) => { setZapAmt(v); }} sym={SYM_A} grad={glyphA.grad} glyph={glyphA.glyph} />
          <div className="route">
            <div className="r"><span>Route</span><span className="routepath"><span className="hop">{SYM_A}</span>→ split →<span className="hop">{SYM_A}</span><span className="hop">{SYM_B}</span></span></div>
            <div className="r"><span>Execution</span><b>swap + deposit in one transaction</b></div>
            <div className="r"><span>Lane</span><b>◆ EVM only</b></div>
          </div>
          <button className="btn block" data-testid="zap-in-btn" style={{ marginTop: 14 }} disabled>
            Single-sided provide — use Add
          </button>
          <div className="note" style={{ marginTop: 10 }}>
            Providing with a single token isn&apos;t enabled here yet — it needs to swap part of your
            deposit to the other side first. For now, <b>Add</b> provides both tokens directly.
          </div>
        </>
      )}

      {mode !== "zap" && (
        <FlowStrip flow={flowApi.flow} testid="liqflow" copy={flowCopy} containerTestId="liq-flow" />
      )}
    </div>
  );
}

function TokenRow({ label, value, onChange, sym, grad, glyph, testid }: { label?: string; value: string; onChange: (v: string) => void; sym: string; grad: string; glyph: string; testid?: string }) {
  return (
    <div className="tokenrow">
      {label && <div className="lbl"><span>{label}</span></div>}
      <div className="mid">
        <input className="amt" data-testid={testid} inputMode="decimal" placeholder="0.0" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="tselect"><span className="tglyph" style={{ background: grad }}>{glyph}</span>{sym}</span>
      </div>
    </div>
  );
}
