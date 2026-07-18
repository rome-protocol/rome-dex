// create-pool-app-path.test.mjs — BRAND-NEW-WALLET, APP-PATH acceptance for the
// EVM-lane simple-pool create. Imports the app's OWN pure builder
// (app/lib/createPool.ts buildEvmCreatePoolCalls) and submits its literal
// calldata with a fresh EVM wallet — so what lands on-chain here is
// byte-identical to what the UI sends.
//
// This exists because the earlier proof (create-simple-pool.test.mjs) funded
// the vaults from the DEPLOYER's Solana keypair — the app path funds them from
// the USER's own tokens via HelperProgram transfer_spl, and that leg shipped
// with a selector that doesn't exist (0x8b0caf87). This test fails on that
// encoding and passes on the fixed one.
//
// Run: HADRIAN_PRIVATE_KEY=<deployer> node --import tsx --test create-pool-app-path.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint } from "@solana/spl-token";
import { ethers } from "ethers";
import { conn, payer, PK, evmPdaFor, EVM_RPC, resolveGas } from "./lib.mjs";
import { buildEvmCreatePoolCalls, CREATE_FEE_TIERS } from "../app/lib/createPool";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const DEX = new PublicKey(JSON.parse(fs.readFileSync(new URL("./pool.json", import.meta.url), "utf8")).program);
const FEE_BPS = 30;
const SEED = 50_000_000n; // 50 of a 6dp test token per side

const bal = async (a) => { try { return (await getAccount(conn, PK(a))).amount; } catch { return 0n; } };

test("EVM-lane CREATE POOL, app path — fresh wallet submits the app's literal calldata", { skip: !KEY }, async () => {
  // Fresh EVM wallet; deployer funds gas only (the app precondition is a user
  // who already HOLDS the two tokens — minted to their external_auth PDA ATAs).
  const wallet = ethers.Wallet.createRandom();
  const owner = evmPdaFor(wallet.address);
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const dep = new ethers.Wallet(KEY.trim(), provider);
  {
    const g = await resolveGas({ from: dep.address, to: wallet.address, data: "0x" });
    const nonce = await provider.getTransactionCount(dep.address, "pending");
    await (await dep.sendTransaction({ to: wallet.address, value: ethers.parseEther("5"), type: 2, nonce, ...g, gasLimit: 30_000_000n })).wait(1);
  }
  const mintA = await createMint(conn, payer, payer.publicKey, null, 6);
  const mintB = await createMint(conn, payer, payer.publicKey, null, 6);
  for (const mint of [mintA, mintB]) {
    const ata = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, owner, true)).address;
    await mintTo(conn, payer, mint, ata, payer, 100_000_000n); // user holds 100
  }

  // The app's exact call sequence (fresh PDA → bootstrap + both vaults needed).
  const { calls, resolved: r } = buildEvmCreatePoolCalls({
    program: DEX, owner, mintA, mintB, feeBps: FEE_BPS,
    fees: CREATE_FEE_TIERS.find((t) => t.feeBps === FEE_BPS).fees,
    seedA: SEED, seedB: SEED, needBootstrap: true, needVaultA: true, needVaultB: true,
  });
  assert.equal(calls.length, 6, "bootstrap + 2 vault creates + 2 funds + CreatePool");

  const signer = wallet.connect(provider);
  for (const call of calls) {
    const g = await resolveGas({ from: wallet.address, to: call.to, data: call.data });
    const nonce = await provider.getTransactionCount(wallet.address, "pending");
    const tx = await signer.sendTransaction({ to: call.to, data: call.data, type: 2, value: 0n, nonce, ...g });
    const rcpt = await tx.wait(1);
    assert.equal(rcpt.status, 1, `call "${call.label}" reverted (${tx.hash})`);
  }

  // Vaults hold exactly the user's seeds; the pool is live with LP to the creator.
  assert.equal(await bal(r.vaultA), SEED, "vault A funded from the user's own tokens");
  assert.equal(await bal(r.vaultB), SEED, "vault B funded from the user's own tokens");
  const info = await conn.getAccountInfo(r.pool);
  assert.ok(info, "pool account created");
  assert.ok(info.owner.equals(DEX), "pool owned by the DEX program");
  assert.equal(info.data[0], 1, "SwapV1 is_initialized");
  assert.ok((await getMint(conn, r.lpMint)).supply > 0n, "LP mint has initial supply");
  assert.ok((await bal(r.destination)) > 0n, "creator's destination holds the initial LP");
  console.log(`  APP-PATH create: fresh wallet ${wallet.address.slice(0, 10)}… made pool ${r.pool.toBase58().slice(0, 8)}… via the UI's own calldata (${calls.length} txs)`);
});
