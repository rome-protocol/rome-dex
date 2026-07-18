// findPool.ts — discover a pool NOT created on this device, by DERIVATION. This
// RPC throttles getProgramAccounts, so a global "list all pools" scan isn't
// possible — but CreatePool + CLMM pools are deterministic PDAs of (mint0, mint1,
// fee). So given two tokens + a fee tier + a type, derive the canonical pool
// address and check it exists on-chain (getAccountInfo — cheap, not a scan). If it
// does, return a registry entry you can add + trade. This finds ANY such pool,
// whoever created it. Classic keypair pools aren't derivable (random address) —
// but those already live in the static list / main swap card.

import { Connection, PublicKey } from "@solana/web3.js";
import { resolveCreatePool } from "./createPool";
import { poolPdaFor as clmmPoolPdaFor, orderMints as clmmOrderMints, vaultAtaFor as clmmVaultAtaFor } from "./clmm-create";
import { decodePool } from "./clmm-quote";
import type { MyPool } from "./myPools";
import type { ChainConfig } from "./chains/types";

export interface FindToken { mint: string; symbol: string; decimals: number; }
export type FindResult = { found: true; entry: MyPool } | { found: false };

/** Derive the canonical pool for (tokenA, tokenB, feeBps, type) on `chain` and
 *  check it exists on-chain. feeBps is the DEX bps (5/30/100); CLMM uses
 *  feePips = bps×100. Programs come from the active chain's dex/clmm config. */
export async function findPool(chain: ChainConfig, type: "simple" | "clmm", a: FindToken, b: FindToken, feeBps: number): Promise<FindResult> {
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const mintA = new PublicKey(a.mint), mintB = new PublicKey(b.mint);
  if (mintA.equals(mintB)) throw new Error("Pick two different tokens.");
  const tierLabel = feeBps === 5 ? "0.05%" : feeBps === 100 ? "1.00%" : "0.30%";

  if (type === "simple") {
    const dexProgram = new PublicKey(chain.dex.dexProgram);
    const r = resolveCreatePool(dexProgram, mintA, mintB, feeBps);
    const info = await conn.getAccountInfo(r.pool);
    if (!info || !info.owner.equals(dexProgram) || info.data.length < 300) return { found: false };
    // Canonical order matters for symbol/decimal labelling: resolveCreatePool does
    // NOT reorder (it seeds the PDA with the given order), so keep (a,b) as passed.
    return {
      found: true,
      entry: {
        kind: "simple", pool: r.pool.toBase58(), program: dexProgram.toBase58(),
        mintA: a.mint, mintB: b.mint, symbolA: a.symbol, symbolB: b.symbol,
        decimalsA: a.decimals, decimalsB: b.decimals,
        vaultA: r.vaultA.toBase58(), vaultB: r.vaultB.toBase58(),
        feeBps, tier: tierLabel, createdSig: "", createdAt: Date.now(),
      },
    };
  }

  // CLMM: canonical mint order (InitPool enforces mint0 < mint1), fee = pips.
  if (!chain.clmm) return { found: false }; // chain has no CLMM product
  const clmmProgram = new PublicKey(chain.clmm.program);
  const feePips = feeBps * 100;
  const { mint0, mint1, flipped } = clmmOrderMints(mintA, mintB);
  const [pool] = clmmPoolPdaFor(clmmProgram, mint0, mint1, feePips);
  const info = await conn.getAccountInfo(pool);
  if (!info || !info.owner.equals(clmmProgram) || !decodePool(info.data).isInitialized) return { found: false };
  const t0 = flipped ? b : a, t1 = flipped ? a : b;
  return {
    found: true,
    entry: {
      kind: "clmm", pool: pool.toBase58(), program: clmmProgram.toBase58(),
      mintA: mint0.toBase58(), mintB: mint1.toBase58(), symbolA: t0.symbol, symbolB: t1.symbol,
      decimalsA: t0.decimals, decimalsB: t1.decimals,
      vaultA: clmmVaultAtaFor(pool, mint0).toBase58(), vaultB: clmmVaultAtaFor(pool, mint1).toBase58(),
      feeBps, tier: tierLabel, createdSig: "", createdAt: Date.now(),
    },
  };
}
