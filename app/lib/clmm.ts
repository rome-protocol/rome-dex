"use client";

// CLMM config + on-chain reads for the app. Pool accounts come from the active
// chain's clmm config (ALL pools — the /clmm picker selects one; pools[0] is
// the default) plus device-local created/found pools resolved on demand.
// Reads decode with the shared clmm-quote mirror.

import { Connection, PublicKey } from "@solana/web3.js";
import type { ChainConfig } from "./chains/types";
import type { MyPool } from "./myPools";
import { tickArrayPdaFor } from "./clmm-create";
import {
  decodePool, decodeTickArray, sqrtPriceToPrice, tickToPrice, tickArrayStartIndex,
  TICK_ARRAY_SIZE, type ClmmPool, type TickArrayView,
} from "./clmm-quote";

/** Flattened CLMM config for ONE pool (program/router + the pool's fields). */
export function clmmConfig(chain: ChainConfig) {
  if (!chain.clmm) return null;
  return {
    program: chain.clmm.program,
    router: chain.clmm.router,
    ...chain.clmm.pools[0],
  };
}

export type ClmmConfigFlat = NonNullable<ReturnType<typeof clmmConfig>>;

/** ALL of the chain's config pools, flattened (picker order = config order). */
export function clmmPools(chain: ChainConfig): ClmmConfigFlat[] {
  if (!chain.clmm) return [];
  const { program, router } = chain.clmm;
  return chain.clmm.pools.map((p) => ({ program, router, ...p }));
}

/** Resolve a device-local created/found CLMM pool (myPools entry) into the same
 *  flat config shape the panel uses: tick spacing + current tick come from the
 *  pool account, and the initialized tick arrays around the price are derived
 *  (deterministic PDAs + one getMultipleAccounts probe — never a program scan). */
export async function resolveDevicePool(chain: ChainConfig, entry: MyPool): Promise<ClmmConfigFlat> {
  if (entry.kind !== "clmm") throw new Error("not a clmm pool");
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const program = new PublicKey(entry.program);
  const poolPk = new PublicKey(entry.pool);
  const info = await conn.getAccountInfo(poolPk);
  if (!info) throw new Error("pool not found on-chain");
  const pool = decodePool(info.data);
  const span = TICK_ARRAY_SIZE * pool.tickSpacing;
  const center = Math.floor(pool.currentTick / span) * span;
  const starts = [center - 2 * span, center - span, center, center + span, center + 2 * span];
  const pdas = starts.map((s) => tickArrayPdaFor(program, poolPk, s)[0]);
  const infos = await conn.getMultipleAccountsInfo(pdas);
  const tickArrays: Record<string, string> = {};
  infos.forEach((ai, i) => { if (ai) tickArrays[String(starts[i])] = pdas[i].toBase58(); });
  return {
    program: entry.program,
    router: chain.clmm?.router ?? "",
    pool: entry.pool,
    mint0: entry.mintA, mint1: entry.mintB,
    vault0: entry.vaultA, vault1: entry.vaultB,
    feePips: entry.feeBps * 100,
    tickSpacing: pool.tickSpacing,
    symbol0: entry.symbolA, symbol1: entry.symbolB,
    decimals0: entry.decimalsA, decimals1: entry.decimalsB,
    tickArrays,
  };
}

export interface ClmmPoolState extends ClmmPool {
  /** Human price (token1 per token0), decimals-adjusted. */
  price: number;
}

/** Read + decode the live pool account. Throws if the pool isn't found. */
export async function fetchClmmPool(chain: ChainConfig, cfgIn?: ClmmConfigFlat): Promise<ClmmPoolState> {
  const cfg = cfgIn ?? clmmConfig(chain);
  if (!cfg) throw new Error("no clmm on this chain");
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const info = await conn.getAccountInfo(new PublicKey(cfg.pool));
  if (!info) throw new Error("CLMM pool not found");
  const pool = decodePool(info.data);
  return { ...pool, price: sqrtPriceToPrice(pool.sqrtPrice, cfg.decimals0, cfg.decimals1) };
}

/** Read the tick-array window (walk order) for a swap direction from live state. */
export async function fetchTickArrays(chain: ChainConfig, currentTick: number, zeroForOne: boolean, cfgIn?: ClmmConfigFlat): Promise<TickArrayView[]> {
  const cfg = cfgIn ?? clmmConfig(chain);
  if (!cfg) throw new Error("no clmm on this chain");
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const span = 88 * cfg.tickSpacing;
  const start = Math.floor(currentTick / span) * span;
  const seq = zeroForOne ? [start, start - span] : [start, start + span];
  const keys = seq.map((s) => cfg.tickArrays[String(s)]).filter(Boolean).map((k) => new PublicKey(k));
  const infos = await conn.getMultipleAccountsInfo(keys);
  return infos.filter(Boolean).map((info) => decodeTickArray(info!.data));
}

/** The pool's providable price window (from ITS tick arrays — each pool's
 *  arrays are seeded around its own price), for the read view. */
export function poolBandPrices(chain: ChainConfig, cfgIn?: ClmmConfigFlat): { lower: number; upper: number } {
  const cfg = cfgIn ?? clmmConfig(chain);
  if (!cfg) throw new Error("no clmm on this chain");
  const starts = Object.keys(cfg.tickArrays).map(Number);
  const span = 88 * cfg.tickSpacing;
  return {
    lower: tickToPrice(Math.min(...starts), cfg.decimals0, cfg.decimals1),
    upper: tickToPrice(Math.max(...starts) + span - cfg.tickSpacing, cfg.decimals0, cfg.decimals1),
  };
}
