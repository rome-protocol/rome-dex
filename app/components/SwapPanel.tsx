"use client";

// SwapPanel — best-in-class DEX swap UI wired to live reserves.
// Quotes come from /api/tiers (per-fee-tier, server-side sdk/quote.mjs mirror);
// the UI shows a fee-tier selector (Auto = best-price tier) and routes the swap
// to the SELECTED tier's pool on whichever lane signs.
// Execution routes:
//   • the EVM wallet connected → EVM lane via the RomeDexRouter (approve-once SPL
//     delegate to the router PDA, then a single-leg atomic swap; lib/router.ts)
//   • the Solana wallet connected  → Solana lane client-side (direct ix via window.solana)
//   • Neither connected  → the CTA reads "Connect wallet" and is disabled. There
//     is NO backend/demo signer — a swap only ever signs with the user's wallet.
// the EVM wallet takes priority when both are connected.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { useSwapFlow, type FlowStep } from "./SwapFlow";
import {
  solanaSwap,
  evmPdaFor,
  ataFor,
  pairsOf,
  pairById,
  defaultPairId,
} from "@/lib/walletActions";
import { allowanceOk, routerSwap } from "@/lib/router";
import UsdValue from "./UsdValue";
import { tokenMeta } from "@/lib/tokens";
import { PairGlyphs } from "./PairGlyphs";
import { networkPriorityFeeGwei } from "@/lib/gas";
import { toTxStatus } from "@/lib/txerror";
import { explorerUrl } from "@/lib/explorer";

// Token descriptors for the live pool. A = 6 dec, B = 9 dec.
type Dir = "AtoB" | "BtoA";
type SwapMode = "exactIn" | "exactOut";

interface QuoteResult {
  amountIn: string;
  amountOut: string;
  feePaid: string;
  price: number;
  priceImpactPct: number;
  minReceived?: string; // exact-in
  maxSold?: string;     // exact-out
}

// Per-tier quote row from /api/tiers.
interface TierRow {
  tier: string;
  bps: number;
  spotPrice: number;
  amountIn: string | null;
  amountOut: string | null;
  feePaid: string | null;
  isBest: boolean;
}

interface ApiTiersResponse {
  dir: Dir;
  mode: SwapMode;
  bestTier: string | null;
  tiers: TierRow[];
  decimalsA: number;
  decimalsB: number;
  error?: string;
}

// "Auto" = follow the best tier the server picks; otherwise a fixed tier label.
type TierChoice = "auto" | string;

// Priority-fee (EVM tip) preset.
type TipPreset = "normal" | "fast" | "custom";

type SwapStatus = {
  kind: "ok" | "err" | "pending" | "cancelled";
  msg: string;
  txHash?: string;
  explorerUrl?: string;
} | null;

// A token descriptor derived from a pair side. Labels stay generic ("Token X")
// for bare single/double-letter symbols (test pools); a real symbol is the label.
// The test pool is A/B (no feed → no USD); a real pool like USDC/SOL lights USD up.
interface TokenDesc { sym: string; label: string; dec: number; color: string }
const isBare = (s: string) => s.length <= 2;
function tokenDesc(sym: string, dec: number, color: string): TokenDesc {
  return { sym, label: isBare(sym) ? `Token ${sym}` : sym, dec, color };
}

// Format a raw BigInt string (smallest unit) to human-readable given decimals.
function fmtRaw(raw: string | bigint | undefined, dec: number, sigfigs = 6): string {
  if (raw == null || raw === "") return "—";
  try {
    const n = BigInt(raw);
    const base = 10n ** BigInt(dec);
    const whole = n / base;
    const frac = (n % base).toString().padStart(dec, "0");
    const trimmed = frac.slice(0, sigfigs).replace(/0+$/, "");
    return trimmed ? `${whole}.${trimmed}` : `${whole}`;
  } catch { return "—"; }
}

// Parse a human-readable string into raw smallest-unit BigInt.
function parseHuman(s: string, dec: number): bigint | null {
  if (!s || s === "." || s === "") return null;
  try {
    const [whole, frac = ""] = s.split(".");
    const fracPadded = frac.slice(0, dec).padEnd(dec, "0");
    return BigInt(whole || "0") * 10n ** BigInt(dec) + BigInt(fracPadded || "0");
  } catch { return null; }
}

function impactClass(pct: number): string {
  if (pct < 0.5) return "";
  if (pct < 2) return "impact-mid";
  return "impact-high";
}

type ActiveLane = "evm" | "solana";

