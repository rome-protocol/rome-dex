import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeSwapV2,
  lpOwnedReserves,
  reservesFromVaults,
  PROTOCOL_FEES_A_OFFSET,
  PROTOCOL_FEES_B_OFFSET,
} from "./swapState.mjs";

// Cross-language byte pin: the Rust layout test's own pinned constants
// (program/src/state.rs:303-304,330-331 — TEST_PROTOCOL_FEES_A = 111_222,
// TEST_PROTOCOL_FEES_B = 333_444) at the SAME account-relative offsets the
// Rust `swap_v2_offsets_pinned` test asserts (292/300). Every non-fee byte
// is filled with a distinct sentinel (0xAB), not zero — an off-by-one or
// wrong-width read picks up sentinel bytes and produces a wildly
// wrong number instead of coincidentally matching.
const LATEST_LEN = 308; // SwapVersion::LATEST_LEN
function fixture(version = 2) {
  const buf = new Uint8Array(LATEST_LEN).fill(0xab);
  buf[0] = version;
  const feesA = 111_222n;
  const feesB = 333_444n;
  writeU64LE(buf, PROTOCOL_FEES_A_OFFSET, feesA);
  writeU64LE(buf, PROTOCOL_FEES_B_OFFSET, feesB);
  return buf;
}
function writeU64LE(buf, offset, v) {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

test("decodeSwapV2 reads protocol_fees_a/b at the pinned offsets", () => {
  const decoded = decodeSwapV2(fixture());
  assert.equal(decoded.protocolFeesA, 111_222n);
  assert.equal(decoded.protocolFeesB, 333_444n);
});

// Decoder accepting version != 2 must be caught — return null for anything else,
// including the retired v1 byte and a garbage/uninitialized account.
test("decodeSwapV2 fails closed on a non-v2 version byte", () => {
  assert.equal(decodeSwapV2(fixture(1)), null); // retired v1 shape
  assert.equal(decodeSwapV2(fixture(0)), null); // uninitialized
  assert.equal(decodeSwapV2(fixture(9)), null); // unknown/garbage
});

test("decodeSwapV2 fails closed on a too-short buffer", () => {
  assert.equal(decodeSwapV2(new Uint8Array(10)), null);
  assert.equal(decodeSwapV2(null), null);
});

// A-arm (drops the A-side subtraction).
test("lpOwnedReserves excludes protocol_fees_a from vaultA", () => {
  const { reserveA } = lpOwnedReserves({ vaultA: 1000n, vaultB: 0n, feesA: 300n, feesB: 0n });
  assert.equal(reserveA, 700n);
});

// B-arm (drops the B-side subtraction) — its own case, symmetric to
// the A-arm above: every two-sided thing gets both arms
// tested independently.
test("lpOwnedReserves excludes protocol_fees_b from vaultB", () => {
  const { reserveB } = lpOwnedReserves({ vaultA: 0n, vaultB: 2000n, feesA: 0n, feesB: 500n });
  assert.equal(reserveB, 1500n);
});

// Drops the zero-clamp — a transient RPC-read skew (counter read
// after a vault credit, before its own accrual write) must clamp to 0,
// never go negative.
test("lpOwnedReserves clamps to zero when the counter exceeds the vault", () => {
  const { reserveA, reserveB } = lpOwnedReserves({ vaultA: 100n, vaultB: 100n, feesA: 500n, feesB: 900n });
  assert.equal(reserveA, 0n);
  assert.equal(reserveB, 0n);
});

// A null decode (transient RPC failure of the
// swap-state read, or a not-yet-v2 account) must read as "pool unavailable"
// — reserves 0n — NOT the raw vault balance with fees treated as 0. The
// vault-read failure arm already fails closed (a failed getAccount ->
// 0n vault -> lpOwnedReserves clamps to 0); this pins the STATE-read arm to
// the same shape so the two failure modes can't diverge.
test("reservesFromVaults fails CLOSED on a null decode — not raw vault", () => {
  const { reserveA, reserveB } = reservesFromVaults({
    vaultA: 5_000_000n, vaultB: 3_000_000n, decoded: null,
  });
  assert.equal(reserveA, 0n);
  assert.equal(reserveB, 0n);
});

test("reservesFromVaults excludes fees normally when decode succeeds", () => {
  const { reserveA, reserveB } = reservesFromVaults({
    vaultA: 1000n, vaultB: 2000n, decoded: { protocolFeesA: 300n, protocolFeesB: 500n },
  });
  assert.equal(reserveA, 700n);
  assert.equal(reserveB, 1500n);
});
