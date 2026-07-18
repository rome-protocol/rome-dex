// Server-side live-chain read layer for rome-dex — reads real pool reserves, LP
// supply, and per-tier state for a GIVEN chain (resolved per-request from ?chain
// via lib/chains/server.mjs). Key-less: all writes (swap / add / remove) sign
// only with the user's connected wallet on the client. Tiers come from the active
// ChainConfig (chains.yaml → cfg.dex.tiers), no longer a static JSON import.
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";
import type { ChainConfig } from "./chains/types";

// A pool of one pair at one fee tier. Every entry carries its pair identity so
// the app is multi-pair — see each chain's dex.tiers in chains.yaml (assembled by
// harness/build-app-pools.mjs, pasted per chain).
export interface PoolInfo {
  program: string;
  swapState: string;
  authority: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  poolMint: string;
  feeAccount: string;
}
export interface TierPool extends PoolInfo {
  pairId: string;
  pairName: string;
  poolId: number;
  tier: string;
  bps: number;
  feeTradeNum: number;
  feeTradeDen: number;
  feeOwnerNum: number;
  feeOwnerDen: number;
  decimalsA: number;
  decimalsB: number;
  symbols?: { A?: string; B?: string };
  symbolA?: string;
  symbolB?: string;
}

const symOf = (t: TierPool) => ({
  A: t.symbols?.A ?? t.symbolA ?? "A",
  B: t.symbols?.B ?? t.symbolB ?? "B",
});

// Normalize a chain's raw dex.tiers into full TierPool entries: fill
// pairId/pairName/poolId/decimals when absent so the app tolerates both the
// multi-pair shape and a legacy single-pair one. (Was the module-level TIERS
// build; now per-chain.) The runtime entries carry every field (chains.yaml
// dex.tiers), so the cast is safe.
export function buildTiers(cfg: ChainConfig): TierPool[] {
  const raw = (cfg.dex.tiers ?? []) as unknown as TierPool[];
  return raw.map((t) => {
    const s = symOf(t);
    return {
      ...t,
      pairId: t.pairId ?? `${s.A}-${s.B}`,
      pairName: t.pairName ?? `${s.A} / ${s.B}`,
      poolId: t.poolId ?? t.bps,
      decimalsA: t.decimalsA ?? 6,
      decimalsB: t.decimalsB ?? 9,
    };
  });
}

export function defaultPairId(cfg: ChainConfig): string {
  return buildTiers(cfg)[0]?.pairId ?? "USDC-SOL";
}

// The default pool for a chain = its default pair's 0.30% tier (historical default).
function defaultPool(tiers: TierPool[]): TierPool {
  const pid = tiers[0]?.pairId ?? "USDC-SOL";
  return (
    tiers.find((t) => t.pairId === pid && t.tier === "0.30%") ??
    tiers.find((t) => t.pairId === pid) ??
    tiers[0]
  );
}

// Fees (BigInt) for a tier entry — the shape lib/quote.ts consumes.
export function tierFees(t: TierPool) {
  return {
    tradeNum: BigInt(t.feeTradeNum), tradeDen: BigInt(t.feeTradeDen),
    ownerNum: BigInt(t.feeOwnerNum), ownerDen: BigInt(t.feeOwnerDen),
  };
}

const PK = (s: string) => new PublicKey(s);

// Live state for one pool (defaults to the chain's default pool).
export async function poolState(cfg: ChainConfig, p?: TierPool) {
  const pool = p ?? defaultPool(buildTiers(cfg));
  const c = new Connection(cfg.solanaRpc, "confirmed");
  const s = symOf(pool);
  const [rA, rB, lp, fee] = await Promise.all([
    getAccount(c, PK(pool.vaultA)).then(a => a.amount).catch(() => 0n),
    getAccount(c, PK(pool.vaultB)).then(a => a.amount).catch(() => 0n),
    getMint(c, PK(pool.poolMint)).then(m => m.supply).catch(() => 0n),
    getAccount(c, PK(pool.feeAccount)).then(a => a.amount).catch(() => 0n),
  ]);
  return {
    pairId: pool.pairId, pairName: pool.pairName, poolId: pool.poolId,
    tier: pool.tier, bps: pool.bps,
    program: pool.program, swapState: pool.swapState,
    reserveA: rA.toString(), reserveB: rB.toString(), lpSupply: lp.toString(), feesAccrued: fee.toString(),
    decimalsA: pool.decimalsA, decimalsB: pool.decimalsB,
    symbolA: s.A, symbolB: s.B,
  };
}

// Live reserves of a pair's fee tiers (raw). Powers /api/tiers best-price
// selection. Defaults to the chain's default pair; pass a pairId to scope.
export async function tierStates(cfg: ChainConfig, pairId?: string) {
  const pid = pairId ?? defaultPairId(cfg);
  const tiers = buildTiers(cfg).filter((t) => t.pairId === pid);
  const c = new Connection(cfg.solanaRpc, "confirmed");
  return Promise.all(tiers.map(async (t) => {
    const [rA, rB] = await Promise.all([
      getAccount(c, PK(t.vaultA)).then(a => a.amount).catch(() => 0n),
      getAccount(c, PK(t.vaultB)).then(a => a.amount).catch(() => 0n),
    ]);
    return { tier: t.tier, bps: t.bps, swapState: t.swapState, reserveA: rA, reserveB: rB, fees: tierFees(t) };
  }));
}

// Decimals for a pair (chain's default pair if omitted) — /api/tiers metadata.
export function pairDecimals(cfg: ChainConfig, pairId?: string) {
  const pid = pairId ?? defaultPairId(cfg);
  const tiers = buildTiers(cfg);
  const t = tiers.find((x) => x.pairId === pid) ?? defaultPool(tiers);
  return { decimalsA: t.decimalsA, decimalsB: t.decimalsB, symbolA: symOf(t).A, symbolB: symOf(t).B };
}
