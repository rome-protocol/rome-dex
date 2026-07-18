// farm-evm-setup.test.mjs — the EVM lane's one-time staking setup, proven with
// a FRESH wallet on live Hadrian: warm the external_auth PDA (gas → lamports),
// then InitUserStake via the CPI precompile — the farm program creates the
// UserStake account through its own system CPI and the proxy materialises it.
//
// This capability was long believed impossible ("third-party creates never
// emulate", probe-farm2 era) — a cold PDA fails with Custom(1) (the payer can't
// fund rent), which read as a discovery wall. Measured 2026-07-09: with rent,
// it lands. app/lib/farm.ts stakeLP's EVM path relies on exactly this sequence;
// if the proxy regresses, this test goes red before users do.
//
// Run: HADRIAN_PRIVATE_KEY=<deployer> node --import tsx --test farm-evm-setup.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { ethers } from "ethers";
import { conn, evmPdaFor, EVM_RPC, CHAIN_ID, resolveGas, execEvmCpi } from "./lib.mjs";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const farm = JSON.parse(fs.readFileSync(new URL("./farm.json", import.meta.url), "utf8"));
const FARM_PROG = new PublicKey(farm.farmProgram);
const FARM = new PublicKey(farm.farm);
const HELPER = "0xff00000000000000000000000000000000000009";
const HELPER_IFACE = new ethers.Interface(["function swap_gas_to_lamports(uint64 lamports)"]);

test("EVM one-time staking setup: fresh wallet → rent bootstrap → InitUserStake LANDS", { skip: !KEY }, async () => {
  const wallet = ethers.Wallet.createRandom();
  const owner = evmPdaFor(wallet.address);
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const dep = new ethers.Wallet(KEY.trim(), provider);
  {
    const g = await resolveGas({ from: dep.address, to: wallet.address, data: "0x" });
    const nonce = await provider.getTransactionCount(dep.address, "pending");
    await (await dep.sendTransaction({ to: wallet.address, value: ethers.parseEther("3"), type: 2, nonce, ...g, gasLimit: 30_000_000n })).wait(1);
  }

  // The PDA is cold — mirror the app's bootstrap (farm.ts evmEnsurePdaLamports).
  assert.equal(await conn.getBalance(owner), 0, "fresh external_auth PDA starts cold");
  {
    const data = HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [12_000_000n]);
    const g = await resolveGas({ from: wallet.address, to: HELPER, data });
    const nonce = await provider.getTransactionCount(wallet.address, "pending");
    await (await wallet.connect(provider).sendTransaction({ to: HELPER, data, type: 2, value: 0n, nonce, ...g })).wait(1);
  }
  assert.ok((await conn.getBalance(owner)) >= 12_000_000, "PDA warmed");

  // InitUserStake — account order byte-identical to app/lib/farm.ts.
  const [ustake] = PublicKey.findProgramAddressSync([FARM.toBuffer(), owner.toBuffer()], FARM_PROG);
  const accounts = [
    { pubkey: FARM, isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: ustake, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: true }, // payer = external_auth PDA (auto-signed)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const r = await execEvmCpi({ programId: FARM_PROG, key: wallet.privateKey, accounts, data: Buffer.from([1]) });
  assert.ok(r.ok, `InitUserStake via CPI: ${r.error || ""}`);

  const info = await conn.getAccountInfo(ustake);
  assert.ok(info, "UserStake account exists on-chain");
  assert.ok(info.owner.equals(FARM_PROG), "owned by the farm program");
  assert.equal(info.data[0], 1, "is_initialized");
  console.log(`  EVM one-time staking setup: fresh wallet ${wallet.address.slice(0, 10)}… → UserStake ${ustake.toBase58().slice(0, 8)}… LIVE`);
});
