"use client";

// OrdersForm — Limit + DCA order placement (dual-lane).
//   • Limit: one-shot. minOutPerTranche = amountIn × limit price (dst units).
//   • DCA:   N tranches every `interval`. trancheIn = amountIn / N; an optional
//            min price sets a per-tranche slippage floor (else market).
// Fills happen automatically once the price is met; the filler earns a small fee
// (0.10%, ≤0.50% cap). Orders expire after 7 days.
//
// The compact flow strip below the CTA is a TRUTHFUL look-ahead + live tracker:
// the Solana lane is one signature; the EVM lane names the exact prompt count
// from a real chain read (account setup, then the order). Steps advance from the
// actual placement callbacks; on success the tx hash lands in the strip; on
// failure it says nothing moved.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { useActionFlow } from "./useActionFlow";
import FlowStrip, { type FlowCopy } from "./FlowStrip";
import type { FlowStep } from "@/lib/flowState";
import {
  pairsOf,
  pairById,
  poolForTier,
} from "@/lib/walletActions";
import {
  placeOrder,
  placeOrderEvm,
  previewOrderEvm,
  saveTrackedOrder,
  KEEPER_FEE_BPS,
  MAX_KEEPER_FEE_BPS,
} from "@/lib/orders";
import { tokenMeta } from "@/lib/tokens";
import { fmtRaw } from "@/lib/format";
import { toTxStatus } from "@/lib/txerror";
import { explorerUrl } from "@/lib/explorer";

type Dir = "AtoB" | "BtoA";
type OrderKind = "limit" | "dca";
type ActiveLane = "evm" | "solana";

// Fixed price precision for exact BigInt min-out math (no float rounding).
const PRICE_SCALE = 12;

const KEEPER_FEE_PCT = (KEEPER_FEE_BPS / 100).toFixed(2); // "0.10"
const KEEPER_FEE_CAP_PCT = (MAX_KEEPER_FEE_BPS / 100).toFixed(2); // "0.50"

const INTERVAL_UNITS: { id: string; label: string; secs: number }[] = [
  { id: "min", label: "min", secs: 60 },
  { id: "hour", label: "hour", secs: 3600 },
  { id: "day", label: "day", secs: 86400 },
];

/** Human decimal string → raw smallest-unit BigInt (null if unparseable). */
function parseHuman(s: string, dec: number): bigint | null {
  if (!s || s === ".") return null;
  try {
    const [whole, frac = ""] = s.split(".");
    return BigInt(whole || "0") * 10n ** BigInt(dec) + BigInt(frac.slice(0, dec).padEnd(dec, "0") || "0");
  } catch {
    return null;
  }
}

/**
 * min-out (dst raw) for a given input (src raw) at a limit price (dst per 1 src,
 * human). Exact BigInt: minOut = trancheIn × price × 10^decDst / 10^(decSrc+P).
 */
function priceToMinOut(trancheInRaw: bigint, priceStr: string, decSrc: number, decDst: number): bigint {
  const scaled = parseHuman(priceStr, PRICE_SCALE);
  if (!scaled || scaled <= 0n || trancheInRaw <= 0n) return 0n;
  return (trancheInRaw * scaled * 10n ** BigInt(decDst)) / 10n ** BigInt(decSrc + PRICE_SCALE);
}

