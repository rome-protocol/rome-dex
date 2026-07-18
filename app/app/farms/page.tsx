"use client";

// Farms — liquidity mining. Stake a rome-dex LP mint, earn RDX over time,
// claim, unstake. Dual-lane and wallet-only:
//   • EVM lane → CPI 0xFF..08, Rome auto-signs the external_auth PDA.
//   • Solana lane → native tx, the Solana wallet signs, app submits to SOL_RPC.
// No backend/demo signer — every action signs with the connected wallet.
// Layout: a list of farms (scales to many). Each farm is one card that shows
// ALL of its stats — total staked, emission, APR, your stake, pending — and
// carries its own stake / unstake / claim controls. Stats live in the farm they
// describe, not in a separate box wall stacked on top of the actions.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@/components/WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { PairGlyphs } from "@/components/PairGlyphs";
import { fmtRaw, fmtPct } from "@/lib/format";
import { toTxStatus } from "@/lib/txerror";
import { explorerUrl } from "@/lib/explorer";
import {
  readFarm, readUserStake, farmStats, pendingReward,
  stakeLP, unstakeLP, claimRewards, stakeableLp, authorityFor,
  farmPool, rewardDecimalsOf, LP_DECIMALS, REWARD_SYMBOL,
  type FarmState, type UserStakeState, type Lane,
} from "@/lib/farm";

type ActiveLane = Lane;
type Status = { kind: "ok" | "err" | "pending" | "cancelled"; msg: string; txHash?: string } | null;
type Stats = { emissionPerDay: bigint; totalStaked: bigint; aprPct: number | null };


function parseHuman(s: string, dec: number): bigint | null {
  if (!s || s === ".") return null;
  try {
    const [whole, frac = ""] = s.split(".");
    return BigInt(whole || "0") * 10n ** BigInt(dec) + BigInt(frac.slice(0, dec).padEnd(dec, "0") || "0");
  } catch {
    return null;
  }
}

