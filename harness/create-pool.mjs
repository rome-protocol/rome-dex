// Create a rome-dex pool on the deployed program (P1 prerequisite).
// CreatePool (tag 7): no ephemeral signers — the program creates the pool
// state PDA, LP mint PDA, and destination-LP PDA internally (invoke_signed).
// v2 has no dedicated fee-LP account; the config PDA is CreatePool's
// gate account (must be initialized on-chain first — see InitializeConfig).
// Uses the local Solana keypair (55R41dbR) as payer. Writes pool addresses to pool.json.

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCreatePool, buildCreatePoolIx, feesBufFor } from "./createPoolLib.mjs";
const DIR = path.dirname(fileURLToPath(import.meta.url));

const RPC = "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("Fv2LgkewH9114T6Gg99ERq8TxMVj2MGPRC73dJ4AKb1A");
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
console.log("payer:", payer.publicKey.toBase58());

const FEE_BPS = 30; // 0.30% tier
const feesBuf = feesBufFor({ tradeNum: 25n, tradeDen: 10000n, ownerNum: 5n, ownerDen: 10000n });

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

  // 2) resolve every CreatePool PDA (no ephemeral signer)
  const r = resolveCreatePool(PROGRAM, mintA, mintB, FEE_BPS);
  console.log(" swapState", r.pool.toBase58(), "authority", r.authority.toBase58());

  // 3) vaults (authority PDA's ATAs) — the caller pre-creates + funds them.
  const vaultA = (await getOrCreateAssociatedTokenAccount(conn, payer, mintA, r.authority, true)).address;
  const vaultB = (await getOrCreateAssociatedTokenAccount(conn, payer, mintB, r.authority, true)).address;
  await mintTo(conn, payer, mintA, vaultA, payer, 100_000_000n);       // 100 A
  await mintTo(conn, payer, mintB, vaultB, payer, 100_000_000_000n);   // 100 B
  console.log(" vaultA", vaultA.toBase58(), "vaultB", vaultB.toBase58());
  console.log(" poolMint", r.lpMint.toBase58());

  // 4) CreatePool — 12 accounts, config PDA appended (config gate).
  const ix = buildCreatePoolIx({ program: PROGRAM, payer: payer.publicKey, mintA, mintB, vaultA, vaultB, feeBps: FEE_BPS, feesBuf, ...r });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  console.log("\n✅ pool created. sig:", sig);

  const pool = {
    program: PROGRAM.toBase58(), swapState: r.pool.toBase58(), authority: r.authority.toBase58(),
    mintA: mintA.toBase58(), mintB: mintB.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(),
    poolMint: r.lpMint.toBase58(), destination: r.dest.toBase58(),
    payerAtaA: payerA.address.toBase58(), payerAtaB: payerB.address.toBase58(),
  };
  fs.writeFileSync(path.join(DIR, "pool.json"), JSON.stringify(pool, null, 2) + "\n");
  console.log("wrote pool.json:\n", JSON.stringify(pool, null, 2));
}
main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
