// Pure SwapV2 CPI account-meta builders — extracted from walletActions.ts
// so the account lists are node-testable (same pattern as lib/chains/
// core.mjs). Keep this file, contracts/src/RomeDexRouter.sol, and
// sdk/rome-dex.ts in sync on any account-list change — all three encode
// the same on-chain ABI (program/src/instruction.rs).
//
// `pubkey` values are passed through untouched — this module doesn't know
// or care whether a caller uses a string, a web3.js PublicKey, or anything
// else with a stable identity; that keeps it usable from both TS callers
// (which pass real PublicKeys) and plain node --test fixtures (strings).

/// 13 metas, no fee slot — the v2 program has none. Meta 0 (pool state) is
/// WRITABLE (was RO in v1): Swap/SwapExactOut now write the
/// protocol_fees_a/b accrual counter on every trade.
export function buildSwapMetas(dir, authority, srcAta, dstAta, pool, tokenProgram) {
  const [srcVault, dstVault, srcMint, dstMint] =
    dir === "AtoB"
      ? [pool.vaultA, pool.vaultB, pool.mintA, pool.mintB]
      : [pool.vaultB, pool.vaultA, pool.mintB, pool.mintA];

  return [
    { pubkey: pool.swapState, isSigner: false, isWritable: true },
    { pubkey: pool.authority, isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: srcAta, isSigner: false, isWritable: true },
    { pubkey: srcVault, isSigner: false, isWritable: true },
    { pubkey: dstVault, isSigner: false, isWritable: true },
    { pubkey: dstAta, isSigner: false, isWritable: true },
    { pubkey: pool.poolMint, isSigner: false, isWritable: true },
    { pubkey: srcMint, isSigner: false, isWritable: false },
    { pubkey: dstMint, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];
}

/// 14 metas — UNCHANGED shape from v1 (tag 2 is untouched by SwapV2).
export function buildDepositMetas(authority, uA, uB, uLp, pool, tokenProgram) {
  return [
    { pubkey: pool.swapState, isSigner: false, isWritable: false },
    { pubkey: pool.authority, isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: uA, isSigner: false, isWritable: true },
    { pubkey: uB, isSigner: false, isWritable: true },
    { pubkey: pool.vaultA, isSigner: false, isWritable: true },
    { pubkey: pool.vaultB, isSigner: false, isWritable: true },
    { pubkey: pool.poolMint, isSigner: false, isWritable: true },
    { pubkey: uLp, isSigner: false, isWritable: true },
    { pubkey: pool.mintA, isSigner: false, isWritable: false },
    { pubkey: pool.mintB, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];
}

/// 14 metas — v1's fee-account slot (old index 9) is dropped; everything
/// after it shifts down one.
export function buildWithdrawMetas(authority, uLp, uA, uB, pool, tokenProgram) {
  return [
    { pubkey: pool.swapState, isSigner: false, isWritable: false },
    { pubkey: pool.authority, isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: pool.poolMint, isSigner: false, isWritable: true },
    { pubkey: uLp, isSigner: false, isWritable: true },
    { pubkey: pool.vaultA, isSigner: false, isWritable: true },
    { pubkey: pool.vaultB, isSigner: false, isWritable: true },
    { pubkey: uA, isSigner: false, isWritable: true },
    { pubkey: uB, isSigner: false, isWritable: true },
    { pubkey: pool.mintA, isSigner: false, isWritable: false },
    { pubkey: pool.mintB, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];
}
