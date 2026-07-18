// solPrep.ts — Solana-lane in-flow account preparation.
// Standing rule: creation is part of the flow, never a separate step; a
// brand-new wallet (no ATAs, plain SOL only) must succeed. The EVM lane's
// router creates missing ATAs in-flow (#14); these builders do the same for
// the Solana lane by prepending ixs to the swap/deposit/withdraw tx that
// the Solana wallet signs. All idempotent — safe when accounts already exist.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/**
 * Idempotent ATA creation for each (deduped) mint, payer = the user.
 * CreateIdempotent no-ops on-chain when the ATA already exists, so these
 * always ride along at ~0 marginal cost for returning users.
 */
export function ensureAtaIxs(owner: PublicKey, mints: PublicKey[]): TransactionInstruction[] {
  const seen = new Set<string>();
  const ixs: TransactionInstruction[] = [];
  for (const mint of mints) {
    if (seen.has(mint.toBase58())) continue;
    seen.add(mint.toBase58());
    const ata = getAssociatedTokenAddressSync(mint, owner);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint));
  }
  return ixs;
}

/**
 * Fund the user's wSOL ATA from plain SOL when the pool side is native SOL:
 * transfer exactly the shortfall + SyncNative. Empty when the existing wSOL
 * balance already covers `needed`. The wSOL ATA itself must be ensured first
 * (ensureAtaIxs with NATIVE_MINT).
 */
export function wrapSolIxs(owner: PublicKey, needed: bigint, currentWsol: bigint): TransactionInstruction[] {
  if (currentWsol >= needed) return [];
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  return [
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: needed - currentWsol }),
    createSyncNativeInstruction(wsolAta),
  ];
}

/** Is this mint native SOL (wSOL)? */
export function isNativeMint(mint: PublicKey): boolean {
  return mint.equals(NATIVE_MINT);
}
