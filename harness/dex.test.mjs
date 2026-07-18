// rome-dex dual-lane integration suite (node:test), run against the LIVE
// upgraded program on Hadrian's devnet substrate. Proves each instruction works
// identically from the Solana lane and the EVM (CPI) lane, and records CU.
//
//   run:  HADRIAN_PRIVATE_KEY=<your-funded-devnet-key> \
//         node --test harness/dex.test.mjs
//
// The EVM-lane tests skip (not fail) when HADRIAN_PRIVATE_KEY is absent.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  payer, pool, bal, evmPdaFor, ensureAta, mintIfLow, EVM_DEPLOYER,
  swapAccounts, swapData, swapExactOutData, execSolana, execEvmCpi,
} from "./lib.mjs";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const OUT = 1_000_000n;        // exact output: 0.001 token B (9 dp)
const MAX_IN = 100_000_000n;   // generous input cap: 100 token A (6 dp)
const cu = {};

// ---------------------------------------------------------------- Solana lane
test("exact-out A→B (Solana lane) delivers EXACTLY the requested output", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, MAX_IN, 500_000_000n);
  const before = await bal(pool.payerAtaB);
  const r = await execSolana({
    accounts: swapAccounts("AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB),
    data: swapExactOutData(OUT, MAX_IN),
  });
  assert.ok(r.ok, "swap should succeed");
  const delta = (await bal(pool.payerAtaB)) - before;
  assert.equal(delta, OUT, `expected exactly ${OUT} B out, got ${delta}`);
  cu.solanaExactOut = r.cu;
});

test("exact-out slippage guard: max_in below required input reverts (Solana lane)", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, MAX_IN, 500_000_000n);
  await assert.rejects(
    execSolana({
      accounts: swapAccounts("AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB),
      data: swapExactOutData(OUT, 1n), // 1 unit cap — impossible
    }),
    "a 1-unit input cap must be rejected",
  );
});

test("exact-in A→B (Solana lane) still works (regression)", async () => {
  await mintIfLow(pool.mintA, pool.payerAtaA, MAX_IN, 500_000_000n);
  const before = await bal(pool.payerAtaB);
  const r = await execSolana({
    accounts: swapAccounts("AtoB", payer.publicKey, pool.payerAtaA, pool.payerAtaB),
    data: swapData(1_000_000n, 0n),
  });
  assert.ok(r.ok);
  assert.ok((await bal(pool.payerAtaB)) - before > 0n, "should receive some B");
  cu.solanaExactIn = r.cu;
});

// ------------------------------------------------------------------- EVM lane
test("exact-out A→B (EVM lane via CPI) delivers EXACTLY the requested output", { skip: KEY ? false : "no HADRIAN_PRIVATE_KEY" }, async () => {
  const pda = evmPdaFor(EVM_DEPLOYER);
  const evmA = await ensureAta(pool.mintA, pda, true);
  const evmB = await ensureAta(pool.mintB, pda, true);
  await mintIfLow(pool.mintA, evmA, MAX_IN, 500_000_000n);
  const before = await bal(evmB);
  const r = await execEvmCpi({
    accounts: swapAccounts("AtoB", pda, evmA, evmB),
    data: swapExactOutData(OUT, MAX_IN),
    key: KEY,
  });
  assert.ok(r.ok, `EVM swap should succeed: ${r.error || ""}`);
  const delta = (await bal(evmB)) - before;
  assert.equal(delta, OUT, `expected exactly ${OUT} B out on EVM lane, got ${delta}`);
  cu.evmExactOut = r.maxCu;
  cu.evmExactOutLegs = r.legs;
});

test("exact-out slippage guard reverts on EVM lane too", { skip: KEY ? false : "no HADRIAN_PRIVATE_KEY" }, async () => {
  const pda = evmPdaFor(EVM_DEPLOYER);
  const evmA = await ensureAta(pool.mintA, pda, true);
  const evmB = await ensureAta(pool.mintB, pda, true);
  await mintIfLow(pool.mintA, evmA, MAX_IN, 500_000_000n);
  const before = await bal(evmB);
  const r = await execEvmCpi({
    accounts: swapAccounts("AtoB", pda, evmA, evmB),
    data: swapExactOutData(OUT, 1n),
    key: KEY,
  });
  // Either the send is rejected, or it lands with no output delta (reverted CPI).
  const delta = (await bal(evmB)) - before;
  assert.equal(delta, 0n, "no output should be delivered when the input cap is impossible");
});

after(() => {
  console.log("\n=== exact-out swap — dual-lane CU (same pool " + pool.swapState.slice(0, 8) + "…) ===");
  console.log(`  Solana lane exact-out : ${cu.solanaExactOut ?? "—"} CU`);
  console.log(`  EVM lane    exact-out : ${cu.evmExactOut ?? "—"} CU  (legs=${cu.evmExactOutLegs ?? "—"})`);
  if (cu.solanaExactOut && cu.evmExactOut)
    console.log(`  parity ratio          : ${(cu.evmExactOut / cu.solanaExactOut).toFixed(2)}×  (both « 1.4M)`);
  console.log(`  Solana lane exact-in  : ${cu.solanaExactIn ?? "—"} CU  (regression check)`);
});
