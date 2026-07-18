// Create a rome-dex pool on the deployed program (P1 prerequisite).
// Hand-rolled against the v3 Initialize layout: 8 accounts + [0]+Fees(64)+SwapCurve(33).
// Uses the local Solana keypair (55R41dbR) as payer. Writes pool addresses to pool.json.

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, createAccount, transfer, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url));

const RPC = "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("Fv2LgkewH9114T6Gg99ERq8TxMVj2MGPRC73dJ4AKb1A");
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
console.log("payer:", payer.publicKey.toBase58());

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
// Fees: trade 25/10000, owner_trade 5/10000, owner_withdraw 0/10000, host 0/10000 (denoms nonzero to pass validate)
const feesBuf = Buffer.concat([u64(25), u64(10000), u64(5), u64(10000), u64(0), u64(10000), u64(0), u64(10000)]);
// SwapCurve: curve_type 0 (ConstantProduct) + 32 empty calculator bytes
const curveBuf = Buffer.concat([Buffer.from([0]), Buffer.alloc(32)]);
const initData = Buffer.concat([Buffer.from([0]), feesBuf, curveBuf]); // 1+64+33 = 98

async function main() {
  // 1) two test mints + fund payer
  console.log("creating mints...");
  const mintA = await createMint(conn, payer, payer.publicKey, null, 6);
  const mintB = await createMint(conn, payer, payer.publicKey, null, 9);
  const payerA = await getOrCreateAssociatedTokenAccount(conn, payer, mintA, payer.publicKey);
  const payerB = await getOrCreateAssociatedTokenAccount(conn, payer, mintB, payer.publicKey);
  await mintTo(conn, payer, mintA, payerA.address, payer, 1_000_000_000n);       // 1000 A (6dp)
  await mintTo(conn, payer, mintB, payerB.address, payer, 1_000_000_000_000n);   // 1000 B (9dp)
  console.log(" mintA", mintA.toBase58(), "mintB", mintB.toBase58());

  // 2) swap state keypair + authority PDA
  const swapState = Keypair.generate();
  const [authority] = PublicKey.findProgramAddressSync([swapState.publicKey.toBuffer()], PROGRAM);
  console.log(" swapState", swapState.publicKey.toBase58(), "authority", authority.toBase58());

  // 3) vaults (token accounts owned by authority PDA) + fund with initial liquidity
  const vaultA = await createAccount(conn, payer, mintA, authority, Keypair.generate());
  const vaultB = await createAccount(conn, payer, mintB, authority, Keypair.generate());
  await transfer(conn, payer, payerA.address, vaultA, payer, 100_000_000n);       // 100 A
  await transfer(conn, payer, payerB.address, vaultB, payer, 100_000_000_000n);   // 100 B
  console.log(" vaultA", vaultA.toBase58(), "vaultB", vaultB.toBase58());

  // 4) LP mint (authority = PDA), fee + destination LP accounts (owned by payer)
  const poolMint = await createMint(conn, payer, authority, null, 6);
  const feeAcct = await createAccount(conn, payer, poolMint, payer.publicKey, Keypair.generate());
  const destAcct = await createAccount(conn, payer, poolMint, payer.publicKey, Keypair.generate());
  console.log(" poolMint", poolMint.toBase58());

  // 5) create swap state account (owner=PROGRAM) + initialize, one tx
  const stateLen = 324;
  const rent = await conn.getMinimumBalanceForRentExemption(stateLen);
  const createIx = SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: swapState.publicKey, lamports: rent, space: stateLen, programId: PROGRAM });
  const initIx = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: swapState.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: vaultA, isSigner: false, isWritable: false },
      { pubkey: vaultB, isSigner: false, isWritable: false },
      { pubkey: poolMint, isSigner: false, isWritable: true },
      { pubkey: feeAcct, isSigner: false, isWritable: false },
      { pubkey: destAcct, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initData,
  });
  const tx = new Transaction().add(createIx, initIx);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, swapState], { commitment: "confirmed" });
  console.log("\n✅ pool initialized. sig:", sig);

  const pool = {
    program: PROGRAM.toBase58(), swapState: swapState.publicKey.toBase58(), authority: authority.toBase58(),
    mintA: mintA.toBase58(), mintB: mintB.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(),
    poolMint: poolMint.toBase58(), feeAccount: feeAcct.toBase58(), destination: destAcct.toBase58(),
    payerAtaA: payerA.address.toBase58(), payerAtaB: payerB.address.toBase58(),
  };
  fs.writeFileSync(path.join(DIR, "pool.json"), JSON.stringify(pool, null, 2) + "\n");
  console.log("wrote pool.json:\n", JSON.stringify(pool, null, 2));
}
main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
