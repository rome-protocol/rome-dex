// Provision the rome-dex persistent Address Lookup Table (dapp tier).
//
// Covers the FIXED pool accounts of the real USDC/SOL tiered pools so the
// EVM-lane CPI swap tx fits in one atomic leg (near-CU-parity). Per ALT
// hygiene: pool-fixed accounts ONLY — program, token program, the two mints,
// and each pool's swapState/authority/vault/vault/poolMint/feeAccount. NEVER
// user/sender ATAs (those stay dynamic outside the table).
//
// Authority = local deployer 55R41dbR. Writes harness/alt.json. The registry
// (chains/200010-hadrian/alts.json) + proxy persistent_alts config reference
// this table's pubkey; extends read live.

import {
  Connection, Keypair, PublicKey, Transaction, AddressLookupTableProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SOL = "https://api.devnet.solana.com";
const conn = new Connection(SOL, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
const tiers = JSON.parse(fs.readFileSync(path.join(DIR, "pools-real-tiers.json"), "utf8"));
const PK = (s) => new PublicKey(s);

function poolAccounts() {
  const set = new Map(); // dedupe by base58
  const add = (a) => set.set(a, PK(a));
  const t0 = tiers[0];
  add(t0.program); add(TOKEN_PROGRAM_ID.toBase58()); add(t0.mintA); add(t0.mintB);
  for (const t of tiers) {
    for (const k of ["swapState", "authority", "vaultA", "vaultB", "poolMint", "feeAccount"]) add(t[k]);
  }
  return [...set.values()];
}

async function main() {
  const addrs = poolAccounts();
  console.log(`rome-dex ALT: ${addrs.length} fixed pool accounts (${tiers.length} tiers, no user ATAs)`);

  const slot = await conn.getSlot("finalized");
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  console.log("table:", table.toBase58());
  await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [payer], { commitment: "confirmed" });

  // extend in chunks of ≤20 (tx size)
  for (let i = 0; i < addrs.length; i += 20) {
    const chunk = addrs.slice(i, i + 20);
    const ext = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey, authority: payer.publicKey, lookupTable: table, addresses: chunk,
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(ext), [payer], { commitment: "confirmed" });
    console.log(`  extended +${chunk.length} (${Math.min(i + 20, addrs.length)}/${addrs.length})`);
  }

  // verify contents
  const acct = await conn.getAddressLookupTable(table);
  const got = acct.value?.state.addresses.length ?? 0;
  const out = {
    table: table.toBase58(), authority: payer.publicKey.toBase58(), tier: "dapp", dapp: "rome-dex",
    count: got, program: tiers[0].program, addresses: addrs.map((a) => a.toBase58()),
  };
  fs.writeFileSync(path.join(DIR, "alt.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`✅ ALT ${table.toBase58()} has ${got} addresses. wrote alt.json`);
}
main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
