// Create a SECOND rome-dex pool (B↔C) to prove two things:
//   1. Pool creation is PERMISSIONLESS — a brand-new keypair (no privilege, no
//      allowlist) initializes the pool; Initialize has no authority gate.
//   2. Multi-pool / shared-hub liquidity — token B is the SAME mint as pool1's
//      token B, so B is a routing hub across pools (enables A→B→C).
//
// Liquidity is provided by whoever holds tokens (here the deployer seeds B+C);
// the CREATOR only pays rent + signs Initialize. Writes pool2.json.

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, createAccount, mintTo, transfer, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SOL = "https://api.devnet.solana.com";
const conn = new Connection(SOL, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
const pool1 = JSON.parse(fs.readFileSync(path.join(DIR, "pool.json"), "utf8"));
const PROGRAM = new PublicKey(pool1.program);
const mintB = new PublicKey(pool1.mintB); // shared hub token (9 dp)

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const feesBuf = Buffer.concat([u64(25), u64(10000), u64(5), u64(10000), u64(0), u64(10000), u64(0), u64(10000)]);
const curveBuf = Buffer.concat([Buffer.from([0]), Buffer.alloc(32)]);
const initData = Buffer.concat([Buffer.from([0]), feesBuf, curveBuf]);

async function main() {
  // fresh, unprivileged creator — funded only enough to pay rent for the pool
  const creator = Keypair.generate();
  console.log("creator (fresh, no privilege):", creator.publicKey.toBase58());
  const fund = new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: creator.publicKey, lamports: 2 * LAMPORTS_PER_SOL,
  }));
  await sendAndConfirmTransaction(conn, fund, [payer], { commitment: "confirmed" });

  // token C (deployer controls supply, to seed the pool)
  const mintC = await createMint(conn, payer, payer.publicKey, null, 6);
  console.log(" mintC", mintC.toBase58());

  // pool state + PDA (Initialize signed by the CREATOR)
  const swapState = Keypair.generate();
  const [authority] = PublicKey.findProgramAddressSync([swapState.publicKey.toBuffer()], PROGRAM);

  // vaults owned by the pool authority; creator pays rent
  const vaultB = await createAccount(conn, creator, mintB, authority, Keypair.generate());
  const vaultC = await createAccount(conn, creator, mintC, authority, Keypair.generate());

  // seed liquidity: deployer transfers B, mints C into the vaults
  const payerB = new PublicKey(pool1.payerAtaB);
  await transfer(conn, payer, payerB, vaultB, payer, 50_000_000_000n); // 50 B
  await mintTo(conn, payer, mintC, vaultC, payer, 50_000_000n);        // 50 C

  // LP mint + fee/destination LP accounts (creator owns)
  const poolMint = await createMint(conn, creator, authority, null, 6);
  const feeAcct = await createAccount(conn, creator, poolMint, creator.publicKey, Keypair.generate());
  const destAcct = await createAccount(conn, creator, poolMint, creator.publicKey, Keypair.generate());

  // routing account: deployer's C ATA (receives C at the end of A→B→C)
  const payerC = await getOrCreateAssociatedTokenAccount(conn, payer, mintC, payer.publicKey);

  const stateLen = 324;
  const rent = await conn.getMinimumBalanceForRentExemption(stateLen);
  const createIx = SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: swapState.publicKey, lamports: rent, space: stateLen, programId: PROGRAM });
  const initIx = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: swapState.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: vaultB, isSigner: false, isWritable: false },
      { pubkey: vaultC, isSigner: false, isWritable: false },
      { pubkey: poolMint, isSigner: false, isWritable: true },
      { pubkey: feeAcct, isSigner: false, isWritable: false },
      { pubkey: destAcct, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initData,
  });
  // signed by the fresh creator — no privileged key involved
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(createIx, initIx), [creator, swapState], { commitment: "confirmed" });
  console.log("\n✅ pool2 (B↔C) initialized by a fresh keypair. sig:", sig);

  const pool2 = {
    program: PROGRAM.toBase58(), swapState: swapState.publicKey.toBase58(), authority: authority.toBase58(),
    // program token_a = B (hub), token_b = C
    mintA: mintB.toBase58(), mintB: mintC.toBase58(), vaultA: vaultB.toBase58(), vaultB: vaultC.toBase58(),
    poolMint: poolMint.toBase58(), feeAccount: feeAcct.toBase58(), destination: destAcct.toBase58(),
    payerAtaA: pool1.payerAtaB, payerAtaB: payerC.address.toBase58(),
    creator: creator.publicKey.toBase58(),
  };
  fs.writeFileSync(path.join(DIR, "pool2.json"), JSON.stringify(pool2, null, 2) + "\n");
  console.log("wrote pool2.json:\n", JSON.stringify(pool2, null, 2));
}
main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
