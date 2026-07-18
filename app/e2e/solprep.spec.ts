// Unit tests for lib/solPrep — the Solana-lane in-flow account-prep builders.
// Standing rule: creation is part of the flow, never a separate step, and a
// brand-new wallet (no ATAs, plain SOL only) must succeed. These builders
// prepend idempotent ATA creation + native-SOL wrap ixs to swap/deposit/
// withdraw txs, mirroring what the EVM lane's router does in-flow (#14).
// Pure logic, no browser / no RPC.

import { test, expect } from "@playwright/test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ensureAtaIxs, wrapSolIxs } from "../lib/solPrep";

const OWNER = new PublicKey("9wJGNGWdFaotGrqBEuAkujhnRi94vyadDS4vz8YeiAds");
const MINT_A = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

test.describe("ensureAtaIxs — idempotent ATA creation, payer = user", () => {
  test("one create-idempotent ix per mint, correct derivation + payer", () => {
    const ixs = ensureAtaIxs(OWNER, [MINT_A, NATIVE_MINT]);
    expect(ixs).toHaveLength(2);
    for (const [i, mint] of [MINT_A, NATIVE_MINT].entries()) {
      const ix = ixs[i];
      expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
      expect(ix.data[0]).toBe(1); // CreateIdempotent discriminator — no-op if it exists
      expect(ix.keys[0].pubkey.equals(OWNER)).toBe(true); // payer = user, signer
      expect(ix.keys[0].isSigner).toBe(true);
      expect(ix.keys[1].pubkey.equals(getAssociatedTokenAddressSync(mint, OWNER))).toBe(true);
    }
  });

  test("de-duplicates repeated mints (deposit A/B/LP where A == LP never double-creates)", () => {
    const ixs = ensureAtaIxs(OWNER, [MINT_A, MINT_A]);
    expect(ixs).toHaveLength(1);
  });
});

test.describe("wrapSolIxs — fund the wSOL ATA in-flow from plain SOL", () => {
  test("no-op when the existing wSOL balance covers the need", () => {
    expect(wrapSolIxs(OWNER, 1_000n, 5_000n)).toHaveLength(0);
  });

  test("shortfall → transfer(shortfall) + SyncNative on the wSOL ATA", () => {
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, OWNER);
    const ixs = wrapSolIxs(OWNER, 10_000n, 4_000n);
    expect(ixs).toHaveLength(2);
    // 1) System transfer of exactly the shortfall into the wSOL ATA
    expect(ixs[0].programId.equals(SystemProgram.programId)).toBe(true);
    expect(ixs[0].keys[0].pubkey.equals(OWNER)).toBe(true);
    expect(ixs[0].keys[1].pubkey.equals(wsolAta)).toBe(true);
    expect(ixs[0].data.readBigUInt64LE(4)).toBe(6_000n); // 10000 - 4000
    // 2) SyncNative so the token balance reflects the lamports
    expect(ixs[1].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[1].data[0]).toBe(17); // SyncNative discriminator
    expect(ixs[1].keys[0].pubkey.equals(wsolAta)).toBe(true);
  });
});
