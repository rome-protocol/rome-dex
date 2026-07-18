"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@/components/WalletContext";
import { usePrice } from "@/components/UsdValue";
import { useActiveChain } from "@/lib/chains/store";
import { usePools, tvlUsd, type PoolRow } from "@/lib/usePools";
import { useAnalytics, indexedSinceLabel, type PoolIndex } from "@/lib/useAnalytics";
import { evmPdaFor, ataFor, poolForTier } from "@/lib/walletActions";
import { ataBalance } from "@/lib/balances";
import { fmtUsd, fmtRaw, fmtPct } from "@/lib/format";
import { PairGlyphs } from "@/components/PairGlyphs";
import OpenOrders from "@/components/OpenOrders";
import ClmmPositions from "@/components/ClmmPositions";

function usePriceMap(): Record<string, number | null> {
  const usdc = usePrice("USDC")?.price ?? null;
  const sol = usePrice("SOL")?.price ?? null;
  const eth = usePrice("ETH")?.price ?? null;
  return { USDC: usdc, SOL: sol, ETH: eth, WSOL: sol, WUSDC: usdc, WETH: eth };
}

interface Position {
  pool: PoolRow;
  lp: bigint;
  sharePct: number;
  valueUsd: number | null;
  feesEarnedUsd: number | null; // real: your share × cumulative indexed pool fees
  aprPct: number | null;
  laneLabel: string;
}