export default function FarmsScreen() {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  // Farm-config-derived display metadata for the active chain (falls back while
  // the chain is loading or has no farm).
  const hasFarm = Boolean(chain?.dex.farm);
  const fp = chain && hasFarm ? farmPool(chain) : undefined;
  const SYM_A = fp?.symbolA ?? "USDC";
  const SYM_B = fp?.symbolB ?? "SOL";
  const TIER = fp?.tier ?? "0.30%";
  const REWARD_DECIMALS = chain && hasFarm ? rewardDecimalsOf(chain) : 9;
  const activeLane: ActiveLane | null = wallet.evm ? "evm" : wallet.solana ? "solana" : null;
  const address = activeLane === "evm" ? wallet.evm : activeLane === "solana" ? wallet.solana : null;
  const noWallet = !activeLane;

  const [farm, setFarm] = useState<FarmState | null>(null);
  const [stake, setStake] = useState<UserStakeState | null>(null);
  const [lpBal, setLpBal] = useState<bigint>(0n);
  const [nowTs, setNowTs] = useState<bigint>(BigInt(Math.floor(Date.now() / 1000)));

  const [stakeAmt, setStakeAmt] = useState("");
  const [unstakeAmt, setUnstakeAmt] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const busy = status?.kind === "pending";

  // Live farm state (accumulator, total staked, emission).
  const loadFarm = useCallback(async () => {
    if (!chain || !hasFarm) { setFarm(null); return; }
    setFarm(await readFarm(chain));
  }, [chain, hasFarm]);

  // Per-wallet state: staked position + stakeable LP balance.
  const loadUser = useCallback(async () => {
    if (!chain || !hasFarm || !activeLane || !address) {
      setStake(null);
      setLpBal(0n);
      return;
    }
    let authority: PublicKey | null = null;
    try { authority = authorityFor(chain, activeLane, address); } catch { authority = null; }
    if (!authority) return;
    const [u, bal] = await Promise.all([readUserStake(chain, authority), stakeableLp(chain, activeLane, address)]);
    setStake(u);
    setLpBal(bal);
  }, [chain, hasFarm, activeLane, address]);

  useEffect(() => { loadFarm(); }, [loadFarm]);
  useEffect(() => { loadUser(); }, [loadUser]);

  // Re-read farm state periodically; tick a local clock every second so pending
  // rewards visibly accrue between reads.
  useEffect(() => {
    const poll = setInterval(loadFarm, 15_000);
    const tick = setInterval(() => setNowTs(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [loadFarm]);

  const stats = useMemo<Stats | null>(() => (farm ? farmStats(farm, REWARD_DECIMALS) : null), [farm, REWARD_DECIMALS]);
  const staked = stake?.amount ?? 0n;
  const pending = useMemo(
    () => (farm && stake ? pendingReward(farm, stake, nowTs) : 0n),
    [farm, stake, nowTs],
  );

  const onSetup = (msg: string) => setStatus({ kind: "pending", msg });

  const refresh = useCallback(async () => { await Promise.all([loadFarm(), loadUser()]); }, [loadFarm, loadUser]);

  async function doStake() {
    const amount = parseHuman(stakeAmt, LP_DECIMALS);
    if (!chain || !activeLane || !address || !amount || amount <= 0n) return;
    try {
      setStatus({ kind: "pending", msg: "Staking LP…" });
      const tx = await stakeLP({ chain, lane: activeLane, address, amount, onSetup });
      setStatus({ kind: "ok", msg: `Staked ${fmtRaw(amount, LP_DECIMALS)} LP`, txHash: tx });
      setStakeAmt("");
      await refresh();
    } catch (e: unknown) {
      const { cancelled, message } = toTxStatus(e);
      setStatus({ kind: cancelled ? "cancelled" : "err", msg: message });
    }
  }

  async function doUnstake() {
    const amount = parseHuman(unstakeAmt, LP_DECIMALS);
    if (!chain || !activeLane || !address || !amount || amount <= 0n) return;
    try {
      setStatus({ kind: "pending", msg: "Unstaking LP…" });
      const tx = await unstakeLP({ chain, lane: activeLane, address, amount });
      setStatus({ kind: "ok", msg: `Unstaked ${fmtRaw(amount, LP_DECIMALS)} LP`, txHash: tx });
      setUnstakeAmt("");
      await refresh();
    } catch (e: unknown) {
      const { cancelled, message } = toTxStatus(e);
      setStatus({ kind: cancelled ? "cancelled" : "err", msg: message });
    }
  }

  async function doClaim() {
    if (!chain || !activeLane || !address) return;
    try {
      setStatus({ kind: "pending", msg: `Claiming ${REWARD_SYMBOL}…` });
      const tx = await claimRewards({ chain, lane: activeLane, address, onSetup });
      setStatus({ kind: "ok", msg: `Claimed ${REWARD_SYMBOL} rewards`, txHash: tx });
      await refresh();
    } catch (e: unknown) {
      const { cancelled, message } = toTxStatus(e);
      setStatus({ kind: cancelled ? "cancelled" : "err", msg: message });
    }
  }

  // Summary across all farms (one today, but the line + list scale to many).
  const summary = stats
    ? `1 farm · ${fmtRaw(stats.totalStaked, LP_DECIMALS)} LP staked · ${fmtRaw(stats.emissionPerDay, REWARD_DECIMALS)} ${REWARD_SYMBOL}/day emitted`
    : "Loading farms…";

  return (
    <div className="wrap page">
      <div className="sc-head">
        <div>
          <div className="eyebrow">Liquidity mining</div>
          <h2>Farms</h2>
          <div className="sc-sub">{summary}</div>
        </div>
        <Link className="btn ghost" href="/pools/30">+ Get LP to stake</Link>
      </div>

      <div className="farm-list">
        <FarmCard
          stats={stats}
          symA={SYM_A}
          symB={SYM_B}
          tier={TIER}
          rewardDecimals={REWARD_DECIMALS}
          staked={staked}
          pending={pending}
          lpBal={lpBal}
          noWallet={noWallet}
          busy={busy}
          stakeAmt={stakeAmt}
          setStakeAmt={(v) => { setStakeAmt(v); setStatus(null); }}
          unstakeAmt={unstakeAmt}
          setUnstakeAmt={(v) => { setUnstakeAmt(v); setStatus(null); }}
          onStake={doStake}
          onUnstake={doUnstake}
          onClaim={doClaim}
          setMaxStake={() => setStakeAmt(fmtRaw(lpBal, LP_DECIMALS, 6))}
          setMaxUnstake={() => setUnstakeAmt(fmtRaw(staked, LP_DECIMALS, 6))}
        />
      </div>

      {status && status.kind !== "pending" && (
        <div className={`note ${status.kind}`} data-testid="farm-status" style={{ marginTop: 16, maxWidth: 760 }}>
          {status.kind === "ok" && status.txHash ? (
            <>
              {status.msg} ·{" "}
              <a data-testid="farm-tx-link" href={chain ? explorerUrl(status.txHash, chain) : "#"} target="_blank" rel="noopener noreferrer">view tx ↗</a>
            </>
          ) : (
            status.msg
          )}
        </div>
      )}

      <div className="provenance" style={{ marginTop: 18 }}>
        <b>How it works.</b> Stake your <span className="live">{SYM_A} / {SYM_B} {TIER}</span> LP token to earn{" "}
        {REWARD_SYMBOL} emitted every second, split across all stakers in proportion to stake. Rewards accrue live;
        claim mints {REWARD_SYMBOL} to your wallet. Unstake returns your LP any time. The same farm serves both
        wallets — an EVM position and a Solana position earn from one shared pool.
      </div>
    </div>
  );
}

interface CardProps {
  stats: Stats | null;
  symA: string;
  symB: string;
  tier: string;
  rewardDecimals: number;
  staked: bigint;
  pending: bigint;
  lpBal: bigint;
  noWallet: boolean;
  busy: boolean;
  stakeAmt: string;
  setStakeAmt: (v: string) => void;
  unstakeAmt: string;
  setUnstakeAmt: (v: string) => void;
  onStake: () => void;
  onUnstake: () => void;
  onClaim: () => void;
  setMaxStake: () => void;
  setMaxUnstake: () => void;
}

function FarmCard(p: CardProps) {
  const { symA: SYM_A, symB: SYM_B, tier: TIER, rewardDecimals: REWARD_DECIMALS } = p;
  const hasStake = p.staked > 0n;
  const canClaim = !p.noWallet && !p.busy && p.pending > 0n;
  // Stake gates on the wallet's REAL LP balance — staking what you don't hold
  // used to reach the chain and die with a raw account error (live report).
  const stakeRaw = parseHuman(p.stakeAmt, LP_DECIMALS) ?? 0n;
  const noLp = !p.noWallet && p.lpBal === 0n;
  const overBal = !p.noWallet && stakeRaw > p.lpBal;
  return (
    <div className="card farm-row" data-testid="farm-card">
      {/* Identity + headline APR */}
      <div className="farm-row-head">
        <div className="pair">
          <PairGlyphs a={SYM_A} b={SYM_B} />
          <div>
            <b style={{ fontSize: 16 }}>{SYM_A} / {SYM_B}</b>
            <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 3 }}>
              <span className="badge tier">{TIER}</span> LP · earns <span className="up">{REWARD_SYMBOL}</span>
            </div>
          </div>
        </div>
        <div className="farm-apr">
          <div className="k">Reward APR</div>
          <div className="v up">{p.stats?.aprPct != null ? fmtPct(p.stats.aprPct) : "—"}</div>
        </div>
      </div>

      {/* The farm's stats — kept, not cut. */}
      <div className="farm-metrics">
        <div><span className="k">Total staked</span><span className="v">{p.stats ? `${fmtRaw(p.stats.totalStaked, LP_DECIMALS)} LP` : "—"}</span></div>
        <div><span className="k">Emission</span><span className="v">{p.stats ? `${fmtRaw(p.stats.emissionPerDay, REWARD_DECIMALS)} ${REWARD_SYMBOL}/day` : "—"}</span></div>
        <div><span className="k">Your staked</span><span className="v" data-testid="farm-staked">{fmtRaw(p.staked, LP_DECIMALS)} LP</span></div>
        <div><span className="k">Pending</span><span className="v up" data-testid="farm-pending">{fmtRaw(p.pending, REWARD_DECIMALS)} {REWARD_SYMBOL}</span></div>
      </div>

      {/* Stake + unstake side by side; both used, both visible. */}
      <div className="farm-actions" data-testid="farm-position">
        <div className="farm-action">
          <div className="rowhead">
            <span className="side">Stake LP</span>
            <span>
              {!p.noWallet && <span className="bal" data-testid="farm-lp-available" style={{ marginRight: 8 }}>avail {fmtRaw(p.lpBal, LP_DECIMALS)} LP</span>}
              <button className="chip" data-testid="farm-stake-max" onClick={p.setMaxStake} disabled={p.noWallet}>max</button>
            </span>
          </div>
          <div className="tokenrow">
            <div className="mid">
              <input className="amt" data-testid="farm-stake-input" inputMode="decimal" placeholder="0.0" value={p.stakeAmt} onChange={(e) => p.setStakeAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="tselect"><span className="tglyph" style={{ background: "linear-gradient(135deg,#6E5A78,#A692AE)" }}>LP</span>LP</span>
            </div>
          </div>
          {noLp && (
            <div className="note" data-testid="farm-lp-note" style={{ marginTop: 10 }}>
              This wallet doesn&apos;t hold {SYM_A}/{SYM_B} {TIER} LP yet — <Link href="/pools/30" style={{ color: "var(--bridge)" }}>add liquidity</Link> first, then stake it here.
            </div>
          )}
          <button className="btn block" data-testid="farm-stake-btn" style={{ marginTop: 12 }} onClick={p.onStake} disabled={p.noWallet || p.busy || !p.stakeAmt || noLp || overBal}>
            {p.noWallet ? "Connect wallet" : p.busy ? "Working…" : noLp ? "No LP to stake" : overBal ? `Not enough LP (you hold ${fmtRaw(p.lpBal, LP_DECIMALS)})` : "Stake"}
          </button>
        </div>

        <div className="farm-action">
          <div className="rowhead">
            <span className="side">Unstake LP</span>
            <button className="chip" data-testid="farm-unstake-max" onClick={p.setMaxUnstake} disabled={p.noWallet || !hasStake}>max</button>
          </div>
          <div className="tokenrow">
            <div className="mid">
              <input className="amt" data-testid="farm-unstake-input" inputMode="decimal" placeholder="0.0" value={p.unstakeAmt} onChange={(e) => p.setUnstakeAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="tselect"><span className="tglyph" style={{ background: "linear-gradient(135deg,#6E5A78,#A692AE)" }}>LP</span>LP</span>
            </div>
          </div>
          <button className="btn block ghost" data-testid="farm-unstake-btn" style={{ marginTop: 12 }} onClick={p.onUnstake} disabled={p.noWallet || p.busy || !hasStake || !p.unstakeAmt}>
            {p.noWallet ? "Connect wallet" : p.busy ? "Working…" : "Unstake"}
          </button>
        </div>
      </div>

      <button className="btn block" data-testid="farm-claim-btn" style={{ marginTop: 16 }} onClick={p.onClaim} disabled={!canClaim}>
        {p.noWallet ? "Connect wallet" : p.busy ? "Working…" : p.pending > 0n ? `Claim ${fmtRaw(p.pending, REWARD_DECIMALS)} ${REWARD_SYMBOL}` : `Claim ${REWARD_SYMBOL}`}
      </button>
    </div>
  );
}
