// CLMM ⑤c — EVM-lane brand-new-wallet proof. A FRESH EVM keypair (never seen)
// funded with TINY value drives the FULL concentrated-position journey entirely
// from the EVM lane via the CPI precompile: OpenPosition (payer = the EOA's
// external_auth PDA, bootstrapped from gas via swap_gas_to_lamports) →
// IncreaseLiquidity → Collect → DecreaseLiquidity → ClosePosition. Rome
// auto-signs the PDA as owner+payer. This proves the ⑤c prerequisite that the
// harness's prior EVM-lane test left open (it opened via the local Solana payer).
//
// Run: HADRIAN_PRIVATE_KEY=<deployer> node --test clmm-evm.test.mjs
//   deployer funds the fresh EOA's gas + mints tiny test tokens to its PDA ATAs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { ethers } from "ethers";
import {
  conn, payer, PK, bal, execEvmCpi, evmPdaFor, EVM_RPC, CHAIN_ID, b32, resolveGas, evmRpc,
} from "./lib.mjs";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const SKIP = KEY ? false : "no HADRIAN_PRIVATE_KEY";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(fs.readFileSync(path.join(DIR, "clmm.json"), "utf8"));
const CLMM = new PublicKey(C.program);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = SystemProgram.programId;
const HELPER = "0xFF00000000000000000000000000000000000009";
const MINT0 = new PublicKey(C.mint0), MINT1 = new PublicKey(C.mint1);
const VAULT0 = new PublicKey(C.vault0), VAULT1 = new PublicKey(C.vault1);
const LOWER = C.positionLower, UPPER = C.positionUpper; // [-1280, 1280]

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u128 = (v) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(BigInt(v) >> 64n, 8); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const openData = (l, u, bump) => Buffer.concat([Buffer.from([2]), i32(l), i32(u), Buffer.from([bump])]);
const incData = (liq, m0, m1) => Buffer.concat([Buffer.from([3]), u128(liq), u64(m0), u64(m1)]);
const decData = (liq, m0, m1) => Buffer.concat([Buffer.from([4]), u128(liq), u64(m0), u64(m1)]);
const collectData = () => Buffer.from([5]);
const closeData = () => Buffer.from([6]);

const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const positionPda = (owner, lo, up) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), PK(C.pool).toBuffer(), PK(owner).toBuffer(), i32(lo), i32(up)], CLMM);
const taFor = (tick) => {
  const span = 88 * C.tickSpacing;
  return new PublicKey(C.tickArrays[String(Math.floor(tick / span) * span)]);
};

// HELPER precompile call from the FRESH EOA (bootstrap PDA lamports from gas).
async function evmHelper(fn, args, key) {
  const iface = new ethers.Interface(["function swap_gas_to_lamports(uint64 lamports)", "function create_ata(address user, bytes32 mint)"]);
  const data = iface.encodeFunctionData(fn, args);
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const w = new ethers.Wallet(key.trim(), provider);
  const nonce = await provider.getTransactionCount(w.address, "pending");
  const g = await resolveGas({ from: w.address, to: HELPER, data });
  const signed = await w.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g, to: HELPER, value: 0n, data });
  const send = await evmRpc("eth_sendRawTransaction", [signed]);
  if (send.error) throw new Error(JSON.stringify(send.error).slice(0, 200));
  await provider.waitForTransaction(send.result, 1, 120000).catch(() => null);
}

const F = {};

test("setup: FRESH EVM wallet funded with tiny value; PDA ATAs seeded", { skip: SKIP }, async () => {
  F.wallet = ethers.Wallet.createRandom();
  F.eoa = F.wallet.address;
  F.owner = evmPdaFor(F.eoa); // the fresh EOA's external_auth PDA (position owner)
  console.log(`  fresh EVM wallet ${F.eoa} · PDA ${F.owner.toBase58()}`);

  // 1) TINY gas to the fresh EOA (native transfer from the deployer).
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const dep = new ethers.Wallet(KEY.trim(), provider);
  const GAS_WEI = ethers.parseEther("0.2"); // generous for ~6 CPI txs; still tiny
  const g = await resolveGas({ from: dep.address, to: F.eoa, data: "0x" });
  const nonce = await provider.getTransactionCount(dep.address, "pending");
  const tx = await dep.sendTransaction({ to: F.eoa, value: GAS_WEI, type: 2, nonce, maxFeePerGas: g.maxFeePerGas, maxPriorityFeePerGas: g.maxPriorityFeePerGas, gasLimit: 30_000_000n });
  await tx.wait(1);

  // 2) The fresh PDA's token ATAs + tiny test-token balances (deployer mints).
  F.ata0 = getAssociatedTokenAddressSync(MINT0, F.owner, true);
  F.ata1 = getAssociatedTokenAddressSync(MINT1, F.owner, true);
  await getOrCreateAssociatedTokenAccount(conn, payer, MINT0, F.owner, true);
  await getOrCreateAssociatedTokenAccount(conn, payer, MINT1, F.owner, true);
  await mintTo(conn, payer, MINT0, F.ata0, payer, 5_000_000n); // 5.0 test units
  await mintTo(conn, payer, MINT1, F.ata1, payer, 5_000_000n);
  assert.ok((await bal(F.ata0)) >= 5_000_000n, "fresh PDA holds tiny token0");
});