export default function PositionsScreen() {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const { pools } = usePools();
  const prices = usePriceMap();
  const { byPoolId, data: analytics } = useAnalytics();
  const [lpByPoolId, setLpByPoolId] = useState<Record<number, bigint>>({});
  const [loaded, setLoaded] = useState(false);

  const lane = wallet.evm ? "evm" : wallet.solana ? "solana" : "none";
  const laneLabel = lane === "evm" ? "◆ EVM" : lane === "solana" ? "◎ Solana" : "No wallet";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pools || !chain) return;
      let owner: PublicKey | null = null;
      if (lane === "evm" && wallet.evm) owner = evmPdaFor(wallet.evm, chain.romeEvmProgramId);
      else if (lane === "solana" && wallet.solana) { try { owner = new PublicKey(wallet.solana); } catch { owner = null; } }

      const out: Record<number, bigint> = {};
      if (owner) {
        await Promise.all(pools.map(async (p) => {
          const lpAta = await ataFor(owner!, poolForTier(chain, p.tier, p.pairId).poolMint);
          out[p.poolId] = await ataBalance(chain.solanaRpc, lpAta);
        }));
      }
      if (!cancelled) { setLpByPoolId(out); setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [pools, chain, lane, wallet.evm, wallet.solana]);

  const positions: Position[] = useMemo(() => {
    if (!pools) return [];
    return pools
      .map((pool) => {
        const lp = lpByPoolId[pool.poolId] ?? 0n;
        if (lp <= 0n) return null;
        const lpS = BigInt(pool.lpSupply);
        const share = lpS > 0n ? Number(lp) / Number(lpS) : 0; // 0..1
        const sharePct = share * 100;
        const tvl = tvlUsd(pool, prices);
        const valueUsd = tvl == null ? null : tvl * share;
        const a: PoolIndex | undefined = byPoolId[pool.poolId];
        // Real: your share of the pool's cumulative indexed LP fees (since indexed).
        const feesEarnedUsd = a ? a.feesUsdAll * share : null;
        return { pool, lp, sharePct, valueUsd, feesEarnedUsd, aprPct: a?.aprPct ?? null, laneLabel };
      })
      .filter((x): x is Position => x !== null);
  }, [pools, lpByPoolId, prices, byPoolId, laneLabel]);

  const totalValue = positions.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
  const totalFees = positions.reduce((s, p) => s + (p.feesEarnedUsd ?? 0), 0);
  const since = indexedSinceLabel(analytics?.indexedSinceBlockTime);
  const anyFees = positions.some((p) => p.feesEarnedUsd != null);

  return (
    <div className="wrap page">
      <div className="sc-head">
        <div>
          <div className="eyebrow">Portfolio</div>
          <h2>Your positions</h2>
        </div>
      </div>

      <div className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        <div className="stat card">
          <div className="k">Position value</div>
          <div className="v">{positions.length ? fmtUsd(totalValue) : "—"}</div>
          <div className="sub" style={{ color: "var(--muted)" }}>your share, valued live</div>
        </div>
        <div className="stat card">
          <div className="k">Fees earned</div>
          <div className="v">{positions.length && anyFees ? fmtUsd(totalFees) : "—"}</div>
          <div className="sub" style={{ color: "var(--muted)" }}>{since ?? "your share of the pool’s fees"}</div>
        </div>
        <div className="stat card">
          <div className="k">LP held in</div>
          <div className="v" style={{ fontSize: 20 }}>{laneLabel}</div>
          <div className="sub" style={{ color: "var(--muted)" }}>works from either wallet</div>
        </div>
      </div>

      {positions.length > 0 && (
        <div className="card" style={{ color: "var(--muted)", fontSize: 13.5, padding: "10px 14px" }}>
          Fees compound into the pool reserves — your LP token redeems for a growing share.
          There is no separate escrow to claim: <b style={{ color: "var(--text)" }}>claim = withdraw</b>.
          Removing liquidity realizes your earned fees.{" "}
          <Link href="/farms" style={{ color: "var(--bridge)" }}>Stake your LP to earn RDX →</Link>
        </div>
      )}

      {positions.map((pos) => (
        <PositionCard key={pos.pool.poolId} pos={pos} />
      ))}

      {loaded && positions.length === 0 && (
        <div className="card" style={{ color: "var(--muted)" }}>
          No LP positions for this wallet.{" "}
          <Link href="/pools" style={{ color: "var(--bridge)" }}>Add liquidity →</Link>
          {" · "}
          <Link href="/farms" style={{ color: "var(--bridge)" }}>Stake LP to earn RDX →</Link>
          {lane === "none" && <div style={{ marginTop: 6, fontSize: 13.5 }}>Connect an EVM or Solana wallet to see your own positions.</div>}
        </div>
      )}
      {!loaded && (lane === "none"
        ? <div className="card" style={{ color: "var(--muted)" }}>Connect an EVM or Solana wallet to see your positions.</div>
        : <div className="card" style={{ color: "var(--muted)" }}>Reading your positions…</div>)}

      <ClmmPositions />

      <OpenOrders />
    </div>
  );
}

function PositionCard({ pos }: { pos: Position }) {
  const { pool } = pos;
  return (
    <div className="poscard card">
      <div>
        <div className="pair">
          <PairGlyphs a={pool.symbolA} b={pool.symbolB} />
          <div>
            <b>{pool.symbolA} / {pool.symbolB}</b>
            <div style={{ fontSize: 13.5, color: "var(--faint)", marginTop: 2 }}>{pool.tier} · held in {pos.laneLabel}{pos.aprPct != null ? ` · APR ${fmtPct(pos.aprPct)}` : ""}</div>
          </div>
        </div>
      </div>
      <div><div className="k">Value</div><div className="v">{pos.valueUsd == null ? "—" : fmtUsd(pos.valueUsd)}</div></div>
      <div><div className="k">Pool share</div><div className="v">{pos.sharePct.toFixed(4)}%</div></div>
      <div>
        <div className="k">Fees earned</div>
        <div className="v">{fmtRaw(pos.lp, 6)} LP · <span className="up">{pos.feesEarnedUsd == null ? "—" : fmtUsd(pos.feesEarnedUsd)}</span></div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Link className="btn ghost" href={`/pools/${pool.poolId}`}>Manage</Link>
        <Link className="btn" href={`/pools/${pool.poolId}`}>Withdraw to claim</Link>
      </div>
    </div>
  );
}
