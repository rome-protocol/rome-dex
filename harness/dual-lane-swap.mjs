// P1 dual-lane parity proof: swap A->B into the SAME rome-dex pool from BOTH lanes, measure CU.
//   Solana lane: local keypair (55R41dbR) calls rome-dex Swap directly.
//   EVM lane:    EVM deployer (0x1f4946Be) calls CPI precompile 0xFF..08 -> rome-dex Swap, with
//                external_auth(EOA) PDA as the user_transfer_authority (Rome auto-signs). Closes the
//                open caveat: EVM-lane PDA signing flows through the CPI precompile.

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ethers } from "ethers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url));

const SOL = "https://api.devnet.solana.com";
const EVM_RPC = "https://hadrian-lt.testnet.romeprotocol.xyz/";
const CHAIN_ID = 200010n, GAS_PRICE = 11_000_000_000n;
const CPI = "0xFF00000000000000000000000000000000000008";
const ROME_EVM_PROGRAM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
const EVM_DEPLOYER = "0x1f4946Be340F06c46A50E65084790968aBcc48F6";
const ASSOCIATED_TOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const pool = JSON.parse(fs.readFileSync(path.join(DIR, "pool.json"), "utf8"));
const PK = (s) => new PublicKey(s);
const conn = new Connection(SOL, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const swapData = (amtIn, minOut) => Buffer.concat([Buffer.from([1]), u64(amtIn), u64(minOut)]);

// Authority-agnostic Swap account list (A->B). authority is the sole signer (idx 2).
function swapAccounts(authority, srcAta, dstAta) {
  return [
    { pubkey: PK(pool.swapState), isSigner: false, isWritable: false },
    { pubkey: PK(pool.authority), isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: srcAta, isSigner: false, isWritable: true },
    { pubkey: PK(pool.vaultA), isSigner: false, isWritable: true },
    { pubkey: PK(pool.vaultB), isSigner: false, isWritable: true },
    { pubkey: dstAta, isSigner: false, isWritable: true },
    { pubkey: PK(pool.poolMint), isSigner: false, isWritable: true },
    { pubkey: PK(pool.feeAccount), isSigner: false, isWritable: true },
    { pubkey: PK(pool.mintA), isSigner: false, isWritable: false },
    { pubkey: PK(pool.mintB), isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}
const solRpc = async (m, p) => (await (await fetch(SOL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json());
async function cuOfSig(sig) { for (const d of [500, 2000, 3000, 4500]) { await new Promise(r => setTimeout(r, d)); const t = await solRpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }]); if (t.result) return t.result.meta?.computeUnitsConsumed ?? 0; } return null; }
const AMT = 10_000_000n; // 10 A (6dp)

async function main() {
  // ---------- Solana lane ----------
  const srcSol = PK(pool.payerAtaA), dstSol = PK(pool.payerAtaB);
  const dstBefore = (await getAccount(conn, dstSol)).amount;
  const ix = new TransactionInstruction({ programId: PK(pool.program), keys: swapAccounts(payer.publicKey, srcSol, dstSol), data: swapData(AMT, 0n) });
  const solSig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  const dstAfter = (await getAccount(conn, dstSol)).amount;
  const solCU = await cuOfSig(solSig);
  console.log(`\n[Solana lane] swap 10 A -> B  status=ok  Bout=${dstAfter - dstBefore}  CU=${solCU}  sig=${solSig.slice(0, 16)}…`);

  // ---------- EVM lane ----------
  const key = process.env.HADRIAN_PRIVATE_KEY;
  if (!key) { console.error("HADRIAN_PRIVATE_KEY not set for EVM lane"); process.exit(1); }
  const evmPda = PublicKey.findProgramAddressSync([Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(EVM_DEPLOYER.slice(2), "hex")], ROME_EVM_PROGRAM)[0];
  // EVM user's ATAs (owned by its Rome PDA) — create + fund A
  const evmAtaA = await getOrCreateAssociatedTokenAccount(conn, payer, PK(pool.mintA), evmPda, true);
  const evmAtaB = await getOrCreateAssociatedTokenAccount(conn, payer, PK(pool.mintB), evmPda, true);
  await mintTo(conn, payer, PK(pool.mintA), evmAtaA.address, payer, 50_000_000n); // fund 50 A
  console.log(`[EVM lane] evmPda=${evmPda.toBase58()} srcAtaA=${evmAtaA.address.toBase58()}`);

  // encode Swap as CPI.invoke calldata; authority = evmPda (Rome auto-signs external_auth(caller=EOA))
  const b32 = (pk) => "0x" + Buffer.from(pk.toBuffer()).toString("hex");
  const accs = swapAccounts(evmPda, evmAtaA.address, evmAtaB.address).map(a => [b32(a.pubkey), a.isSigner, a.isWritable]);
  const iface = new ethers.Interface(["function invoke(bytes32 program, (bytes32,bool,bool)[] accounts, bytes data)"]);
  const calldata = iface.encodeFunctionData("invoke", [b32(PK(pool.program)), accs, "0x" + swapData(AMT, 0n).toString("hex")]);
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const w = new ethers.Wallet(key.trim(), provider);
  const bBefore = (await getAccount(conn, evmAtaB.address)).amount;
  const nonce = await provider.getTransactionCount(w.address, "pending");
  const signed = await w.signTransaction({ type: 0, chainId: CHAIN_ID, nonce, gasPrice: GAS_PRICE, gasLimit: 300_000_000n, to: CPI, value: 0n, data: calldata });
  const send = await (await fetch(EVM_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signed] }) })).json();
  if (send.error) { console.error("[EVM lane] send error:", JSON.stringify(send.error).slice(0, 220)); process.exit(1); }
  await provider.waitForTransaction(send.result, 1, 120000).catch(() => null);
  const bAfter = (await getAccount(conn, evmAtaB.address)).amount;
  const sigs = (await (await fetch(EVM_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rome_solanaTxForEvmTx", params: [send.result] }) })).json()).result || [];
  let evmCU = 0, mx = 0; for (const s of sigs) { const c = await cuOfSig(s); if (c) { evmCU += c; mx = Math.max(mx, c); } }
  console.log(`[EVM lane] swap 10 A -> B via CPI  status=ok  Bout=${bAfter - bBefore}  legs=${sigs.length} totalCU=${evmCU} maxLeg=${mx}  tx=${send.result.slice(0, 16)}…`);

  console.log(`\n=== DUAL-LANE PARITY (same pool ${pool.swapState.slice(0, 8)}…) ===`);
  console.log(`  Solana lane: ${solCU} CU   |   EVM lane: ${mx || evmCU} CU (exec leg)   |   ratio ${((mx || evmCU) / solCU).toFixed(2)}×`);
  console.log(`  both swapped A->B into the SAME pool → dual-lane parity ${(bAfter - bBefore) > 0n && (dstAfter - dstBefore) > 0n ? "✅ PROVEN" : "⚠️ check"}`);
}
main().catch((e) => { console.error("FAILED:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
