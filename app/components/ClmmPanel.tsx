"use client";

// ClmmPanel — provide + manage a concentrated position (Solana lane, ⑤b).
// Pick a PRICE band (never ticks — experience-not-engineering), enter an amount,
// and open a position that earns fees while the price trades in your band; then
// increase / collect / close it. The open flow uses the truthful tracker (#48).
// The EVM lane lands in ⑤c; an EVM-only wallet sees an honest note.

import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ataBalance } from "@/lib/balances";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { useActionFlow } from "./useActionFlow";
import FlowStrip, { type FlowCopy } from "./FlowStrip";
import type { FlowStep } from "@/lib/flowState";
import { clmmConfig, fetchClmmPool, type ClmmPoolState, type ClmmConfigFlat } from "@/lib/clmm";
import { trackedBands, saveBand, removeBand, type Band } from "@/lib/clmmPositions";
import {
  priceToTick, tickToPrice, getLiquidityForAmounts, getAmountsForLiquidity, type ClmmPosition,
} from "@/lib/clmm-quote";
import {
  openPosition, decreaseLiquidity, collectFees, closePosition,
  readPosition, tickArrayFor,
} from "@/lib/clmm-actions";
import {
  openPositionEvm, decreaseLiquidityEvm, collectFeesEvm, closePositionEvm, previewEvmOpen,
} from "@/lib/clmm-actions-evm";
import { evmPdaFor } from "@/lib/walletActions";
import { explorerUrl } from "@/lib/explorer";
import { toTxStatus } from "@/lib/txerror";

const toRaw = (human: string, dec: number): bigint => {
  const [w, f = ""] = human.split(".");
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f)) return 0n;
  return BigInt((w || "0") + (f + "0".repeat(dec)).slice(0, dec) || "0");
};
const fmtRaw = (raw: bigint, dec: number, places = 4): string => {
  const s = raw.toString().padStart(dec + 1, "0");
  const w = s.slice(0, -dec) || "0", f = s.slice(-dec).slice(0, places).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
};
const fmtPrice = (p: number): string => (!isFinite(p) || p <= 0 ? "—" : p < 1 ? p.toPrecision(4) : p.toFixed(4));

// Band index lives in lib/clmmPositions (owner+pool keyed, chain-verified,
// recorded pre-submit) — shared with the /positions page.

const PRESETS = [
  { label: "±2%", pct: 0.02 },
  { label: "±5%", pct: 0.05 },
  { label: "±10%", pct: 0.10 },
];