test("EVM lane: OpenPosition via CPI — PDA is payer, bootstrapped from gas (THE ⑤c crux)", { skip: SKIP }, async () => {
  // Bootstrap the cold PDA's SOL so it can pay the position-account rent.
  await evmHelper("swap_gas_to_lamports", [10_000_000n], F.wallet.privateKey);
  const pdaLamports = BigInt(await conn.getBalance(F.owner));
  assert.ok(pdaLamports > 0n, `PDA bootstrapped with rent SOL (got ${pdaLamports})`);

  const [pos, bump] = positionPda(F.owner, LOWER, UPPER);
  F.position = pos;
  const r = await execEvmCpi({
    programId: CLMM,
    key: F.wallet.privateKey,
    accounts: [acc(C.pool, 0, 0), acc(pos, 0, 1), acc(F.owner, 1, 0), acc(F.owner, 1, 1), acc(SYSTEM, 0, 0)],
    data: openData(LOWER, UPPER, bump),
  });
  assert.ok(r.ok, `evm OpenPosition ok: ${r.error || ""}`);
  assert.ok(await conn.getAccountInfo(pos), "position PDA created from the EVM lane");
  console.log(`  EVM-lane OpenPosition: ${r.legs} legs, maxCu ${r.maxCu}`);
});

test("EVM lane: IncreaseLiquidity via CPI (PDA auto-signed owner)", { skip: SKIP }, async () => {
  const liq = [
    acc(C.pool, 0, 1), acc(F.position, 0, 1), acc(F.owner, 1, 0),
    acc(F.ata0, 0, 1), acc(F.ata1, 0, 1), acc(VAULT0, 0, 1), acc(VAULT1, 0, 1),
    acc(TOKEN, 0, 0), acc(taFor(LOWER), 0, 1), acc(taFor(UPPER), 0, 1),
  ];
  const r = await execEvmCpi({ programId: CLMM, key: F.wallet.privateKey, accounts: liq, data: incData(50_000_000n, 5_000_000n, 5_000_000n) });
  assert.ok(r.ok, `evm increase ok: ${r.error || ""}`);
  const [pos] = positionPda(F.owner, LOWER, UPPER);
  assert.ok(await conn.getAccountInfo(pos), "position live after increase");
  console.log(`  EVM-lane IncreaseLiquidity: ${r.legs} legs, maxCu ${r.maxCu}`);
});

test("EVM lane: DecreaseLiquidity + Collect + ClosePosition via CPI (full teardown)", { skip: SKIP }, async () => {
  const liq = [
    acc(C.pool, 0, 1), acc(F.position, 0, 1), acc(F.owner, 1, 0),
    acc(F.ata0, 0, 1), acc(F.ata1, 0, 1), acc(VAULT0, 0, 1), acc(VAULT1, 0, 1),
    acc(TOKEN, 0, 0), acc(taFor(LOWER), 0, 1), acc(taFor(UPPER), 0, 1),
  ];
  const before0 = await bal(F.ata0);
  const dec = await execEvmCpi({ programId: CLMM, key: F.wallet.privateKey, accounts: liq, data: decData(50_000_000n, 1n, 1n) });
  assert.ok(dec.ok, `evm decrease ok: ${dec.error || ""}`);
  assert.ok((await bal(F.ata0)) > before0, "principal returned to the fresh PDA's ATA");

  const col = await execEvmCpi({
    programId: CLMM, key: F.wallet.privateKey,
    accounts: [acc(C.pool, 0, 0), acc(F.position, 0, 1), acc(F.owner, 1, 0), acc(F.ata0, 0, 1), acc(F.ata1, 0, 1), acc(VAULT0, 0, 1), acc(VAULT1, 0, 1), acc(TOKEN, 0, 0)],
    data: collectData(),
  });
  assert.ok(col.ok, `evm collect ok: ${col.error || ""}`);

  const close = await execEvmCpi({
    programId: CLMM, key: F.wallet.privateKey,
    accounts: [acc(F.position, 0, 1), acc(F.owner, 1, 1)],
    data: closeData(),
  });
  assert.ok(close.ok, `evm close ok: ${close.error || ""}`);
  assert.equal(await conn.getAccountInfo(F.position), null, "position reclaimed from the EVM lane");
  console.log("  EVM-lane brand-new wallet: full open→increase→decrease→collect→close OK");
});
