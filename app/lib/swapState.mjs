// Pure decoder for on-chain rome-dex SwapV2 pool-state bytes
// (program/src/state.rs). Runtime-agnostic — no @solana/web3.js dependency —
// so it's usable from server routes (chain.ts) and node --test alike.
//
// Fail-closed: anything whose version byte isn't 2 is NOT decoded — the
// caller must treat it as pool-unavailable (return null), never silently
// fall back to a v1 layout. The v1 shape no longer exists in program code
// (unknown versions unpack to UninitializedAccount, state.rs:78-86); a byte
// mainnet can never contain must not be trusted here either.

export const SWAP_V2_VERSION = 2;
// Account-relative offsets (include the leading version byte) — pinned at
// program/src/state.rs:209,226,353-359 and mirrored in
// contracts/src/RomeDexRouter.sol (PROTOCOL_FEES_A_OFFSET/B_OFFSET).
export const PROTOCOL_FEES_A_OFFSET = 292;
export const PROTOCOL_FEES_B_OFFSET = 300;
const MIN_LEN = PROTOCOL_FEES_B_OFFSET + 8; // 308 = SwapVersion::LATEST_LEN

function readU64LE(bytes, offset) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
  return v;
}

/// Decode the two protocol-fee counters out of a raw SwapV2 account buffer.
/// Returns null (never throws) for anything that isn't a well-formed v2
/// account — too short, or a version byte other than 2 (includes the
/// retired v1 shape and an uninitialized/garbage account).
export function decodeSwapV2(bytes) {
  if (!bytes || bytes.length < MIN_LEN) return null;
  if (bytes[0] !== SWAP_V2_VERSION) return null;
  return {
    protocolFeesA: readU64LE(bytes, PROTOCOL_FEES_A_OFFSET),
    protocolFeesB: readU64LE(bytes, PROTOCOL_FEES_B_OFFSET),
  };
}

/// LP-owned reserve per side = vault balance - the accrued protocol-fee
/// counter, clamped to zero. Clamped (not checked/reverting, unlike the
/// router's zapIn) because app reads are non-atomic across accounts — the
/// vault and the swap-state account come from separate RPC reads, so a
/// swap landing between them can transiently skew the two numbers; clamp-
/// to-zero is the safe read-side behavior. Each side's subtraction is
/// independent — both arms of this are separately mutation-tested
/// (symmetric-guard: each side gets its own case).
export function lpOwnedReserves({ vaultA, vaultB, feesA, feesB }) {
  const a = BigInt(vaultA);
  const b = BigInt(vaultB);
  const fa = BigInt(feesA);
  const fb = BigInt(feesB);
  return {
    reserveA: a > fa ? a - fa : 0n,
    reserveB: b > fb ? b - fb : 0n,
  };
}

/// LP-owned reserves for one pool, decode-failure included — the single
/// helper both chain.ts (liveReserves) and myPools.ts (readMyPoolState)
/// route through, so the fail-closed direction can't be applied on one
/// call path and missed on the other. `decoded` is whatever
/// decodeSwapV2(...) returned (null when the state account read failed or
/// didn't decode). A null decode means "pool unavailable" and MUST return
/// the same zero shape a failed vault read already returns — never the raw
/// vault balance with fees=0, which would silently reintroduce the
/// counter-included mispricing this module exists to close (visible only
/// during a transient RPC failure of the state read while the vault reads
/// succeed).
export function reservesFromVaults({ vaultA, vaultB, decoded }) {
  if (!decoded) return { reserveA: 0n, reserveB: 0n, feesAccruedA: 0n, feesAccruedB: 0n };
  const { reserveA, reserveB } = lpOwnedReserves({
    vaultA, vaultB, feesA: decoded.protocolFeesA, feesB: decoded.protocolFeesB,
  });
  return { reserveA, reserveB, feesAccruedA: decoded.protocolFeesA, feesAccruedB: decoded.protocolFeesB };
}