export default function OrdersForm({ kind }: { kind: OrderKind }) {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const flowApi = useActionFlow();
  const pairs = useMemo(() => (chain ? pairsOf(chain) : []), [chain]);
  const [pairId, setPairId] = useState<string>("");
  const [tier, setTier] = useState<string>("0.30%");
  const [dir, setDir] = useState<Dir>("AtoB");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [tranches, setTranches] = useState("4");
  const [intervalVal, setIntervalVal] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState("hour");
  const [spotByTier, setSpotByTier] = useState<Record<string, number>>({});
  const [planHint, setPlanHint] = useState("");

  // Default the selected pair to the chain's first pair once chains resolve.
  useEffect(() => {
    if (!pairId && pairs.length) setPairId(pairs[0].pairId);
  }, [pairs, pairId]);

  const pair = useMemo(() => (chain ? pairById(chain, pairId) : undefined), [chain, pairId]);
  // Reset the tier if the selected pair doesn't offer it.
  useEffect(() => {
    if (pair && !pair.tiers.some((t) => t.tier === tier)) setTier(pair.tiers[0]?.tier ?? "0.30%");
  }, [pair, tier]);

  const pool = useMemo(() => (chain ? poolForTier(chain, tier, pairId) : null), [chain, tier, pairId]);
  const srcSym = dir === "AtoB" ? (pair?.symbolA ?? "A") : (pair?.symbolB ?? "B");
  const dstSym = dir === "AtoB" ? (pair?.symbolB ?? "B") : (pair?.symbolA ?? "A");
  const decSrc = dir === "AtoB" ? (pair?.decimalsA ?? 6) : (pair?.decimalsB ?? 9);
  const decDst = dir === "AtoB" ? (pair?.decimalsB ?? 9) : (pair?.decimalsA ?? 6);

  const activeLane: ActiveLane | null = wallet.evm ? "evm" : wallet.solana ? "solana" : null;

  // Best-effort market reference (wallet-independent, like the swap quote). Never
  // blocks placement; failures are swallowed.
  const loadSpot = useCallback(async () => {
    try {
      const res = await fetch(`/api/tiers?dir=${dir}&pairId=${encodeURIComponent(pairId)}`, { cache: "no-store" });
      const data = await res.json();
      if (!Array.isArray(data?.tiers)) return;
      const map: Record<string, number> = {};
      for (const t of data.tiers) {
        // spotPrice is raw reserveOut/reserveIn → human dst-per-src.
        if (typeof t.spotPrice === "number") map[t.tier] = t.spotPrice * 10 ** (decSrc - decDst);
      }
      setSpotByTier(map);
    } catch {
      /* reference only */
    }
  }, [dir, pairId, decSrc, decDst]);
  useEffect(() => { setSpotByTier({}); loadSpot(); }, [loadSpot]);

  const marketRate = spotByTier[tier];

  // ---- derived order params ----
  const amountRaw = parseHuman(amount, decSrc);
  const trancheCount = kind === "dca" ? Math.max(1, Math.floor(Number(tranches) || 0)) : 1;
  const trancheInRaw = amountRaw && trancheCount > 0 ? amountRaw / BigInt(trancheCount) : null;
  const intervalSecs = kind === "dca"
    ? BigInt(Math.max(0, Math.floor(Number(intervalVal) || 0)) * (INTERVAL_UNITS.find((u) => u.id === intervalUnit)?.secs ?? 3600))
    : 0n;
  // Limit → per-order floor over the full amount; DCA → optional per-tranche floor.
  const minOutPerTranche = kind === "limit"
    ? (amountRaw ? priceToMinOut(amountRaw, limitPrice, decSrc, decDst) : 0n)
    : (limitPrice.trim() && trancheInRaw ? priceToMinOut(trancheInRaw, limitPrice, decSrc, decDst) : 0n);

  const inputsValid = kind === "limit"
    ? Boolean(amountRaw && amountRaw > 0n && minOutPerTranche > 0n)
    : Boolean(amountRaw && amountRaw > 0n && trancheCount >= 2 && trancheInRaw && trancheInRaw > 0n && intervalSecs > 0n);

  const busy = flowApi.flow.phase === "running";

  function selectPair(id: string) {
    setPairId(id);
    setDir("AtoB");
  }
  function flip() {
    setDir((d) => (d === "AtoB" ? "BtoA" : "AtoB"));
    setLimitPrice("");
  }
  function useMarket() {
    if (marketRate && marketRate > 0) setLimitPrice(marketRate < 1 ? marketRate.toFixed(8) : marketRate.toFixed(6));
  }

  // ── Journey look-ahead ────────────────────────────────────────────────────
  // Publish a TRUTHFUL per-user plan once the order inputs are placeable: the
  // Solana lane is one signature; the EVM lane reads the chain for the honest
  // wallet-prompt count (account setup, then the order).
  const kindWord = kind === "dca" ? "DCA" : "limit";
  const planKey = inputsValid && activeLane
    ? `${activeLane}|${kind}|${pairId}|${tier}|${dir}|${amount}`
    : null;
  const plannedKey = useRef<string | null>(null);
  useEffect(() => {
    const phase = flowApi.flow.phase;
    if (phase === "running") return;
    if (!planKey || !activeLane) {
      plannedKey.current = null;
      if (phase === "idle") flowApi.reset();
      return;
    }
    if (phase !== "idle" && planKey === plannedKey.current) return;

    let cancelled = false;
    const confirm: FlowStep = { id: "confirm", title: `Confirm your ${kindWord} order`, state: "todo" };
    const live: FlowStep = { id: "live", title: "Your order goes live", sub: "it fills automatically once your price is met", state: "todo" };

    if (activeLane === "solana") {
      plannedKey.current = planKey;
      setPlanHint("One quick signature in your wallet");
      flowApi.plan("sol", [confirm, live], false);
      return;
    }
    // EVM lane: read the chain for the honest prompt count.
    (async () => {
      let prompts = 2;
      try { if (chain) prompts = (await previewOrderEvm(chain, wallet.evm!)).prompts; } catch { /* keep default */ }
      if (cancelled) return;
      const totalWord = prompts === 2 ? "Two" : prompts === 3 ? "Three" : String(prompts);
      const setup: FlowStep = { id: "setup", title: "Set up your order account", sub: "a quick one-time setup", state: "todo" };
      plannedKey.current = planKey;
      setPlanHint(`${totalWord} quick prompts: account setup, then your order`);
      flowApi.plan("evm", [setup, confirm, live], true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, flowApi.flow.phase]);

  const flowCopy: FlowCopy = {
    eyebrow: `Your ${kindWord} order · step by step`,
    doneVerb: "placed",
    extraTag: "includes a quick account setup",
    idleHint: planHint,
    successHint: "Your order is live — it fills automatically once your price is met",
  };

  async function place() {
    if (!activeLane || !amountRaw || !chain || !pool) return;
    flowApi.start();
    try {
      const trancheIn = kind === "limit" ? amountRaw : (trancheInRaw ?? amountRaw);
      const common = { pool, aToB: dir === "AtoB", amountInTotal: amountRaw, trancheIn, minOutPerTranche, intervalSecs };
      let trackKey: string, pda: string, nonce: bigint, txHash: string;
      if (activeLane === "solana" && wallet.solana) {
        const r = await placeOrder(chain, { ownerPubkey: wallet.solana, ...common, onSign: () => flowApi.step("confirm", "active") });
        trackKey = wallet.solana; pda = r.pda; nonce = r.nonce; txHash = r.signature;
      } else if (activeLane === "evm" && wallet.evm) {
        // EVM lane: account setup (escrow, and a one-time funding for a cold
        // wallet) then the order — a few prompts, tracked from the callbacks.
        const r = await placeOrderEvm(chain, {
          eoa: wallet.evm,
          ...common,
          onStage: (s) => {
            if (s === "setup") flowApi.step("setup", "active");
            if (s === "place") flowApi.step("confirm", "active");
          },
        });
        trackKey = r.owner; pda = r.pda; nonce = r.nonce; txHash = r.txHash;
      } else return;
      saveTrackedOrder(trackKey, {
        pda, nonce: nonce.toString(), pairId, tier, aToB: dir === "AtoB", kind, placedAt: Date.now(),
      });
      flowApi.succeed(txHash, explorerUrl(txHash, chain));
      setAmount("");
      setLimitPrice("");
    } catch (e) {
      const { cancelled, message } = toTxStatus(e);
      flowApi.fail(cancelled ? "Cancelled in your wallet — nothing moved." : `${message} Nothing moved.`);
    }
  }

  const glyphSrc = tokenMeta(srcSym), glyphDst = tokenMeta(dstSym);

  const buttonLabel = busy
    ? "Placing…"
    : !amountRaw
    ? "Enter an amount"
    : kind === "limit" && minOutPerTranche <= 0n
    ? "Enter a limit price"
    : kind === "dca" && trancheCount < 2
    ? "Use 2+ tranches"
    : kind === "dca" && intervalSecs <= 0n
    ? "Set an interval"
    : `Place ${kindWord} order`;

  return (
    <div className="card" data-testid="orders-form">
      <p className="label" style={{ marginBottom: 0 }}>
        <span>{kind === "dca" ? "DCA order" : "Limit order"}</span>
        <span className="mono" style={{ fontSize: 13.5, color: "var(--fg3)" }}>native · fills automatically</span>
      </p>

      {/* Dual-lane: the Solana or EVM lane. EVM placement runs a few txs
          (create escrows, then the order) — noted so the multi-prompt flow
          isn't a surprise; the strip below names the exact count. */}
      {activeLane === "evm" && (
        <div className="note" data-testid="orders-evm-note" style={{ marginTop: 14 }}>
          EVM lane: placing runs a couple of quick account-setup prompts, then the order — approve each in your wallet.
        </div>
      )}
      {!activeLane && (
        <div className="note" data-testid="orders-connect-note" style={{ marginTop: 14 }}>
          Connect an EVM or Solana wallet to place limit &amp; DCA orders.
        </div>
      )}

      {/* Pair */}
      <div className="rowhead" style={{ marginTop: 16, marginBottom: 6 }}>
        <span className="side">Pair</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-testid="orders-pair-chips">
        {pairs.map((p) => (
          <button
            key={p.pairId}
            data-testid={`orders-pair-${p.pairId}`}
            className={`tier-chip${p.pairId === pairId ? " active" : ""}`}
            aria-pressed={p.pairId === pairId}
            onClick={() => selectPair(p.pairId)}
          >
            {p.pairName}
          </button>
        ))}
      </div>

      {/* Tier */}
      <div className="rowhead" style={{ marginTop: 14, marginBottom: 6 }}>
        <span className="side">Fee tier</span>
        <span className="side mono" style={{ color: "var(--rome-purple)" }}>{tier}</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(pair?.tiers ?? []).map((t) => (
          <button
            key={t.tier}
            data-testid={`orders-tier-${t.tier}`}
            className={`tier-chip${t.tier === tier ? " active" : ""}`}
            aria-pressed={t.tier === tier}
            style={{ fontFamily: "var(--font-mono)" }}
            onClick={() => setTier(t.tier)}
          >
            {t.tier}
          </button>
        ))}
      </div>

      {/* Direction */}
      <div className="rowhead" style={{ marginTop: 16, marginBottom: 6 }}>
        <span className="side">You sell</span>
        <button data-testid="orders-flip" className="lane-btn" style={{ fontSize: 13.5 }} onClick={flip} aria-label="Flip direction">
          ⇅ {srcSym} → {dstSym}
        </button>
      </div>
      <div className="tokenrow">
        <div className="lbl"><span>Sell {srcSym}{kind === "dca" ? " (total)" : ""}</span></div>
        <div className="mid">
          <input
            className="amt"
            data-testid="orders-amount"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); }}
          />
          <span className="tselect"><span className="tglyph" style={{ background: glyphSrc.grad }}>{glyphSrc.glyph}</span>{srcSym}</span>
        </div>
      </div>

      {/* Limit price (required for limit, optional min for DCA) */}
      <div className="rowhead" style={{ marginTop: 14, marginBottom: 6 }}>
        <span className="side">{kind === "dca" ? `Min price ${dstSym}/${srcSym} (optional)` : `Limit price ${dstSym}/${srcSym}`}</span>
        {marketRate != null && marketRate > 0 && (
          <button data-testid="orders-use-market" className="lane-btn" style={{ fontSize: 13.5 }} onClick={useMarket}>
            market {marketRate < 1 ? marketRate.toFixed(6) : marketRate.toFixed(4)} · use
          </button>
        )}
      </div>
      <div className="tokenrow">
        <div className="lbl"><span>1 {srcSym} =</span></div>
        <div className="mid">
          <input
            className="amt"
            data-testid="orders-price"
            inputMode="decimal"
            placeholder="0.0"
            value={limitPrice}
            onChange={(e) => { setLimitPrice(e.target.value.replace(/[^0-9.]/g, "")); }}
          />
          <span className="tselect"><span className="tglyph" style={{ background: glyphDst.grad }}>{glyphDst.glyph}</span>{dstSym}</span>
        </div>
      </div>

      {/* DCA schedule */}
      {kind === "dca" && (
        <div style={{ marginTop: 14 }}>
          <div className="rowhead" style={{ marginBottom: 6 }}><span className="side">Schedule</span></div>
          <div className="amount-row">
            <input
              data-testid="orders-tranches"
              inputMode="numeric"
              placeholder="4"
              value={tranches}
              onChange={(e) => { setTranches(e.target.value.replace(/[^0-9]/g, "")); }}
              style={{ flex: 1 }}
            />
            <span className="side mono" style={{ flexShrink: 0 }}>tranches, every</span>
            <input
              data-testid="orders-interval"
              inputMode="numeric"
              placeholder="1"
              value={intervalVal}
              onChange={(e) => { setIntervalVal(e.target.value.replace(/[^0-9]/g, "")); }}
              style={{ width: 56 }}
            />
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {INTERVAL_UNITS.map((u) => (
                <button
                  key={u.id}
                  data-testid={`orders-unit-${u.id}`}
                  className={`tier-chip${intervalUnit === u.id ? " active" : ""}`}
                  aria-pressed={intervalUnit === u.id}
                  onClick={() => setIntervalUnit(u.id)}
                >
                  {u.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="route" data-testid="orders-summary" style={{ marginTop: 16 }}>
        {kind === "dca" ? (
          <>
            <div className="r"><span>Per tranche</span><b data-testid="orders-per-tranche">{trancheInRaw ? `${fmtRaw(trancheInRaw, decSrc)} ${srcSym}` : "—"}</b></div>
            <div className="r"><span>Fills</span><b>{trancheCount >= 2 ? `${trancheCount} × every ${intervalVal || "?"} ${intervalUnit}` : "—"}</b></div>
            <div className="r"><span>Min out / tranche</span><b>{minOutPerTranche > 0n ? `${fmtRaw(minOutPerTranche, decDst)} ${dstSym}` : "Market"}</b></div>
          </>
        ) : (
          <>
            <div className="r"><span>Sell</span><b>{amountRaw ? `${fmtRaw(amountRaw, decSrc)} ${srcSym}` : "—"}</b></div>
            <div className="r"><span>Min received</span><b data-testid="orders-min-out">{minOutPerTranche > 0n ? `${fmtRaw(minOutPerTranche, decDst)} ${dstSym}` : "—"}</b></div>
          </>
        )}
        <div className="r"><span>Fill fee</span><b>{KEEPER_FEE_PCT}% <span style={{ color: "var(--faint)", fontWeight: 400 }}>(≤{KEEPER_FEE_CAP_PCT}% cap)</span></b></div>
        <div className="r"><span>Expires</span><b>in 7 days</b></div>
        <div className="r"><span>Fills</span><b>automatically, once your price is met</b></div>
      </div>

      {/* CTA */}
      {!activeLane ? (
        <button className="btn block" data-testid="orders-place-btn" style={{ marginTop: 16 }} onClick={() => wallet.connect("solana")}>
          Connect a wallet
        </button>
      ) : (
        <button
          className="btn block"
          data-testid="orders-place-btn"
          style={{ marginTop: 16 }}
          onClick={place}
          disabled={!inputsValid || busy}
        >
          {buttonLabel}
        </button>
      )}

      <FlowStrip flow={flowApi.flow} testid="ordflow" copy={flowCopy} containerTestId="orders-flow" />
    </div>
  );
}
