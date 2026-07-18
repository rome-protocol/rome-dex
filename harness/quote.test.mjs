// Quote-SDK fidelity suite: the off-chain quote must match what the pool
// actually pays/delivers on-chain, to the unit. This is the guarantee a
// best-in-class DEX SDK makes — the number you're shown is the number you get.

import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteExactIn, quoteExactOut, POOL_FEES } from "../sdk/quote.mjs";
import {
  payer, pool, bal, reserves, swapAccounts, swapData, swapExactOutData, execSolana, mintIfLow,
} from "./lib.mjs";

const MAX_IN = 100_000_000n;

test("quoteExactIn matches realized on-chain output (A→B, Solana lane)", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, MAX_IN, 500_000_000n);
  const { a, b } = await reserves();
  const amountIn = 2_000_000n; // 2 A
  const q = quoteExactIn({ amountIn, reserveIn: a, reserveOut: b, fees: POOL_FEES });

  const before = await bal(pool.payerAtaB);
  await execSolana({
    accounts: swapAccounts("AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB),
    data: swapData(amountIn, 0n),
  });
  const realized = (await bal(pool.payerAtaB)) - before;
  assert.equal(q.amountOut, realized, `quote ${q.amountOut} vs realized ${realized}`);
});

test("quoteExactOut matches realized on-chain input (A→B, Solana lane)", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, MAX_IN, 500_000_000n);
  const { a, b } = await reserves();
  const amountOut = 1_500_000n; // 0.0015 B
  const q = quoteExactOut({ amountOut, reserveIn: a, reserveOut: b, fees: POOL_FEES });

  const beforeA = await bal(pool.payerAtaA);
  const beforeB = await bal(pool.payerAtaB);
  await execSolana({
    accounts: swapAccounts("AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB),
    data: swapExactOutData(amountOut, MAX_IN),
  });
  const paid = beforeA - (await bal(pool.payerAtaA));
  const got = (await bal(pool.payerAtaB)) - beforeB;
  assert.equal(got, amountOut, "must receive exactly amountOut");
  assert.equal(q.amountIn, paid, `quote input ${q.amountIn} vs realized ${paid}`);
});
