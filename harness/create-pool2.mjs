// Create a SECOND rome-dex pool (B↔C) to prove two things:
//   1. Pool creation is PERMISSIONLESS-CAPABLE — CreatePool (tag 7) has no
//      ephemeral signers, so a brand-new keypair with no prior privilege can
//      create it (subject to the config gate — pool_creation_mode 1,
//      or mode 0 + creator == config.admin).
//   2. Multi-pool / shared-hub liquidity — token B is the SAME mint as pool1's
//      token B, so B is a routing hub across pools (enables A→B→C).
//
// Liquidity is provided by whoever holds tokens (here the deployer seeds B+C);
// the CREATOR only pays rent + signs CreatePool. Writes pool2.json.

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, mintTo, transfer, getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCreatePool, buildCreatePoolIx, feesBufFor } from "./createPoolLib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SOL = "https://api.devnet.solana.com";
const conn = new Connection(SOL, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
const pool1 = JSON.parse(fs.readFileSync(path.join(DIR, "pool.json"), "utf8"));
const PROGRAM = new PublicKey(pool1.program);
const mintB = new PublicKey(pool1.mintB); // shared hub token (9 dp)
const FEE_BPS = 30;
const feesBuf = feesBufFor({ tradeNum: 25n, tradeDen: 10000n, ownerNum: 5n, ownerDen: 10000n });

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

  // resolve every CreatePool PDA (no ephemeral signer)
  const r = resolveCreatePool(PROGRAM, mintB, mintC, FEE_BPS);

  // vaults owned by the pool authority PDA; creator pays rent
  const vaultB = (await getOrCreateAssociatedTokenAccount(conn, creator, mintB, r.authority, true)).address;
  const vaultC = (await getOrCreateAssociatedTokenAccount(conn, creator, mintC, r.authority, true)).address;

  // seed liquidity: deployer transfers B, mints C into the vaults
  const payerB = new PublicKey(pool1.payerAtaB);
  await transfer(conn, payer, payerB, vaultB, payer, 50_000_000_000n); // 50 B
  await mintTo(conn, payer, mintC, vaultC, payer, 50_000_000n);        // 50 C

  // routing account: deployer's C ATA (receives C at the end of A→B→C)
  const payerC = await getOrCreateAssociatedTokenAccount(conn, payer, mintC, payer.publicKey);

  const ix = buildCreatePoolIx({ program: PROGRAM, payer: creator.publicKey, mintA: mintB, mintB: mintC, vaultA: vaultB, vaultB: vaultC, feeBps: FEE_BPS, feesBuf, ...r });
  // signed by the fresh creator — no privileged key involved
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [creator], { commitment: "confirmed" });
  console.log("\n✅ pool2 (B↔C) created by a fresh keypair. sig:", sig);

  const pool2 = {
    program: PROGRAM.toBase58(), swapState: r.pool.toBase58(), authority: r.authority.toBase58(),
    // program token_a = B (hub), token_b = C
    mintA: mintB.toBase58(), mintB: mintC.toBase58(), vaultA: vaultB.toBase58(), vaultB: vaultC.toBase58(),
    poolMint: r.lpMint.toBase58(), destination: r.dest.toBase58(),
    payerAtaA: pool1.payerAtaB, payerAtaB: payerC.address.toBase58(),
    creator: creator.publicKey.toBase58(),
  };
  fs.writeFileSync(path.join(DIR, "pool2.json"), JSON.stringify(pool2, null, 2) + "\n");
  console.log("wrote pool2.json:\n", JSON.stringify(pool2, null, 2));
}
main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
