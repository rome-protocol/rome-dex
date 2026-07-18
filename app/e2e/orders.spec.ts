/**
 * orders.spec.ts — Limit / DCA orders (roadmap #3, PR ④).
 *
 * Two halves, both run by the Playwright suite:
 *   1. Pure-logic unit tests for lib/orders.ts — placeData byte layout (mirrors
 *      harness/orders.test.mjs) + parseOrder roundtrip (mirrors keeper.mjs
 *      offsets). No browser (same style as txerror/explorer specs).
 *   2. Browser render/gate tests — the Market/Limit/DCA tabs, the Solana-lane
 *      gate note when no Solana wallet is connected, and the open-orders empty
 *      state. No on-chain tx is submitted (wallet-only app, no keys in CI).
 */
import { test, expect } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import {
  placeData,
  cancelData,
  parseOrder,
  orderPda,
  ownerAta,
  ORDER_LEN,
  ORDERS_PROGRAM,
} from "../lib/orders";

// Regression: the EVM-lane order owner is an off-curve external_auth PDA, so
// deriving its ATA must NOT throw TokenOwnerOffCurveError (the empty-error-box
// place-order failure the operator hit). ownerAta must allow off-curve owners.
test("ownerAta accepts an off-curve (PDA) owner — the EVM external_auth case", () => {
  const [offCurvePda] = orderPda(new PublicKey("11111111111111111111111111111111"), 1n);
  const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  expect(() => ownerAta(mint, offCurvePda)).not.toThrow();
});

// ── 1. lib/orders.ts — pure logic ────────────────────────────────────────────

test.describe("placeData — byte layout mirrors the on-chain instruction", () => {
  test("packs every field at the right offset (tag 0)", () => {
    const data = placeData({
      nonce: 42n,
      bump: 254,
      aToB: true,
      amountInTotal: 100_000n,
      trancheIn: 25_000n,
      minOutPerTranche: 7n,
      intervalSecs: 3_600n,
      expiryTs: 1_800_000_000n,
      keeperFeeBps: 10,
    });
    // 1 + 8 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 2 = 53 bytes.
    expect(data.length).toBe(53);
    expect(data[0]).toBe(0); // Place tag
    expect(data.readBigUInt64LE(1)).toBe(42n); // nonce
    expect(data[9]).toBe(254); // bump
    expect(data[10]).toBe(1); // aToB = true
    expect(data.readBigUInt64LE(11)).toBe(100_000n); // amountInTotal
    expect(data.readBigUInt64LE(19)).toBe(25_000n); // trancheIn
    expect(data.readBigUInt64LE(27)).toBe(7n); // minOutPerTranche
    expect(data.readBigUInt64LE(35)).toBe(3_600n); // intervalSecs
    expect(data.readBigInt64LE(43)).toBe(1_800_000_000n); // expiryTs (i64)
    expect(data.readUInt16LE(51)).toBe(10); // keeperFeeBps (u16)
  });

  test("aToB=false encodes 0", () => {
    const data = placeData({
      nonce: 1n, bump: 255, aToB: false, amountInTotal: 1n, trancheIn: 1n,
      minOutPerTranche: 0n, intervalSecs: 0n, expiryTs: 0n, keeperFeeBps: 0,
    });
    expect(data[10]).toBe(0);
  });

  test("cancelData is the single-byte tag 2", () => {
    const c = cancelData();
    expect(c.length).toBe(1);
    expect(c[0]).toBe(2);
  });
});

