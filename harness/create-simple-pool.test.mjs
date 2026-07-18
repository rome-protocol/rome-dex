// create-simple-pool.test.mjs — BRAND-NEW-WALLET ACCEPTANCE for CreatePool (tag 7):
// create a NEW constant-product pool over two tokens with NO ephemeral signers,
// on BOTH lanes. The crux is that the program creates the pool state PDA + LP mint
// PDA + fee/destination PDAs internally, so a fresh Solana keypair OR a fresh EVM
// wallet (via the CPI precompile, external_auth PDA auto-signed as payer) can
// create a pool — the thing the classic Initialize (ephemeral signers) can't do
// on the EVM lane.
//
// Run:
//   node --import tsx --test create-simple-pool.test.mjs               # Solana only
//   HADRIAN_PRIVATE_KEY=<deployer> node --import tsx --test create-simple-pool.test.mjs   # both

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ethers } from "ethers";
import { conn, payer, PK, execEvmCpi, evmPdaFor, EVM_RPC, CHAIN_ID, resolveGas, evmRpc, swapAccountsFor, swapData } from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.HADRIAN_PRIVATE_KEY;
const DEX = new PublicKey(JSON.parse(fs.readFileSync(path.join(DIR, "pool.json"), "utf8")).program);
const TOKEN = TOKEN_PROGRAM_ID;
const SYSTEM = SystemProgram.programId;
const HELPER = "0xff00000000000000000000000000000000000009";
const FEE_BPS = 30; // 0.30% tier

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const b32 = (pk) => "0x" + Buffer.from(PK(pk).toBuffer()).toString("hex");
const bal = async (a) => { try { return (await getAccount(conn, PK(a))).amount; } catch { return 0n; } };

// Fees for the 0.30% tier + ConstantProduct curve — byte-identical to
// create-pool2.mjs / create-tiered-pools.mjs (the classic Initialize encoding).
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const FEES = Buffer.concat([u64(25), u64(10000), u64(5), u64(10000), u64(0), u64(10000), u64(0), u64(10000)]);
const CURVE = Buffer.concat([Buffer.from([0]), Buffer.alloc(32)]); // ConstantProduct + 32 zero
// CreatePool data: [7][fee_bps u16][pool_bump][lp_bump][fees(64)][curve(33)]
const createPoolData = (poolBump, lpBump) =>
  Buffer.concat([Buffer.from([7]), u16(FEE_BPS), Buffer.from([poolBump]), Buffer.from([lpBump]), FEES, CURVE]);

// PDA derivations (seeds per program/src/processor.rs process_create_pool).
const poolPdaFor = (m0, m1) =>
  PublicKey.findProgramAddressSync([Buffer.from("cp_pool"), PK(m0).toBuffer(), PK(m1).toBuffer(), u16(FEE_BPS)], DEX);
const authorityFor = (pool) => PublicKey.findProgramAddressSync([PK(pool).toBuffer()], DEX);
const lpMintFor = (pool) => PublicKey.findProgramAddressSync([Buffer.from("cp_lp"), PK(pool).toBuffer()], DEX);
const feeFor = (pool) => PublicKey.findProgramAddressSync([Buffer.from("cp_fee"), PK(pool).toBuffer()], DEX);
const destFor = (pool) => PublicKey.findProgramAddressSync([Buffer.from("cp_dest"), PK(pool).toBuffer()], DEX);

// Two fresh 6-dp mints (payer = mint authority → depletion-proof tiny seed).
async function twoMints() {
  const a = await createMint(conn, payer, payer.publicKey, null, 6);
  const b = await createMint(conn, payer, payer.publicKey, null, 6);
  return [a, b];
}

// Build the full CreatePool account layout + fund the vaults (authority's ATAs).
async function setup(creatorKey) {
  const [mintA, mintB] = await twoMints();
  const [pool, poolBump] = poolPdaFor(mintA, mintB);
  const [authority] = authorityFor(pool);
  const [lpMint, lpBump] = lpMintFor(pool);
  const [feeAcct] = feeFor(pool);
  const [dest] = destFor(pool);
  // Vaults = authority's ATAs; the caller pre-creates + funds them (like Initialize).
  const vaultA = (await getOrCreateAssociatedTokenAccount(conn, payer, mintA, authority, true)).address;
  const vaultB = (await getOrCreateAssociatedTokenAccount(conn, payer, mintB, authority, true)).address;
  await mintTo(conn, payer, mintA, vaultA, payer, 100_000_000n); // 100 A seed
  await mintTo(conn, payer, mintB, vaultB, payer, 100_000_000n); // 100 B seed
  const accounts = [
    ["payer", 1, 1], ["pool", 0, 1], ["authority", 0, 0], ["mintA", 0, 0], ["mintB", 0, 0],
    ["vaultA", 0, 1], ["vaultB", 0, 1], ["lpMint", 0, 1], ["feeAcct", 0, 1], ["dest", 0, 1],
    ["token", 0, 0], ["system", 0, 0],
  ];
  const map = { payer: creatorKey, pool, authority, mintA, mintB, vaultA, vaultB, lpMint, feeAcct, dest, token: TOKEN, system: SYSTEM };
  return { mintA, mintB, pool, poolBump, authority, lpMint, lpBump, feeAcct, dest, vaultA, vaultB, accounts, map };
}