export default function SwapPanel() {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const pairs = useMemo(() => (chain ? pairsOf(chain) : []), [chain]);
  const [pairId, setPairId] = useState<string>("");
  const [showPairModal, setShowPairModal] = useState(false);
  const [dir, setDir] = useState<Dir>("AtoB");
  const [mode, setMode] = useState<SwapMode>("exactIn");

  // Default the pair to the chain's first pair once chains resolve.
  useEffect(() => {
    if (!pairId && chain) setPairId(defaultPairId(chain));
  }, [chain, pairId]);

  // Active pair + its two token descriptors. Selecting a pair re-points the swap.
  const pair = useMemo(() => (chain ? pairById(chain, pairId) : undefined), [chain, pairId]);
  const tokenA = useMemo(() => tokenDesc(pair?.symbolA ?? "A", pair?.decimalsA ?? 6, "var(--rome-purple)"), [pair]);
  const tokenB = useMemo(() => tokenDesc(pair?.symbolB ?? "B", pair?.decimalsB ?? 9, "var(--rome-dark-purple)"), [pair]);
  const tokenOf = useCallback(
    (d: Dir, side: "in" | "out"): TokenDesc =>
      d === "AtoB" ? (side === "in" ? tokenA : tokenB) : (side === "in" ? tokenB : tokenA),
    [tokenA, tokenB],
  );
  const [inputVal, setInputVal] = useState("");   // top field (You pay)
  const [outputVal, setOutputVal] = useState(""); // bottom field (You receive)
  const [tiersData, setTiersData] = useState<ApiTiersResponse | null>(null);
  const [tierChoice, setTierChoice] = useState<TierChoice>("auto"); // "auto" or a tier label
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<SwapStatus>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  // Priority fee (EVM tip): "normal" = congestion-aware network default,
  // "fast" = default + 1 gwei, "custom" = user-entered gwei.
  const [tipPreset, setTipPreset] = useState<TipPreset>("normal");
  const [customTipGwei, setCustomTipGwei] = useState("");
  const [showTipSettings, setShowTipSettings] = useState(false);
  const [networkTipGwei, setNetworkTipGwei] = useState<number | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Suppress debounce when the non-active field is updated programmatically by quote response
  const suppressDebounce = useRef(false);

  // Determine which lane is active. the EVM wallet takes priority. null = no wallet.
  const activeLane: ActiveLane | null = wallet.evm
    ? "evm"
    : wallet.solana
    ? "solana"
    : null;

  // Surface the congestion-aware network default tip (EVM lane only).
  useEffect(() => {
    if (activeLane !== "evm" || !chain) return;
    let cancelled = false;
    networkPriorityFeeGwei(chain.evmRpc)
      .then((g) => { if (!cancelled) setNetworkTipGwei(g); })
      .catch(() => { if (!cancelled) setNetworkTipGwei(0); });
    return () => { cancelled = true; };
  }, [activeLane, chain]);

  // Resolve the effective tip (gwei) to pass to routerSwap. undefined → let the
  // resolver use the live network default at send time.
  const effectiveTipGwei: number | undefined = (() => {
    if (tipPreset === "custom") {
      const v = parseFloat(customTipGwei);
      return Number.isFinite(v) && v >= 0 ? v : undefined;
    }
    if (tipPreset === "fast") return (networkTipGwei ?? 0) + 1;
    return undefined; // "normal" → network default
  })();

  const tokenIn = tokenOf(dir, "in");
  const tokenOut = tokenOf(dir, "out");
  const decIn = tokenIn.dec, decOut = tokenOut.dec;

  // Which tier's quote is active: the server's best when "auto", else the picked tier.
  const bestTier = tiersData?.bestTier ?? null;
  const activeTier: string | null =
    tierChoice === "auto" ? bestTier : tierChoice;
  const activeRow: TierRow | undefined =
    tiersData?.tiers.find((t) => t.tier === activeTier) ??
    tiersData?.tiers.find((t) => t.isBest);

  // Build a QuoteResult (with derived price-impact + slippage bound) from the
  // active tier's row. Mirrors the math /api/quote used to do server-side.
  const q: QuoteResult | null = (() => {
    if (!activeRow || activeRow.amountIn == null || activeRow.amountOut == null) return null;
    const amountIn = BigInt(activeRow.amountIn);
    const amountOut = BigInt(activeRow.amountOut);
    const spot = activeRow.spotPrice;
    if (mode === "exactIn") {
      const price = amountIn === 0n ? 0 : Number(amountOut) / Number(amountIn);
      const impact = spot > 0 ? Math.max(0, (1 - price / spot) * 100) : 0;
      return {
        amountIn: activeRow.amountIn, amountOut: activeRow.amountOut,
        feePaid: activeRow.feePaid ?? "0", price, priceImpactPct: impact,
        minReceived: ((amountOut * 995n) / 1000n).toString(),
      };
    }
    const execRate = amountOut === 0n ? 0 : Number(amountIn) / Number(amountOut);
    const impact = spot > 0 ? Math.max(0, (execRate / spot - 1) * 100) : 0;
    return {
      amountIn: activeRow.amountIn, amountOut: activeRow.amountOut,
      feePaid: activeRow.feePaid ?? "0", price: execRate, priceImpactPct: impact,
      maxSold: ((amountIn * 1005n) / 1000n).toString(),
    };
  })();

  const swapFlow = useSwapFlow();

  // ── Journey look-ahead ────────────────────────────────────────────────────
  // Publish a TRUTHFUL per-user plan to the journey strip whenever a quote is
  // live: the one-time-approval step appears only when a real allowance read
  // says that prompt will actually happen for THIS wallet and amount.
  const planKey = q ? `${activeLane}|${pairId}|${dir}|${mode}|${q.amountIn}|${activeTier}` : null;
  const plannedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!swapFlow) return;
    const phase = swapFlow.flow.phase;
    if (phase === "running") return; // never touch a live run
    if (!q || !activeLane) {
      plannedKey.current = null;
      // Keep a success/error receipt on screen; only clear a stale plan.
      if (phase === "idle") swapFlow.reset();
      return;
    }
    // A terminal receipt stays until the user actually re-quotes.
    if (phase !== "idle" && planKey === plannedKey.current) return;
    let cancelled = false;
    const inSym = tokenIn.sym, outSym = tokenOut.sym;
    const spend = mode === "exactIn" ? BigInt(q.amountIn) : BigInt(q.maxSold ?? q.amountIn);
    const receiveSub =
      mode === "exactIn" && q.minReceived
        ? `at least ${fmtRaw(q.minReceived, decOut)} ${outSym} — your minimum, enforced on-chain`
        : `exactly ${fmtRaw(q.amountOut, decOut)} ${outSym}, or the trade doesn't happen`;
    const tail: FlowStep[] = [
      { id: "confirm", title: "Confirm in your wallet", state: "todo" },
      {
        id: "swap",
        title: `${inSym} → ${outSym} on the shared pool`,
        sub: `${activeTier ?? ""} fee tier · settles as one transaction`,
        state: "todo",
      },
      { id: "receive", title: `${outSym} lands in your wallet`, sub: receiveSub, state: "todo" },
    ];
    if (activeLane === "solana") {
      plannedKey.current = planKey;
      swapFlow.plan("sol", tail, false);
      return;
    }
    // EVM lane: read the chain to see whether the approval prompt will happen.
    (async () => {
      let needsApproval = false;
      try {
        if (!chain || !pair) throw new Error("chain not ready");
        const userPda = evmPdaFor(wallet.evm!, chain.romeEvmProgramId);
        const srcMint = dir === "AtoB" ? pair.mintA : pair.mintB;
        const srcAta = await ataFor(userPda, new PublicKey(srcMint));
        needsApproval = !(await allowanceOk(chain, srcAta, spend));
      } catch {
        // Unknown → don't promise either way; show the approval as possible.
        needsApproval = true;
      }
      if (cancelled || !swapFlow) return;
      plannedKey.current = planKey;
      const steps: FlowStep[] = needsApproval
        ? [
            {
              id: "approve",
              title: `One-time approval for your ${inSym}`,
              sub: "a quick extra confirmation — only needed this first time",
              state: "todo",
            },
            ...tail,
          ]
        : tail;
      swapFlow.plan("evm", steps, needsApproval);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, swapFlow?.flow.phase]);


  // Fetch per-tier quotes from the server
  const fetchQuote = useCallback(async (val: string, d: Dir, m: SwapMode) => {
    const dec = m === "exactIn" ? tokenOf(d, "in").dec : tokenOf(d, "out").dec;
    const raw = parseHuman(val, dec);
    if (!raw || raw <= 0n) { setTiersData(null); setQuoting(false); return; }

    setQuoting(true);
    try {
      const param = m === "exactIn" ? `amountIn=${raw}` : `amountOut=${raw}`;
      const res = await fetch(`/api/tiers?${param}&dir=${d}&pairId=${encodeURIComponent(pairId)}`, { cache: "no-store" });
      const data: ApiTiersResponse = await res.json();
      setTiersData(data);
      // Populate the OTHER field from the active tier's quote (best when auto).
      const rowSel: TierChoice = data.bestTier ?? "auto";
      const row =
        (tierChoice === "auto" ? data.tiers.find((t) => t.isBest) : data.tiers.find((t) => t.tier === tierChoice)) ??
        data.tiers.find((t) => t.tier === rowSel);
      if (row && row.amountIn != null && row.amountOut != null) {
        suppressDebounce.current = true;
        if (m === "exactIn") {
          setOutputVal(fmtRaw(row.amountOut, tokenOf(d, "out").dec));
        } else {
          setInputVal(fmtRaw(row.amountIn, tokenOf(d, "in").dec));
        }
      }
    } catch { setTiersData(null); }
    setQuoting(false);
  }, [tierChoice, pairId, tokenOf]);

  // Debounce quote fetch on input changes
  useEffect(() => {
    // Skip if this state update was caused by a quote response populating the other field
    if (suppressDebounce.current) { suppressDebounce.current = false; return; }
    if (debounce.current) clearTimeout(debounce.current);
    const activeVal = mode === "exactIn" ? inputVal : outputVal;
    if (!activeVal) { setTiersData(null); return; }
    debounce.current = setTimeout(() => fetchQuote(activeVal, dir, mode), 350);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [inputVal, outputVal, dir, mode, tierChoice, fetchQuote]);

  // Fetch wallet balance for the input token
  const fetchBalance = useCallback(async (solanaRpc: string, mint: PublicKey, owner: PublicKey) => {
    try {
      const ata = await ataFor(owner, mint);
      const res = await fetch(solanaRpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenAccountBalance",
          params: [ata.toBase58()],
        }),
      });
      const data = await res.json();
      const amount = data?.result?.value?.amount;
      if (amount) return BigInt(amount);
      return 0n;
    } catch { return 0n; }
  }, []);

  // Re-fetch balance when dir or wallet changes
  useEffect(() => {
    if (!activeLane || !chain || !pair) { setWalletBalance(null); return; }
    const inputMint = dir === "AtoB" ? pair.mintA : pair.mintB;

    let cancelled = false;
    (async () => {
      let owner: PublicKey | null = null;
      if (activeLane === "evm" && wallet.evm) {
        owner = evmPdaFor(wallet.evm, chain.romeEvmProgramId);
      } else if (activeLane === "solana" && wallet.solana) {
        try { owner = new PublicKey(wallet.solana); } catch { /* invalid key */ }
      }
      if (!owner) { setWalletBalance(null); return; }
      const bal = await fetchBalance(chain.solanaRpc, inputMint, owner);
      if (!cancelled) setWalletBalance(bal);
    })();
    return () => { cancelled = true; };
  }, [dir, activeLane, chain, wallet.evm, wallet.solana, fetchBalance, pair]);

  function flip() {
    setDir((d) => (d === "AtoB" ? "BtoA" : "AtoB"));
    setInputVal("");
    setOutputVal("");
    setTiersData(null);
    setStatus(null);
    setMode("exactIn");
  }

  // Switch the active pair: reset amounts, direction, tier, and quote state.
  function selectPair(id: string) {
    setPairId(id);
    setShowPairModal(false);
    setDir("AtoB");
    setMode("exactIn");
    setInputVal("");
    setOutputVal("");
    setTiersData(null);
    setTierChoice("auto");
    setStatus(null);
  }

  // Check insufficient balance
  const parsedInput = parseHuman(inputVal, decIn);
  const isInsufficientBalance =
    walletBalance !== null &&
    parsedInput !== null &&
    parsedInput > walletBalance &&
    activeLane !== null;

  const hasQuote = Boolean(q);
  const canSwap = Boolean(activeLane) && hasQuote && !status?.kind.includes("pending") && !isInsufficientBalance;

  // Fee label follows the active tier (its label IS the total fee, e.g. "0.30%").
  const feeLabel = `Fee (${activeTier ?? "—"})`;

  // spotPrice from the active tier is a RAW reserve ratio (reserveOut/reserveIn),
  // oriented for `dir`. Adjust for token decimals so the displayed rate is in
  // human units: human = rawSpot × 10^(decIn − decOut).
  const spotPrice = activeRow?.spotPrice;
  const humanSpot =
    spotPrice != null ? spotPrice * 10 ** (decIn - decOut) : undefined;
  // Sensible precision: small rates (< 1) need more decimals to read.
  const spotDigits = humanSpot != null && humanSpot < 1 ? 6 : 4;
  const spotDisplay = humanSpot
    ? `1 ${tokenIn.sym} = ${humanSpot.toFixed(spotDigits)} ${tokenOut.sym}`
    : null;

  async function executeSwap() {
    if (!q || !chain) return;

    if (activeLane === "evm") {
      setStatus({ kind: "pending", msg: "Confirm the swap in your wallet…" });
      swapFlow?.start();
      try {
        // The EVM lane routes through the RomeDexRouter: approve-once (SPL
        // delegate to the router PDA), then a single-leg atomic swap. onApprove
        // fires only when a delegate allowance must be granted first. onStage
        // narrates the journey strip from what ACTUALLY happens on-chain.
        const onApprove = () =>
          setStatus({ kind: "pending", msg: `Approve rome-dex to trade your ${tokenIn.sym}…` });
        const onStage = (stage: "approve" | "approved" | "sign") => {
          if (stage === "approve") swapFlow?.step("approve", "active");
          if (stage === "approved") swapFlow?.step("approve", "done");
          if (stage === "sign") swapFlow?.step("confirm", "active");
        };
        let txHash: string;
        if (mode === "exactIn") {
          txHash = await routerSwap({
            chain,
            eoa: wallet.evm!,
            dir,
            mode: "exactIn",
            tier: activeTier ?? undefined,
            pairId,
            amountIn: BigInt(q.amountIn),
            minOut: BigInt(q.minReceived ?? "0"),
            priorityFeeGwei: effectiveTipGwei,
            onApprove,
            onStage,
          });
        } else {
          txHash = await routerSwap({
            chain,
            eoa: wallet.evm!,
            dir,
            mode: "exactOut",
            tier: activeTier ?? undefined,
            pairId,
            amountOut: BigInt(q.amountOut),
            maxIn: BigInt(q.maxSold ?? "0"),
            priorityFeeGwei: effectiveTipGwei,
            onApprove,
            onStage,
          });
        }
        setStatus({
          kind: "ok",
          msg: "Swap confirmed",
          txHash,
          explorerUrl: explorerUrl(txHash, chain),
        });
        swapFlow?.succeed(txHash, explorerUrl(txHash, chain));
        setInputVal(""); setOutputVal(""); setTiersData(null);
      } catch (e: unknown) {
        const { cancelled, message } = toTxStatus(e);
        setStatus({ kind: cancelled ? "cancelled" : "err", msg: message });
        swapFlow?.fail(cancelled ? "Cancelled in your wallet — nothing moved." : `${message} Nothing moved.`);
      }
      return;
    }

    if (activeLane === "solana") {
      setStatus({ kind: "pending", msg: "Confirm the swap in your wallet…" });
      swapFlow?.start();
      try {
        const onStage = () => swapFlow?.step("confirm", "active");
        let sig: string;
        if (mode === "exactIn") {
          sig = await solanaSwap({
            chain,
            userPubkey: wallet.solana!,
            dir,
            mode: "exactIn",
            tier: activeTier ?? undefined,
            pairId,
            amountIn: BigInt(q.amountIn),
            minOut: BigInt(q.minReceived ?? "0"),
            onStage,
          });
        } else {
          sig = await solanaSwap({
            chain,
            userPubkey: wallet.solana!,
            dir,
            mode: "exactOut",
            tier: activeTier ?? undefined,
            pairId,
            amountOut: BigInt(q.amountOut),
            maxIn: BigInt(q.maxSold ?? "0"),
            onStage,
          });
        }
        setStatus({
          kind: "ok",
          msg: "Swap confirmed",
          txHash: sig,
          explorerUrl: explorerUrl(sig, chain),
        });
        swapFlow?.succeed(sig, explorerUrl(sig, chain));
        setInputVal(""); setOutputVal(""); setTiersData(null);
      } catch (e: unknown) {
        const { cancelled, message } = toTxStatus(e);
        setStatus({ kind: cancelled ? "cancelled" : "err", msg: message });
        swapFlow?.fail(cancelled ? "Cancelled in your wallet — nothing moved." : `${message} Nothing moved.`);
      }
      return;
    }

    // No wallet connected → nothing to sign with. The CTA is disabled in this
    // state, so this is only a defensive guard.
  }

  function onSwapClick() {
    if (!canSwap) return;
    setShowConfirm(true);
  }

  async function onConfirmSwap() {
    setShowConfirm(false);
    await executeSwap();
  }

  function onCancelSwap() {
    setShowConfirm(false);
  }

  // Swap button label. No wallet → "Connect wallet" (disabled); a real DEX signs
  // only with the user's wallet.
  const swapBtnLabel = !activeLane
    ? "Connect wallet"
    : status?.kind === "pending"
    ? "Swapping…"
    : isInsufficientBalance
    ? `Insufficient ${tokenIn.sym}`
    : !inputVal && !outputVal
    ? "Enter an amount"
    : !hasQuote
    ? "Fetching quote…"
    : `Swap ${tokenIn.sym} → ${tokenOut.sym}`;

  return (
    <div className="card" data-testid="swap-panel">
      {/* Hidden swap-mode indicator for tests */}
      <span data-testid="swap-mode" style={{ display: "none" }}>{mode}</span>

      {/* Market (pair) selector — the market you trade, kept distinct from the
          token chips on the pay / receive rows. The lane isn't shown here: like
          every other screen, the swap simply uses the connected wallet. */}
      <div className="rowhead" style={{ marginBottom: 8 }}>
        <span className="side">Market</span>
        <span className="side mono" style={{ color: "var(--fg3)" }}>live pool pricing</span>
      </div>
      <button
        type="button"
        data-testid="market-select"
        className="market-select"
        onClick={() => setShowPairModal(true)}
        title="Choose the market"
      >
        <PairGlyphs a={pair?.symbolA ?? "A"} b={pair?.symbolB ?? "B"} />
        <span className="market-name">{pair?.symbolA ?? "—"} / {pair?.symbolB ?? "—"}</span>
        <span className="market-right">
          {activeTier && <span className="badge tier">{activeTier}</span>}
          <span className="market-caret" aria-hidden>▾</span>
        </span>
      </button>

      {/* No-wallet prompt — a swap only ever signs with the user's wallet. */}
      {!activeLane && (
        <div data-testid="connect-prompt" className="connect-prompt" style={{ marginTop: 12 }}>
          Connect an EVM or Solana wallet to trade with your own funds.
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {/* Input leg — You pay */}
        <div className="rowhead">
          <span className="side" data-testid="input-label">
            {mode === "exactIn" ? "You pay" : "You pay (estimated)"}
          </span>
          {activeLane !== null && walletBalance !== null && (
            <div className="balance-row">
              <span data-testid="wallet-balance">
                {fmtRaw(walletBalance, decIn)} {tokenIn.sym}
              </span>
              <button
                data-testid="max-btn"
                onClick={() => {
                  setMode("exactIn");
                  setInputVal(fmtRaw(walletBalance, decIn));
                  setOutputVal("");
                  setStatus(null);
                }}
              >
                Max
              </button>
              <button
                data-testid="half-btn"
                onClick={() => {
                  setMode("exactIn");
                  setInputVal(fmtRaw(walletBalance / 2n, decIn));
                  setOutputVal("");
                  setStatus(null);
                }}
              >
                Half
              </button>
            </div>
          )}
        </div>
        <div className="amount-row">
          <input
            data-testid="swap-input"
            inputMode="decimal"
            placeholder="0.0"
            value={inputVal}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, "");
              setInputVal(v);
              setOutputVal("");
              setMode("exactIn");
              setStatus(null);
            }}
            style={{ flex: 1 }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span data-testid="token-in" className="token-pill token-static">
              <span className="token-glyph" style={{ background: tokenIn.color }}>{tokenIn.sym}</span>
              {tokenIn.label}
            </span>
          </div>
        </div>
        <div style={{ marginTop: 5, paddingLeft: 2, fontSize: 13.5, color: "var(--fg3)", fontFamily: "var(--font-mono)", display: "flex", justifyContent: "space-between" }}>
          <span>{tokenIn.sym}</span>
          <UsdValue symbol={tokenIn.sym} rawAmount={q?.amountIn} decimals={decIn} className="mono" />
        </div>

        {/* Flip button */}
        <div className="swap-flip">
          <button data-testid="flip-btn" className="enhanced" onClick={flip} title="Flip direction" aria-label="Flip direction">
            ⇅
          </button>
        </div>

        {/* Output leg — You receive */}
        <div className="rowhead">
          <span className="side" data-testid="output-label">
            {mode === "exactIn" ? "You receive" : "You receive (exact)"}
          </span>
          {quoting && <span className="side" style={{ color: "var(--rome-purple)" }}>quoting…</span>}
        </div>
        <div className="amount-row">
          <input
            data-testid="swap-output"
            inputMode="decimal"
            placeholder="0.0"
            value={outputVal}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, "");
              setOutputVal(v);
              setInputVal("");
              setMode("exactOut");
              setStatus(null);
            }}
            style={{ flex: 1 }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span data-testid="token-out" className="token-pill token-static">
              <span className="token-glyph" style={{ background: tokenOut.color }}>{tokenOut.sym}</span>
              {tokenOut.label}
            </span>
          </div>
        </div>
        <div style={{ marginTop: 5, paddingLeft: 2, fontSize: 13.5, color: "var(--fg3)", fontFamily: "var(--font-mono)", display: "flex", justifyContent: "flex-end" }}>
          <UsdValue symbol={tokenOut.sym} rawAmount={q?.amountOut} decimals={decOut} className="mono" />
        </div>
      </div>

      {/* Fee-tier selector — Auto follows the best-price tier; user can pin one. */}
      <div data-testid="tier-selector" style={{ marginTop: 16 }}>
        <div className="rowhead" style={{ marginBottom: 6 }}>
          <span className="side">Fee tier</span>
          <span className="side mono" data-testid="selected-tier" style={{ color: "var(--rome-purple)" }}>
            {tierChoice === "auto"
              ? `Auto${activeTier ? ` · ${activeTier}` : ""}`
              : tierChoice}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            data-testid="tier-auto"
            className={`tier-chip${tierChoice === "auto" ? " active" : ""}`}
            onClick={() => { setTierChoice("auto"); setStatus(null); }}
            aria-pressed={tierChoice === "auto"}
          >
            Auto
          </button>
          {(pair?.tiers ?? []).map((t) => {
            const row = tiersData?.tiers.find((r) => r.tier === t.tier);
            const isBest = Boolean(row?.isBest);
            const selected = tierChoice === t.tier;
            return (
              <button
                key={t.tier}
                data-testid={`tier-option-${t.tier}`}
                className={`tier-chip${selected ? " active" : ""}`}
                onClick={() => { setTierChoice(t.tier); setStatus(null); }}
                aria-pressed={selected}
                title={row ? `out ${fmtRaw(row.amountOut ?? "", decOut)} ${tokenOut.sym}` : t.tier}
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {t.tier}
                {isBest && (
                  <span data-testid={`best-badge-${t.tier}`} className="best-badge" style={{ marginLeft: 5, color: "var(--rome-purple)" }}>
                    ★
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Priority fee (EVM tip) — user controls the congestion tip. EVM lane only:
          the Solana lane prices priority differently, so we hide it there. */}
      {activeLane === "evm" && (
        <div data-testid="priority-fee" style={{ marginTop: 16 }}>
          <div className="rowhead" style={{ marginBottom: 6 }}>
            <button
              data-testid="priority-fee-toggle"
              className="lane-btn"
              onClick={() => setShowTipSettings((s) => !s)}
              style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", padding: 0 }}
              aria-expanded={showTipSettings}
            >
              <span className="side">⚙ Priority fee</span>
            </button>
            <span className="side mono" data-testid="priority-fee-value" style={{ color: "var(--rome-purple)" }}>
              {tipPreset === "custom"
                ? `${customTipGwei || "0"} gwei`
                : tipPreset === "fast"
                ? `Fast · ${((networkTipGwei ?? 0) + 1).toFixed(2)} gwei`
                : `Normal · ${(networkTipGwei ?? 0).toFixed(2)} gwei`}
            </span>
          </div>
          {showTipSettings && (
            <div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(["normal", "fast", "custom"] as TipPreset[]).map((p) => (
                  <button
                    key={p}
                    data-testid={`priority-${p}`}
                    className={`tier-chip${tipPreset === p ? " active" : ""}`}
                    onClick={() => { setTipPreset(p); setStatus(null); }}
                    aria-pressed={tipPreset === p}
                    style={{ textTransform: "capitalize" }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              {tipPreset === "custom" && (
                <div className="amount-row" style={{ marginTop: 8 }}>
                  <input
                    data-testid="priority-custom-input"
                    inputMode="decimal"
                    placeholder="Tip in gwei (e.g. 1.5)"
                    value={customTipGwei}
                    onChange={(e) => { setCustomTipGwei(e.target.value.replace(/[^0-9.]/g, "")); setStatus(null); }}
                    style={{ flex: 1 }}
                  />
                  <span className="side mono" style={{ flexShrink: 0 }}>gwei</span>
                </div>
              )}
              <div style={{ marginTop: 6, fontSize: 13.5, color: "var(--fg3)" }}>
                Network default (congestion-aware): {(networkTipGwei ?? 0).toFixed(2)} gwei · you set the tip.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Quote breakdown */}
      {hasQuote && q && (
        <div className="meta" data-testid="quote-breakdown" style={{ marginTop: 18 }}>
          {spotDisplay && (
            <div className="r">
              <span className="k">Spot rate</span>
              <span className="v mono" data-testid="spot-rate">{spotDisplay}</span>
            </div>
          )}
          <div className="r">
            <span className="k">Price impact</span>
            <span className={`v mono ${impactClass(q.priceImpactPct)}`} data-testid="price-impact">
              {q.priceImpactPct < 0.01 ? "<0.01" : q.priceImpactPct.toFixed(3)}%
            </span>
          </div>
          <div className="r">
            <span className="k">{feeLabel}</span>
            <span className="v mono" data-testid="fee-paid">
              {fmtRaw(q.feePaid, decIn)} {tokenIn.sym}
            </span>
          </div>
          {mode === "exactIn" && q.minReceived && (
            <div className="r">
              <span className="k">Min received (0.5% slip)</span>
              <span className="v mono" data-testid="min-received" style={{ color: "var(--rome-purple)" }}>
                {fmtRaw(q.minReceived, decOut)} {tokenOut.sym}
              </span>
            </div>
          )}
          {mode === "exactOut" && q.maxSold && (
            <div className="r">
              <span className="k">Max sold (0.5% slip)</span>
              <span className="v mono" data-testid="max-sold" style={{ color: "var(--rome-purple)" }}>
                {fmtRaw(q.maxSold, decIn)} {tokenIn.sym}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Swap CTA */}
      <button
        data-testid="swap-btn"
        className="btn block"
        onClick={onSwapClick}
        disabled={!canSwap || status?.kind === "pending"}
        style={{ marginTop: 20 }}
      >
        {swapBtnLabel}
      </button>

      {/* Status message */}
      {status && status.kind !== "pending" && (
        <div data-testid="swap-status" className={`note ${status.kind}`} style={{ marginTop: 14 }}>
          {status.kind === "ok" && status.txHash ? (
            <>
              {status.msg} ·{" "}
              <a
                data-testid="tx-link"
                href={status.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                view tx ↗
              </a>
            </>
          ) : (
            status.msg
          )}
        </div>
      )}

      {/* Pair selector modal — lists every pair that has a live pool. */}
      {showPairModal && (
        <div className="confirm-modal-overlay" onClick={() => setShowPairModal(false)}>
          <div className="confirm-modal" data-testid="pair-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Select a pair</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
              {pairs.map((pr) => {
                const gA = tokenMeta(pr.symbolA), gB = tokenMeta(pr.symbolB);
                const selected = pr.pairId === pairId;
                return (
                  <button
                    key={pr.pairId}
                    data-testid={`pair-option-${pr.pairId}`}
                    className={`tier-chip${selected ? " active" : ""}`}
                    aria-pressed={selected}
                    onClick={() => selectPair(pr.pairId)}
                    style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-start", padding: "10px 12px" }}
                  >
                    <span style={{ display: "inline-flex" }}>
                      <span className="token-glyph" style={{ background: gA.grad }}>{gA.glyph}</span>
                      <span className="token-glyph" style={{ background: gB.grad, marginLeft: -6 }}>{gB.glyph}</span>
                    </span>
                    <span style={{ fontWeight: 600 }}>{pr.pairName}</span>
                    <span className="side mono" style={{ marginLeft: "auto", color: "var(--fg3)" }}>
                      {pr.tiers.length} tier{pr.tiers.length === 1 ? "" : "s"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="modal-actions">
              <button data-testid="pair-modal-close" className="btn ghost" onClick={() => setShowPairModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal overlay */}
      {showConfirm && q && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal" data-testid="confirm-modal">
            <h3>Confirm Swap</h3>
            <div className="meta" style={{ marginTop: 0 }}>
              <div className="r">
                <span className="k">You pay</span>
                <span className="v mono">
                  {mode === "exactIn"
                    ? `${fmtRaw(q.amountIn, decIn)} ${tokenIn.sym}`
                    : `${inputVal || fmtRaw(q.amountIn, decIn)} ${tokenIn.sym} (est.)`}
                </span>
              </div>
              <div className="r">
                <span className="k">You receive</span>
                <span className="v mono">
                  {mode === "exactIn"
                    ? `${fmtRaw(q.amountOut, decOut)} ${tokenOut.sym} (est.)`
                    : `${outputVal || fmtRaw(q.amountOut, decOut)} ${tokenOut.sym}`}
                </span>
              </div>
              {spotDisplay && (
                <div className="r">
                  <span className="k">Rate</span>
                  <span className="v mono">{spotDisplay}</span>
                </div>
              )}
              <div className="r">
                <span className="k">Price impact</span>
                <span className={`v mono ${impactClass(q.priceImpactPct)}`}>
                  {q.priceImpactPct < 0.01 ? "<0.01" : q.priceImpactPct.toFixed(3)}%
                </span>
              </div>
              <div className="r">
                <span className="k">{feeLabel}</span>
                <span className="v mono">{fmtRaw(q.feePaid, decIn)} {tokenIn.sym}</span>
              </div>
              {mode === "exactIn" && q.minReceived && (
                <div className="r">
                  <span className="k">Min received</span>
                  <span className="v mono" style={{ color: "var(--rome-purple)" }}>
                    {fmtRaw(q.minReceived, decOut)} {tokenOut.sym}
                  </span>
                </div>
              )}
              {mode === "exactOut" && q.maxSold && (
                <div className="r">
                  <span className="k">Max sold</span>
                  <span className="v mono" style={{ color: "var(--rome-purple)" }}>
                    {fmtRaw(q.maxSold, decIn)} {tokenIn.sym}
                  </span>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button
                data-testid="cancel-swap-btn"
                className="btn ghost"
                onClick={onCancelSwap}
              >
                Cancel
              </button>
              <button
                data-testid="confirm-swap-btn"
                className="btn"
                onClick={onConfirmSwap}
              >
                Confirm Swap
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