test.describe("parseOrder — 230-byte account roundtrip (mirrors keeper.mjs)", () => {
  test("reads every field back at the right offset", () => {
    const owner = new PublicKey(Buffer.alloc(32, 3));
    const pool = new PublicKey(Buffer.alloc(32, 5));
    const inEsc = new PublicKey(Buffer.alloc(32, 7));
    const outEsc = new PublicKey(Buffer.alloc(32, 9));
    const dstAta = new PublicKey(Buffer.alloc(32, 11));

    const buf = Buffer.alloc(ORDER_LEN);
    buf[0] = 1; // isInitialized
    buf[1] = 253; // bump
    buf[2] = 0; // status = Open
    owner.toBuffer().copy(buf, 3);
    pool.toBuffer().copy(buf, 35);
    inEsc.toBuffer().copy(buf, 67);
    outEsc.toBuffer().copy(buf, 99);
    dstAta.toBuffer().copy(buf, 131);
    buf.writeBigUInt64LE(123_456_789n, 163); // nonce
    buf[171] = 1; // aToB
    buf.writeBigUInt64LE(1_000_000n, 172); // amountInTotal
    buf.writeBigUInt64LE(750_000n, 180); // remainingIn
    buf.writeBigUInt64LE(250_000n, 188); // trancheIn
    buf.writeBigUInt64LE(42n, 196); // minOutPerTranche
    buf.writeBigUInt64LE(3_600n, 204); // intervalSecs
    buf.writeBigInt64LE(1_700_000_000n, 212); // lastExecTs
    buf.writeBigInt64LE(1_800_000_000n, 220); // expiryTs
    buf.writeUInt16LE(10, 228); // keeperFeeBps

    const o = parseOrder(buf);
    expect(o.isInitialized).toBe(true);
    expect(o.bump).toBe(253);
    expect(o.status).toBe(0);
    expect(o.owner).toBe(owner.toBase58());
    expect(o.pool).toBe(pool.toBase58());
    expect(o.inputEscrow).toBe(inEsc.toBase58());
    expect(o.outputEscrow).toBe(outEsc.toBase58());
    expect(o.dstAta).toBe(dstAta.toBase58());
    expect(o.nonce).toBe(123_456_789n);
    expect(o.aToB).toBe(true);
    expect(o.amountInTotal).toBe(1_000_000n);
    expect(o.remainingIn).toBe(750_000n);
    expect(o.trancheIn).toBe(250_000n);
    expect(o.minOutPerTranche).toBe(42n);
    expect(o.intervalSecs).toBe(3_600n);
    expect(o.lastExecTs).toBe(1_700_000_000n);
    expect(o.expiryTs).toBe(1_800_000_000n);
    expect(o.keeperFeeBps).toBe(10);
  });
});

test.describe("orderPda — deterministic PDA seeds", () => {
  test("same owner+nonce → same PDA; different nonce → different PDA", () => {
    const owner = new PublicKey(Buffer.alloc(32, 3));
    const [a] = orderPda(owner, 1n);
    const [b] = orderPda(owner, 1n);
    const [c] = orderPda(owner, 2n);
    expect(a.toBase58()).toBe(b.toBase58());
    expect(a.toBase58()).not.toBe(c.toBase58());
    // PDA is off-curve and owned by the orders program's seed space.
    expect(PublicKey.isOnCurve(a.toBytes())).toBe(false);
    expect(ORDERS_PROGRAM.toBase58()).toBe("ordWTztCBW7fpoq6eLHQBp2aeoB17CAbmAx6FjtfQ7C");
  });
});

// ── 2. Browser — tabs, gate, empty state ─────────────────────────────────────

test.describe("Swap surface — Market / Limit / DCA tabs", () => {
  test("all three tabs render; Limit + DCA show the orders form", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("order-tabs")).toBeVisible();
    await expect(page.getByTestId("order-tab-market")).toBeVisible();
    await expect(page.getByTestId("order-tab-limit")).toBeVisible();
    await expect(page.getByTestId("order-tab-dca")).toBeVisible();

    // Market is the default → SwapPanel, no orders form.
    await expect(page.getByTestId("swap-panel")).toBeVisible();
    await expect(page.getByTestId("orders-form")).toHaveCount(0);

    // Limit tab → orders form with amount + price fields.
    await page.getByTestId("order-tab-limit").click();
    await expect(page.getByTestId("orders-form")).toBeVisible();
    await expect(page.getByTestId("orders-amount")).toBeVisible();
    await expect(page.getByTestId("orders-price")).toBeVisible();
    await expect(page.getByTestId("swap-panel")).toHaveCount(0);

    // DCA tab → schedule fields (tranches + interval).
    await page.getByTestId("order-tab-dca").click();
    await expect(page.getByTestId("orders-form")).toBeVisible();
    await expect(page.getByTestId("orders-tranches")).toBeVisible();
    await expect(page.getByTestId("orders-interval")).toBeVisible();
  });

  test("no-wallet note + connect CTA when no wallet is connected", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("order-tab-limit").click();
    const note = page.getByTestId("orders-connect-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Connect");
    // Dual-lane: the CTA offers to connect a wallet (both lanes place orders).
    await expect(page.getByTestId("orders-place-btn")).toContainText("Connect a wallet");
  });
});

test.describe("Open orders — Positions screen", () => {
  test("empty state renders with no wallet", async ({ page }) => {
    await page.goto("/positions");
    await expect(page.getByTestId("open-orders")).toBeVisible();
    const empty = page.getByTestId("open-orders-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No open orders.");
  });
});