async function assertPool(s) {
  const info = await conn.getAccountInfo(s.pool);
  assert.ok(info, "pool account created");
  assert.ok(info.owner.equals(DEX), "pool owned by the DEX program");
  assert.equal(info.data[0], 1, "SwapV1 is_initialized");
  const lpSupply = (await getMint(conn, s.lpMint)).supply;
  assert.ok(lpSupply > 0n, `LP mint has initial supply (got ${lpSupply})`);
  assert.ok((await bal(s.dest)) > 0n, "creator's destination holds the initial LP");
}

// ── TEST 1 — Solana lane ─────────────────────────────────────────────────────
test("CREATE SIMPLE POOL (Solana lane) — fresh keypair, new constant-product pool", async () => {
  const creator = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: creator.publicKey, lamports: 2 * LAMPORTS_PER_SOL,
  })), [payer], { commitment: "confirmed" });

  const s = await setup(creator.publicKey);
  assert.equal(await conn.getAccountInfo(s.pool), null, "pool brand-new (not yet created)");
  const keys = s.accounts.map(([name, sign, w]) => acc(s.map[name], sign, w));
  const ix = new TransactionInstruction({ programId: DEX, keys, data: createPoolData(s.poolBump, s.lpBump) });
  await sendAndConfirmTransaction(conn, new Transaction().add(ix), [creator], { commitment: "confirmed" });
  await assertPool(s);
  console.log(`  Solana-lane CREATE SIMPLE POOL: fresh keypair made pool ${s.pool.toBase58().slice(0, 8)}… (LP to creator)`);

  // TRADABLE: swap through the freshly-created pool — the SAME Swap ix (tag 1 +
  // 14-account layout) the UI's myPoolTrade.ts builds. Proves a CreatePool pool
  // (PDA accounts) accepts a Swap exactly like a classic keypair pool.
  const cAtaA = (await getOrCreateAssociatedTokenAccount(conn, payer, s.mintA, creator.publicKey)).address;
  const cAtaB = (await getOrCreateAssociatedTokenAccount(conn, payer, s.mintB, creator.publicKey)).address;
  await mintTo(conn, payer, s.mintA, cAtaA, payer, 1_000_000n); // give the creator 1 A to sell
  const poolCfg = { swapState: s.pool, authority: s.authority, vaultA: s.vaultA, vaultB: s.vaultB, mintA: s.mintA, mintB: s.mintB, poolMint: s.lpMint, feeAccount: s.feeAcct };
  const before = await bal(cAtaB);
  const swapIx = new TransactionInstruction({ programId: DEX, keys: swapAccountsFor(poolCfg, "AtoB", creator.publicKey, cAtaA, cAtaB), data: swapData(500_000n, 1n) });
  await sendAndConfirmTransaction(conn, new Transaction().add(swapIx), [creator], { commitment: "confirmed" });
  const got = (await bal(cAtaB)) - before;
  assert.ok(got > 0n, `swap through the created pool delivered token B (got ${got})`);
  console.log(`  Solana-lane TRADE: swapped 500000 A → ${got} B through the created pool`);
});

// ── TEST 2 — EVM lane (THE CRUX) ─────────────────────────────────────────────
test("CREATE SIMPLE POOL (EVM lane) — fresh EVM wallet via CPI (THE CRUX)", { skip: !KEY }, async () => {
  const wallet = ethers.Wallet.createRandom();
  const owner = evmPdaFor(wallet.address); // external_auth PDA — the CreatePool payer
  // Fund gas; convert ~0.02 SOL for the account rents the PDA fronts (pool + lp + fee + dest).
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const dep = new ethers.Wallet(KEY.trim(), provider);
  {
    const g = await resolveGas({ from: dep.address, to: wallet.address, data: "0x" });
    const nonce = await provider.getTransactionCount(dep.address, "pending");
    await (await dep.sendTransaction({ to: wallet.address, value: ethers.parseEther("5"), type: 2, nonce, ...g, gasLimit: 30_000_000n })).wait(1);
  }
  const HELPER_IFACE = new ethers.Interface(["function swap_gas_to_lamports(uint64 lamports)"]);
  const g2 = await resolveGas({ from: wallet.address, to: HELPER, data: HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [30_000_000n]) });
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const signed = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g2, to: HELPER, value: 0n, data: HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [30_000_000n]) });
  const sent = await evmRpc("eth_sendRawTransaction", [signed]);
  if (sent.error) throw new Error(JSON.stringify(sent.error).slice(0, 200));
  await provider.waitForTransaction(sent.result, 1, 120000).catch(() => null);

  const s = await setup(owner);
  assert.equal(await conn.getAccountInfo(s.pool), null, "pool brand-new (not yet created)");
  const keys = s.accounts.map(([name, sign, w]) => acc(s.map[name], sign, w));
  const r = await execEvmCpi({ programId: DEX, key: wallet.privateKey, accounts: keys, data: createPoolData(s.poolBump, s.lpBump) });
  assert.ok(r.ok, `EVM-lane CreatePool submitted: ${r.error || ""}`);
  await assertPool(s);
  console.log(`  EVM-lane CREATE SIMPLE POOL (CRUX): fresh wallet ${wallet.address.slice(0, 10)}… made pool ${s.pool.toBase58().slice(0, 8)}… · ${r.legs} legs`);
});
