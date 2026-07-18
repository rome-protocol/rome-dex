// Unit test for the SPL delegate-approval encoder. Security fix: the router
// must grant only the amount THIS op needs, never an unbounded (u64-max)
// delegate that a later compromise could drain. Pure logic, no browser/RPC.

import { test, expect } from "@playwright/test";
import { buildApproveData } from "../lib/router";

test.describe("buildApproveData — scoped SPL delegate approval", () => {
  test("encodes the exact needed amount, not u64-max", () => {
    const needed = 12_345_678n;
    const d = buildApproveData(needed);
    expect(d[0]).toBe(4); // SPL-Token Approve discriminator
    expect(d.readBigUInt64LE(1)).toBe(needed);
    // Guard against regressing to the old unbounded approval.
    expect(d.readBigUInt64LE(1)).not.toBe(18_446_744_073_709_551_615n);
  });

  test("is a 9-byte buffer (tag + u64)", () => {
    expect(buildApproveData(1n)).toHaveLength(9);
  });
});
