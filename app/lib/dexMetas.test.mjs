import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSwapMetas, buildDepositMetas, buildWithdrawMetas } from "./dexMetas.mjs";

const POOL = {
  swapState: "SWAP",
  authority: "AUTH",
  vaultA: "VAULT_A",
  vaultB: "VAULT_B",
  poolMint: "POOL_MINT",
  mintA: "MINT_A",
  mintB: "MINT_B",
};
const TOKEN_PROGRAM = "TOKEN_PROGRAM";
const AUTHORITY = "USER_AUTH";

test("buildSwapMetas AtoB: 13 metas, pool state writable, no fee-account slot", () => {
  const m = buildSwapMetas("AtoB", AUTHORITY, "SRC_ATA", "DST_ATA", POOL, TOKEN_PROGRAM);
  assert.equal(m.length, 13);
  assert.deepEqual(m[0], { pubkey: "SWAP", isSigner: false, isWritable: true });
  assert.deepEqual(m[1], { pubkey: "AUTH", isSigner: false, isWritable: false });
  assert.deepEqual(m[2], { pubkey: AUTHORITY, isSigner: true, isWritable: false });
  assert.deepEqual(m[3], { pubkey: "SRC_ATA", isSigner: false, isWritable: true });
  assert.deepEqual(m[4], { pubkey: "VAULT_A", isSigner: false, isWritable: true });
  assert.deepEqual(m[5], { pubkey: "VAULT_B", isSigner: false, isWritable: true });
  assert.deepEqual(m[6], { pubkey: "DST_ATA", isSigner: false, isWritable: true });
  assert.deepEqual(m[7], { pubkey: "POOL_MINT", isSigner: false, isWritable: true });
  assert.deepEqual(m[8], { pubkey: "MINT_A", isSigner: false, isWritable: false });
  assert.deepEqual(m[9], { pubkey: "MINT_B", isSigner: false, isWritable: false });
  for (const i of [10, 11, 12]) {
    assert.deepEqual(m[i], { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false });
  }
  assert.ok(!m.some((a) => a.pubkey === "FEE_ACCOUNT"));
});

// Symmetric arm: BtoA swaps src/dst vault + mint —
// a hardcoded-direction mutant reddens here, not in the AtoB test above.
test("buildSwapMetas BtoA: source/destination vaults and mints swap", () => {
  const m = buildSwapMetas("BtoA", AUTHORITY, "SRC_ATA", "DST_ATA", POOL, TOKEN_PROGRAM);
  assert.deepEqual(m[4], { pubkey: "VAULT_B", isSigner: false, isWritable: true }); // src vault
  assert.deepEqual(m[5], { pubkey: "VAULT_A", isSigner: false, isWritable: true }); // dst vault
  assert.deepEqual(m[8], { pubkey: "MINT_B", isSigner: false, isWritable: false }); // src mint
  assert.deepEqual(m[9], { pubkey: "MINT_A", isSigner: false, isWritable: false }); // dst mint
});

test("buildDepositMetas: 14 metas, UNCHANGED shape (tag 2 untouched)", () => {
  const m = buildDepositMetas(AUTHORITY, "UA", "UB", "ULP", POOL, TOKEN_PROGRAM);
  assert.equal(m.length, 14);
  assert.deepEqual(m[0], { pubkey: "SWAP", isSigner: false, isWritable: false });
  assert.deepEqual(m[5], { pubkey: "VAULT_A", isSigner: false, isWritable: true });
  assert.deepEqual(m[6], { pubkey: "VAULT_B", isSigner: false, isWritable: true });
});

test("buildWithdrawMetas: 14 metas, fee slot dropped, no fee-account slot", () => {
  const m = buildWithdrawMetas(AUTHORITY, "ULP", "UA", "UB", POOL, TOKEN_PROGRAM);
  assert.equal(m.length, 14);
  assert.deepEqual(m[0], { pubkey: "SWAP", isSigner: false, isWritable: false });
  assert.deepEqual(m[3], { pubkey: "POOL_MINT", isSigner: false, isWritable: true });
  assert.deepEqual(m[4], { pubkey: "ULP", isSigner: false, isWritable: true });
  assert.deepEqual(m[5], { pubkey: "VAULT_A", isSigner: false, isWritable: true });
  assert.deepEqual(m[6], { pubkey: "VAULT_B", isSigner: false, isWritable: true });
  assert.deepEqual(m[7], { pubkey: "UA", isSigner: false, isWritable: true });
  assert.deepEqual(m[8], { pubkey: "UB", isSigner: false, isWritable: true });
  assert.deepEqual(m[9], { pubkey: "MINT_A", isSigner: false, isWritable: false });
  assert.deepEqual(m[10], { pubkey: "MINT_B", isSigner: false, isWritable: false });
  for (const i of [11, 12, 13]) {
    assert.deepEqual(m[i], { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false });
  }
  assert.ok(!m.some((a) => a.pubkey === "FEE_ACCOUNT"));
});
