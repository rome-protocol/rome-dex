// Atomic compose suite: ZAP-IN — provide only token A, receive LP in ONE Solana
// tx (Swap A→B + DepositAllTokenTypes composed atomically). Also proves the
// compose is all-or-nothing: if the deposit leg can't be satisfied, the swap
// leg reverts too.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { quoteZap } from "../sdk/quote.mjs";
import {
  payer, pool, bal, reserves, lpSupply, ensureAta, mintIfLow,
  swapAccounts, depositAccounts, swapData, depositData, execSolanaMulti,
} from "./lib.mjs";

const cu = {};

test("atomic zap-in: swap + add-liquidity in one tx mints exactly the quoted LP", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, 100_000_000n, 500_000_000n);
  const payerLp = await ensureAta(pool.poolMint, payer.publicKey);
  const { a, b } = await reserves();
  const supply = await lpSupply();
  const amountIn = 4_000_000n; // 4 token A, zapped into LP

  const q = quoteZap({ amountIn, reserveA: a, reserveB: b, lpSupply: supply });
  assert.ok(q.lpTokens > 0n, "zap should yield LP");

  const lpBefore = await bal(payerLp);
  const r = await execSolanaMulti([
    { accounts: swapAccounts("AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB), data: swapData(q.swapAmount, 0n) },
    { accounts: depositAccounts(payer.publicKey, pool.payerAtaA, pool.payerAtaB, payerLp), data: depositData(q.lpTokens, q.maxA, q.maxB) },
  ]);
  assert.ok(r.ok, "atomic zap should land");

  const lpDelta = (await bal(payerLp)) - lpBefore;
  assert.equal(lpDelta, q.lpTokens, `LP minted ${lpDelta} vs quoted ${q.lpTokens}`);
  cu.zap = r.cu;
});

test("zap atomicity: an unsatisfiable deposit leg reverts the whole tx (swap included)", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, 100_000_000n, 500_000_000n);
  const payerLp = await ensureAta(pool.poolMint, payer.publicKey);
  const { a, b } = await reserves();
  const supply = await lpSupply();
  const q = quoteZap({ amountIn: 4_000_000n, reserveA: a, reserveB: b, lpSupply: supply });

  const lpBefore = await bal(payerLp);
  const bBefore = await bal(pool.payerAtaB);
  // maxA = 1 makes the deposit's required token A exceed the cap → deposit fails.
  await assert.rejects(
    execSolanaMulti([
      { accounts: swapAccounts("AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB), data: swapData(q.swapAmount, 0n) },
      { accounts: depositAccounts(payer.publicKey, pool.payerAtaA, pool.payerAtaB, payerLp), data: depositData(q.lpTokens, 1n, q.maxB) },
    ]),
    "unsatisfiable deposit must reject",
  );
  // Atomic: neither leg persisted — LP unchanged AND the swap's B output rolled back.
  assert.equal((await bal(payerLp)) - lpBefore, 0n, "no LP minted on revert");
  assert.equal((await bal(pool.payerAtaB)) - bBefore, 0n, "swap leg rolled back (no B received)");
});

after(() => {
  console.log("\n=== atomic zap-in (swap + add-liquidity, one Solana tx) ===");
  console.log(`  zap CU : ${cu.zap ?? "—"}  (single atomic tx, one signature)`);
});
