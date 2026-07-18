// One-time farm setup: create the reward mint (authority = farm PDA), the LP
// vault (owned by the farm PDA), the farm state account, and call InitFarm.
// Writes farm.json for the harness. Idempotent-ish: rerun makes a fresh farm.
//
//   node setup-farm.mjs
//
// Staked mint = the rome-dex USDC/SOL 0.30% pool LP mint.

import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conn, payer, PK } from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

export const FARM_PROGRAM = new PublicKey("AtseC4PTJaXfPbQVqLmcBnv7iGeftJYTzbR1stKE5Hnc");
// rome-dex USDC/SOL 0.30% pool LP mint (from pools-real-tiers.json, tier 0.30%).
const LP_MINT = new PublicKey("2bKxfTBQmq79f7JfX4xpAE1ofzvcB5PTt2J7j7yMKyBj");
const REWARD_DECIMALS = 9;
// Default emission: 1e6 reward base units/sec = 0.001 RDX/sec. Operator-tunable
// on-chain via SetRewardPerSecond (tag 5) by the farm owner.
const REWARD_PER_SECOND = 1_000_000n;
const FARM_LEN = 202;

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

async function main() {
  const farmKp = Keypair.generate();
  const [authority, bump] = PublicKey.findProgramAddressSync(
    [farmKp.publicKey.toBuffer()], FARM_PROGRAM);

  console.log("farm       ", farmKp.publicKey.toBase58());
  console.log("authorityPDA", authority.toBase58(), "bump", bump);

  const rewardMint = await createMint(conn, payer, authority, null, REWARD_DECIMALS);
  console.log("rewardMint ", rewardMint.toBase58());

  const lpVault = (await getOrCreateAssociatedTokenAccount(
    conn, payer, LP_MINT, authority, true)).address;
  console.log("lpVault    ", lpVault.toBase58());

  const rent = await conn.getMinimumBalanceForRentExemption(FARM_LEN);
  const create = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: farmKp.publicKey,
    lamports: rent,
    space: FARM_LEN,
    programId: FARM_PROGRAM,
  });
  const initData = Buffer.concat([Buffer.from([0]), u64(REWARD_PER_SECOND)]);
  const initAccounts = [
    [farmKp.publicKey, 0, 1], [authority, 0, 0], [LP_MINT, 0, 0],
    [rewardMint, 0, 0], [lpVault, 0, 0], [payer.publicKey, 0, 0],
    [TOKEN_PROGRAM_ID, 0, 0],
  ].map(([k, s, w]) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w }));
  const init = new TransactionInstruction({ programId: FARM_PROGRAM, keys: initAccounts, data: initData });

  const sig = await sendAndConfirmTransaction(
    conn, new Transaction().add(create).add(init), [payer, farmKp], { commitment: "confirmed" });
  console.log("initFarm sig", sig);

  const out = {
    farmProgram: FARM_PROGRAM.toBase58(),
    farm: farmKp.publicKey.toBase58(),
    authority: authority.toBase58(),
    bump,
    lpMint: LP_MINT.toBase58(),
    rewardMint: rewardMint.toBase58(),
    rewardDecimals: REWARD_DECIMALS,
    lpVault: lpVault.toBase58(),
    owner: payer.publicKey.toBase58(),
    rewardPerSecond: REWARD_PER_SECOND.toString(),
  };
  fs.writeFileSync(path.join(DIR, "farm.json"), JSON.stringify(out, null, 2));
  console.log("wrote farm.json");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
