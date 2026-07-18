// myPools.ts — a client-side registry of pools YOU created, so they appear on
// /pools with live state immediately after creation. This RPC throttles
// getProgramAccounts (see lib/orders.ts), so a global on-chain scan of "all pools"
// isn't possible; discovering pools created by OTHERS needs an indexer. But a pool
// you just made is a deterministic PDA whose address + vaults you already have at
// creation time — so we record it locally and read its live reserves on demand.
//
// Pure storage helpers (add/list/remove) are unit-tested; the live-state reader
// hits the chain client-side (reserves via getAccount, same as chain.ts poolState).

import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export interface MyPool {
  kind: "simple" | "clmm";
  pool: string; // pool PDA — the unique key
  program: string;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
  decimalsA: number;
  decimalsB: number;
  vaultA: string;
  vaultB: string;
  feeBps: number; // fee tier in bps (part of the pool seed; enables re-derivation)
  tier: string; // display label, e.g. "0.30%"
  createdSig: string;
  createdAt: number; // ms epoch
}

const KEY = "rome-dex:my-pools";
/** Event fired after any registry change so open views (MyPoolsSection) re-read. */
export const MY_POOLS_CHANGED = "rome-dex:my-pools-changed";
function announce() {
  try { if (typeof window !== "undefined") window.dispatchEvent(new Event(MY_POOLS_CHANGED)); } catch { /* SSR */ }
}

/** Read the registry (safe on SSR / bad JSON → []). */
export function listMyPools(store: Pick<Storage, "getItem"> | null = safeLocalStorage()): MyPool[] {
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as MyPool[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Add a pool (dedup by `pool` address; newest first). Returns the new list. */
export function addMyPool(entry: MyPool, store: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage()): MyPool[] {
  const current = listMyPools(store);
  const deduped = current.filter((p) => p.pool !== entry.pool);
  const next = [entry, ...deduped];
  store?.setItem(KEY, JSON.stringify(next));
  announce();
  return next;
}

/** Remove a pool by address. Returns the new list. */
export function removeMyPool(pool: string, store: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage()): MyPool[] {
  const next = listMyPools(store).filter((p) => p.pool !== pool);
  store?.setItem(KEY, JSON.stringify(next));
  announce();
  return next;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export interface MyPoolState {
  reserveA: bigint;
  reserveB: bigint;
}

/** Read a created pool's live reserves client-side (vaults are the addresses we
 *  stored at creation). Returns 0/0 if a vault read fails. */
export async function readMyPoolState(entry: MyPool, solanaRpc: string): Promise<MyPoolState> {
  const conn = new Connection(solanaRpc, "confirmed");
  const one = async (v: string) => {
    try {
      return (await getAccount(conn, new PublicKey(v), "confirmed", TOKEN_PROGRAM_ID)).amount;
    } catch {
      return 0n;
    }
  };
  const [reserveA, reserveB] = await Promise.all([one(entry.vaultA), one(entry.vaultB)]);
  return { reserveA, reserveB };
}