export default function ClmmPanel({ cfg: cfgProp }: { cfg?: ClmmConfigFlat } = {}) {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const flow = useActionFlow();
  const [pool, setPool] = useState<ClmmPoolState | null>(null);
  const [lowerPrice, setLowerPrice] = useState("");
  const [upperPrice, setUpperPrice] = useState("");
  const [amount0, setAmount0] = useState("");
  const [positions, setPositions] = useState<{ band: Band; state: ClmmPosition }[]>([]);
  const [manageMsg, setManageMsg] = useState<string | null>(null);
  // "Track a position" — the recovery path for a position this device doesn't
  // remember (opened elsewhere, or a landed tx whose confirmation was missed).
  const [trackOpen, setTrackOpen] = useState(false);
  const [trackLower, setTrackLower] = useState("");
  const [trackUpper, setTrackUpper] = useState("");
  const [trackStatus, setTrackStatus] = useState<string | null>(null);

  // CLMM config for the active chain (null when the chain has no clmm product).
  // Memoized so it keeps a STABLE identity across renders — clmmConfig() returns
  // a fresh object each call, and clmm feeds loadPool's deps; without this the
  // load effect re-fires every render → fetch/render loop (cf. #52).
  const clmm = useMemo(() => cfgProp ?? (chain ? clmmConfig(chain) : null), [cfgProp, chain]);
  const D0 = clmm?.decimals0 ?? 6, D1 = clmm?.decimals1 ?? 6;
  const S0 = clmm?.symbol0 ?? "", S1 = clmm?.symbol1 ?? "";
  const SP = clmm?.tickSpacing ?? 64;
  // The pool's initialized price window — derived from ITS tick arrays (each
  // pool's arrays are seeded around its own price; the old hardcoded ±5632
  // only ever fit the tick-0 proof pool). Bands must sit inside it.
  const starts = useMemo(() => Object.keys(clmm?.tickArrays ?? {}).map(Number), [clmm]);
  const WINDOW_LO = starts.length ? tickToPrice(Math.min(...starts), D0, D1) : 0;
  const WINDOW_HI = starts.length ? tickToPrice(Math.max(...starts) + 88 * SP - SP, D0, D1) : 0;

  // EVM lane takes priority when both are connected (matches the swap card).
  const activeLane: "evm" | "sol" | null = wallet.evm ? "evm" : wallet.solana ? "sol" : null;
  // The position OWNER: an EVM user's external_auth PDA, or the Solana pubkey.
  // Memoized on the string keys so `owner` keeps a STABLE identity across
  // renders (a fresh PublicKey each render caused a render loop — see #52).
  const owner = useMemo(
    () => (wallet.evm && chain ? evmPdaFor(wallet.evm, chain.romeEvmProgramId) : wallet.solana ? new PublicKey(wallet.solana) : null),
    [wallet.evm, wallet.solana, chain],
  );
  const ownerKey = owner?.toBase58() ?? null;

  const loadPool = useCallback(() => { if (chain && clmm) fetchClmmPool(chain, clmm).then(setPool).catch(() => {}); }, [chain, clmm]);
  useEffect(() => { loadPool(); const t = setInterval(loadPool, 15000); return () => clearInterval(t); }, [loadPool]);

  const loadPositions = useCallback(async () => {
    if (!ownerKey || !chain || !clmm) { setPositions([]); return; }
    const ownerPk = new PublicKey(ownerKey);
    const bands = trackedBands(ownerKey, clmm.pool);
    const out: { band: Band; state: ClmmPosition }[] = [];
    for (const band of bands) {
      const st = await readPosition(chain, ownerPk, band.lower, band.upper, clmm).catch(() => null);
      if (st && st.isInitialized) out.push({ band, state: st });
    }
    setPositions(out);
  }, [ownerKey, chain, clmm]);
  useEffect(() => { loadPositions(); }, [loadPositions]);

  // The wallet's balances of the pool's two tokens — opening a position MOVES
  // both, so the open button gates on them: a truthful "top up first" beats an
  // opaque on-chain Custom(1) revert. (On the EVM lane, SPL balances live in
  // the external_auth PDA's ATAs — `owner` already points there.)
  const [walletBal, setWalletBal] = useState<{ b0: bigint; b1: bigint } | null>(null);
  const loadBalances = useCallback(async () => {
    if (!ownerKey || !chain || !clmm) { setWalletBal(null); return; }
    const o = new PublicKey(ownerKey);
    const [b0, b1] = await Promise.all([
      ataBalance(chain.solanaRpc, getAssociatedTokenAddressSync(new PublicKey(clmm.mint0), o, true, TOKEN_PROGRAM_ID)),
      ataBalance(chain.solanaRpc, getAssociatedTokenAddressSync(new PublicKey(clmm.mint1), o, true, TOKEN_PROGRAM_ID)),
    ]);
    setWalletBal({ b0, b1 });
  }, [ownerKey, chain, clmm]);
  useEffect(() => { loadBalances(); }, [loadBalances]);

  // A preset centers the band on the current price.
  const applyPreset = (pct: number) => {
    if (!pool) return;
    setLowerPrice(fmtPrice(pool.price * (1 - pct)));
    setUpperPrice(fmtPrice(pool.price * (1 + pct)));
  };

  // Resolve the chosen band to spacing-aligned ticks + validate.
  const band = useMemo(() => {
    if (!chain || !clmm) return null;
    const lp = parseFloat(lowerPrice), up = parseFloat(upperPrice);
    if (!(lp > 0) || !(up > 0) || lp >= up) return null;
    const lower = priceToTick(lp, SP, D0, D1);
    const upper = priceToTick(up, SP, D0, D1);
    if (lower >= upper) return null;
    if (!tickArrayFor(chain, lower, clmm ?? undefined) || !tickArrayFor(chain, upper, clmm ?? undefined)) return null; // outside seeded window
    return { lower, upper };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowerPrice, upperPrice, chain, clmm]);

  // Deposit preview: token0 budget → L → both token amounts (pool-favor pay-in).
  const preview = useMemo(() => {
    if (!pool || !band) return null;
    const a0 = toRaw(amount0, D0);
    if (a0 <= 0n) return null;
    // Size L from the token0 budget; if the band is entirely below price
    // (token1-only) fall back to treating the input as token1.
    let liquidity = getLiquidityForAmounts(pool.sqrtPrice, pool.currentTick, band.lower, band.upper, a0, 1n << 62n);
    if (liquidity <= 0n) liquidity = getLiquidityForAmounts(pool.sqrtPrice, pool.currentTick, band.lower, band.upper, 1n << 62n, a0);
    if (liquidity <= 0n) return null;
    const [need0, need1] = getAmountsForLiquidity(pool.sqrtPrice, pool.currentTick, band.lower, band.upper, liquidity, true);
    // Max bounds with 1% headroom for pool-favor rounding.
    return { liquidity, need0, need1, max0: (need0 * 101n) / 100n, max1: (need1 * 101n) / 100n };
  }, [pool, band, amount0]);

  // Wallet can't cover what this open would move → gate with guidance instead
  // of letting the chain reject it.
  const short = !!(preview && walletBal && (walletBal.b0 < preview.need0 || walletBal.b1 < preview.need1));

  const flowCopy: FlowCopy = {
    eyebrow: "Opening your position · step by step",
    doneVerb: "position open",
    extraTag: "includes a one-time account setup",
    idleHint: "One quick signature in your wallet",
    successHint: "Your position is open — it earns fees while the price is in your band",
  };

  async function open() {
    if (!owner || !band || !preview || !activeLane || !chain || !clmm) return;
    // Index the band BEFORE submitting: if the tx lands but the UI errors
    // after, the position stays findable (display chain-verifies every band).
    saveBand(owner.toBase58(), clmm.pool, band);
    const liveStep: FlowStep = { id: "live", title: "Your position opens and starts earning", sub: `active while ${S1}/${S0} is in ${fmtPrice(tickToPrice(band.lower, D0, D1))}–${fmtPrice(tickToPrice(band.upper, D0, D1))}`, state: "todo" };
    try {
      let txHash: string;
      if (activeLane === "evm") {
        // EVM lane: a cold PDA needs a one-time setup (rent bootstrap + ATAs)
        // before the open — reflect that truthfully from a real chain read.
        const { needsSetup } = await previewEvmOpen(chain, wallet.evm!);
        const steps: FlowStep[] = needsSetup
          ? [{ id: "setup", title: "One-time account setup", sub: "a quick prep step, only the first time", state: "todo" }, { id: "confirm", title: "Confirm your position", state: "todo" }, liveStep]
          : [{ id: "confirm", title: "Confirm your position", state: "todo" }, liveStep];
        flow.plan("evm", steps, needsSetup);
        flow.start();
        const r = await openPositionEvm(chain, {
          eoa: wallet.evm!, tickLower: band.lower, tickUpper: band.upper,
          liquidity: preview.liquidity, amount0Max: preview.max0, amount1Max: preview.max1,
          onStage: (s) => flow.step(s === "setup" ? "setup" : "confirm", "active"),
        }, clmm);
        txHash = r.txHash;
      } else {
        const steps: FlowStep[] = [{ id: "confirm", title: "Confirm in your wallet", state: "todo" }, liveStep];
        flow.plan("sol", steps, false);
        flow.start();
        const r = await openPosition(chain, {
          owner, tickLower: band.lower, tickUpper: band.upper,
          liquidity: preview.liquidity, amount0Max: preview.max0, amount1Max: preview.max1,
          onSign: () => flow.step("confirm", "active"),
        }, clmm);
        txHash = r.signature;
      }
      flow.succeed(txHash, explorerUrl(txHash, chain));
      setAmount0("");
      loadPositions(); loadPool(); loadBalances();
    } catch (e) {
      const { cancelled, message } = toTxStatus(e);
      flow.fail(cancelled ? "Cancelled in your wallet — nothing moved." : `${message} Nothing moved.`);
    }
  }

  // Recover a position from its price band: snap prices to ticks exactly like
  // the open flow, then verify ON-CHAIN before indexing — never trust the input.
  async function trackPosition() {
    if (!owner || !chain || !clmm) return;
    const lp = parseFloat(trackLower), up = parseFloat(trackUpper);
    if (!(lp > 0) || !(up > 0) || lp >= up) { setTrackStatus("Enter the position's min and max price (min below max)."); return; }
    const lower = priceToTick(lp, SP, D0, D1);
    const upper = priceToTick(up, SP, D0, D1);
    if (lower >= upper) { setTrackStatus("Those prices round to the same band edge — check them."); return; }
    setTrackStatus("Checking on-chain…");
    const st = await readPosition(chain, owner, lower, upper, clmm).catch(() => null);
    if (st && st.isInitialized) {
      saveBand(owner.toBase58(), clmm.pool, { lower, upper });
      setTrackStatus("Found it — added to your positions.");
      setTrackLower(""); setTrackUpper(""); setTrackOpen(false);
      loadPositions();
    } else {
      setTrackStatus("No position of yours found for that band in this pool. Check the prices, the pool, and which wallet you used to open it.");
    }
  }

  async function manage(label: string, fn: () => Promise<string>) {
    setManageMsg(`Confirm ${label} in your wallet…`);
    try {
      const sig = await fn();
      setManageMsg(`${label} confirmed`);
      loadPositions(); loadPool(); loadBalances();
      return sig;
    } catch (e) {
      const { cancelled, message } = toTxStatus(e);
      setManageMsg(cancelled ? "Cancelled — nothing moved." : `${message} Nothing moved.`);
    }
  }

  // Chains without a CLMM product: hide the whole surface.
  if (chain && !clmm) {
    return (
      <div className="card" data-testid="clmm-panel" style={{ marginTop: 18, maxWidth: 560 }}>
        <p className="label"><span>Provide a range</span></p>
        <div className="note" style={{ marginTop: 10 }}>CLMM is not available on this chain.</div>
      </div>
    );
  }

  if (!activeLane) {
    return (
      <div className="card" data-testid="clmm-panel">
        <p className="label"><span>Provide a range</span></p>
        <div className="note" style={{ marginTop: 10 }}>Connect an EVM or Solana wallet to provide liquidity in a price band.</div>
      </div>
    );
  }

  const ownerPk = owner!; // guaranteed non-null past the guard above
  const chainForActions = chain!; // clmm surface only renders with a chain present
  // Manage actions dispatch to the active lane's executor.
  const cfgForActions = clmm!; // non-null past the config guard above
  const doCollect = (lo: number, up: number) =>
    activeLane === "evm" ? collectFeesEvm(chainForActions, wallet.evm!, lo, up, cfgForActions) : collectFees(chainForActions, ownerPk, lo, up, undefined, cfgForActions);
  const doDecrease = (lo: number, up: number, liq: bigint) =>
    activeLane === "evm"
      ? decreaseLiquidityEvm(chainForActions, wallet.evm!, lo, up, liq, 1n, 1n, cfgForActions)
      : decreaseLiquidity(chainForActions, { owner: ownerPk, tickLower: lo, tickUpper: up, liquidity: liq, amount0Bound: 1n, amount1Bound: 1n }, cfgForActions);
  const doClose = (lo: number, up: number) =>
    activeLane === "evm" ? closePositionEvm(chainForActions, wallet.evm!, lo, up, cfgForActions) : closePosition(chainForActions, ownerPk, lo, up, undefined, cfgForActions);

  return (
    <div className="card" data-testid="clmm-panel">
      <p className="label"><span>Provide a range</span><span className="mono" style={{ fontSize: 13.5, color: "var(--fg3)" }}>{S0} / {S1}</span></p>

      <div className="chips" style={{ margin: "8px 0 4px" }}>
        {PRESETS.map((p) => (
          <button key={p.label} className="chip" data-testid={`clmm-preset-${p.label}`} onClick={() => applyPreset(p.pct)}>{p.label}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <label style={{ flex: 1 }}>
          <div className="k" style={{ fontSize: 13.5, color: "var(--muted)" }}>Min price</div>
          <input className="in" data-testid="clmm-lower" value={lowerPrice} onChange={(e) => setLowerPrice(e.target.value)} placeholder="0.00" inputMode="decimal" />
        </label>
        <label style={{ flex: 1 }}>
          <div className="k" style={{ fontSize: 13.5, color: "var(--muted)" }}>Max price</div>
          <input className="in" data-testid="clmm-upper" value={upperPrice} onChange={(e) => setUpperPrice(e.target.value)} placeholder="0.00" inputMode="decimal" />
        </label>
      </div>
      <div className="sub" style={{ color: "var(--muted)", fontSize: 13.5, marginTop: 4 }}>
        {S1} per {S0} · pool trades near {pool ? fmtPrice(pool.price) : "…"} · providable range {fmtPrice(WINDOW_LO)}–{fmtPrice(WINDOW_HI)}
      </div>

      <label style={{ display: "block", marginTop: 12 }}>
        <div className="k" style={{ fontSize: 13.5, color: "var(--muted)" }}>Deposit {S0}</div>
        <input className="in" data-testid="clmm-amount" value={amount0} onChange={(e) => setAmount0(e.target.value)} placeholder="0.0" inputMode="decimal" />
      </label>

      {preview && (
        <div className="route" data-testid="clmm-preview" style={{ marginTop: 10 }}>
          <div className="r"><span>You provide</span><b>{fmtRaw(preview.need0, D0)} {S0} + {fmtRaw(preview.need1, D1)} {S1}</b></div>
          <div className="r"><span>Band</span><b>{band ? `${fmtPrice(tickToPrice(band.lower, D0, D1))} – ${fmtPrice(tickToPrice(band.upper, D0, D1))}` : "—"}</b></div>
        </div>
      )}
      {lowerPrice && upperPrice && !band && (
        <div className="note" style={{ marginTop: 8 }} data-testid="clmm-band-invalid">
          Choose a min below max, both inside the providable range.
        </div>
      )}
      {short && preview && walletBal && (
        <div className="note" style={{ marginTop: 8 }} data-testid="clmm-balance-note">
          Opening this position moves {fmtRaw(preview.need0, D0)} {S0} + {fmtRaw(preview.need1, D1)} {S1} from
          your wallet, but it holds {fmtRaw(walletBal.b0, D0)} {S0} and {fmtRaw(walletBal.b1, D1)} {S1}.
          Top up both tokens, then provide.
        </div>
      )}

      <FlowStrip flow={flow.flow} testid="clmmflow" copy={flowCopy} containerTestId="clmm-open-flow" />

      <button
        className="btn block"
        data-testid="clmm-open-btn"
        style={{ marginTop: 12 }}
        disabled={!band || !preview || short || flow.flow.phase === "running"}
        onClick={open}
      >
        {flow.flow.phase === "running" ? "Opening…" : !band ? "Set a price band" : !preview ? "Enter an amount" : short ? `Not enough ${S0} or ${S1} in your wallet` : "Open position"}
      </button>

      {/* Your positions */}
      <div style={{ marginTop: 22 }}>
        <p className="label">
          <span>Your positions</span>
          <button className="chip" data-testid="clmm-track-toggle" onClick={() => { setTrackOpen((v) => !v); setTrackStatus(null); }}>
            Track a position
          </button>
        </p>
        {trackOpen && (
          <div className="route" style={{ marginTop: 8 }} data-testid="clmm-track-form">
            <div className="sub" style={{ color: "var(--muted)", fontSize: 13.5 }}>
              Opened a position that isn&apos;t listed here (another browser, or a confirmation that got lost)?
              Enter its price band — it&apos;s verified against the chain before it&apos;s added.
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input className="in" data-testid="clmm-track-lower" placeholder="Min price" inputMode="decimal" value={trackLower} onChange={(e) => setTrackLower(e.target.value)} />
              <input className="in" data-testid="clmm-track-upper" placeholder="Max price" inputMode="decimal" value={trackUpper} onChange={(e) => setTrackUpper(e.target.value)} />
              <button className="chip" data-testid="clmm-track-btn" onClick={trackPosition}>Find it</button>
            </div>
            {trackStatus && <div className="sub" style={{ marginTop: 6, fontSize: 13.5 }} data-testid="clmm-track-status">{trackStatus}</div>}
          </div>
        )}
        {positions.length === 0 ? (
          <div className="note" style={{ marginTop: 8 }} data-testid="clmm-no-positions">No positions yet — provide a range above to open one.</div>
        ) : (
          positions.map(({ band: b, state }) => {
            const owed = state.tokensOwed0 > 0n || state.tokensOwed1 > 0n;
            return (
              <div key={`${b.lower}:${b.upper}`} className="route" data-testid={`clmm-pos-${b.lower}-${b.upper}`} style={{ marginTop: 8 }}>
                <div className="r"><span>Band</span><b>{fmtPrice(tickToPrice(b.lower, D0, D1))} – {fmtPrice(tickToPrice(b.upper, D0, D1))}</b></div>
                <div className="r"><span>Status</span><b>{pool && pool.currentTick >= b.lower && pool.currentTick < b.upper ? "In range · earning" : "Out of range"}</b></div>
                {owed && <div className="r"><span>Uncollected fees</span><b>{fmtRaw(state.tokensOwed0, D0)} {S0} + {fmtRaw(state.tokensOwed1, D1)} {S1}</b></div>}
                <div className="chips" style={{ marginTop: 8 }}>
                  <button className="chip" data-testid={`clmm-collect-${b.lower}-${b.upper}`} onClick={() => manage("collect", () => doCollect(b.lower, b.upper))}>Collect fees</button>
                  <button className="chip" data-testid={`clmm-close-${b.lower}-${b.upper}`} onClick={async () => {
                    // Withdraw all, then close the empty position.
                    if (state.liquidity > 0n) await manage("withdraw", () => doDecrease(b.lower, b.upper, state.liquidity));
                    await manage("collect", () => doCollect(b.lower, b.upper));
                    const sig = await manage("close", () => doClose(b.lower, b.upper));
                    if (sig && ownerKey && clmm) removeBand(ownerKey, clmm.pool, b);
                  }}>Withdraw &amp; close</button>
                </div>
              </div>
            );
          })
        )}
        {manageMsg && <div className="note" style={{ marginTop: 8 }} data-testid="clmm-manage-msg">{manageMsg}</div>}
      </div>
    </div>
  );
}
