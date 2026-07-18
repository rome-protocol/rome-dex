// rome-dex reusable dual-lane test harness.
//
// One module that drives EVERY rome-dex instruction on BOTH lanes into the same
// live pool, and reports CU per lane:
//   • Solana lane — a local keypair signs the instruction directly.
//   • EVM lane     — an EVM EOA calls the CPI precompile 0xFF..08, and Rome
//                    auto-signs with the caller's external_auth PDA (the
//                    authority-agnostic seam that makes parity work).
//
// Import this from harness scripts and from the node:test suite (dex.test.mjs).
// Chain/pool constants live here; nothing is hardcoded in the tests.

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, getAccount, getMint, mintTo, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ethers } from "ethers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- chain constants (Hadrian devnet substrate) ----
export const SOL_RPC = "https://api.devnet.solana.com";
// Default = hadrian-lt (iterative-by-design; multi-leg expected). Override with
// EVM_RPC=https://hadrian.testnet.romeprotocol.xyz/ to hit the ATOMIC proxy —
// the one whose persistent-ALT cover set includes the rome-dex table (leg-collapse
// measurements must target it).
export const EVM_RPC = process.env.EVM_RPC || "https://hadrian-lt.testnet.romeprotocol.xyz/";
export const CHAIN_ID = 200010n;
export const GAS_CEILING = 300_000_000n;   // fallback gasLimit if estimate errors
export const BASE_FEE_FLOOR = 1_000n;      // wei — keeps maxFee > 0 on idle devnet
export const CPI = "0xFF00000000000000000000000000000000000008";
export const ROME_EVM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
export const EVM_DEPLOYER = "0x1f4946Be340F06c46A50E65084790968aBcc48F6";

export const pool = JSON.parse(fs.readFileSync(path.join(DIR, "pool.json"), "utf8"));
// Fee-tier pools of the same A/B pair (Phase 3). Present only after
// create-tiered-pools.mjs has run; the tiers suite skips otherwise.
export const tiersPath = path.join(DIR, "pools-tiers.json");
export const tiers = fs.existsSync(tiersPath)
  ? JSON.parse(fs.readFileSync(tiersPath, "utf8"))
  : null;
export const PK = (s) => (s instanceof PublicKey ? s : new PublicKey(s));
export const conn = new Connection(SOL_RPC, "confirmed");
export const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))),
);
const T = TOKEN_PROGRAM_ID;

// ---- instruction-data encoders (tags match SwapInstruction::pack) ----
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
export const swapData = (amtIn, minOut) => Buffer.concat([Buffer.from([1]), u64(amtIn), u64(minOut)]);
export const depositData = (lp, maxA, maxB) => Buffer.concat([Buffer.from([2]), u64(lp), u64(maxA), u64(maxB)]);
export const withdrawData = (lp, minA, minB) => Buffer.concat([Buffer.from([3]), u64(lp), u64(minA), u64(minB)]);
export const swapExactOutData = (amtOut, maxIn) => Buffer.concat([Buffer.from([6]), u64(amtOut), u64(maxIn)]);

// ---- account builders (authority-agnostic: idx 2 is the sole signer) ----

// Swap / SwapExactOut share the same 14-account layout. `dir` picks vault +
// mint ordering; `authority` is a Solana pubkey OR an EVM external_auth PDA.
// `p` is any pool object (defaults to the primary pool) — pass pool2 to route.
export function swapAccountsFor(p, dir, authority, srcAta, dstAta) {
  const [srcVault, dstVault, srcMint, dstMint] = dir === "AtoB"
    ? [p.vaultA, p.vaultB, p.mintA, p.mintB]
    : [p.vaultB, p.vaultA, p.mintB, p.mintA];
  return [
    [p.swapState, 0, 0], [p.authority, 0, 0], [authority, 1, 0],
    [srcAta, 0, 1], [srcVault, 0, 1], [dstVault, 0, 1], [dstAta, 0, 1],
    [p.poolMint, 0, 1], [p.feeAccount, 0, 1],
    [srcMint, 0, 0], [dstMint, 0, 0], [T, 0, 0], [T, 0, 0], [T, 0, 0],
  ].map(([k, s, w]) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w }));
}
export const swapAccounts = (dir, authority, srcAta, dstAta) =>
  swapAccountsFor(pool, dir, authority, srcAta, dstAta);

// Send N instructions in ONE Solana tx (atomic multi-leg route).
export async function execSolanaMulti(ixSpecs, signer = payer) {
  const tx = new Transaction();
  for (const { accounts, data } of ixSpecs)
    tx.add(new TransactionInstruction({ programId: PK(pool.program), keys: accounts, data }));
  const sig = await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
  return { ok: true, sig, cu: await cuOfSig(sig) };
}

export function depositAccounts(authority, uA, uB, uLp) {
  return [
    [pool.swapState, 0, 0], [pool.authority, 0, 0], [authority, 1, 0],
    [uA, 0, 1], [uB, 0, 1], [pool.vaultA, 0, 1], [pool.vaultB, 0, 1],
    [pool.poolMint, 0, 1], [uLp, 0, 1], [pool.mintA, 0, 0], [pool.mintB, 0, 0],
    [T, 0, 0], [T, 0, 0], [T, 0, 0],
  ].map(([p, s, w]) => ({ pubkey: PK(p), isSigner: !!s, isWritable: !!w }));
}

export function withdrawAccounts(authority, uLp, uA, uB) {
  return [
    [pool.swapState, 0, 0], [pool.authority, 0, 0], [authority, 1, 0],
    [pool.poolMint, 0, 1], [uLp, 0, 1], [pool.vaultA, 0, 1], [pool.vaultB, 0, 1],
    [uA, 0, 1], [uB, 0, 1], [pool.feeAccount, 0, 1], [pool.mintA, 0, 0], [pool.mintB, 0, 0],
    [T, 0, 0], [T, 0, 0], [T, 0, 0],
  ].map(([p, s, w]) => ({ pubkey: PK(p), isSigner: !!s, isWritable: !!w }));
}

// ---- RPC + CU helpers ----
export const solRpc = async (m, p) =>
  (await (await fetch(SOL_RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json());
export const evmRpc = async (m, p) =>
  (await (await fetch(EVM_RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json());

export async function cuOfSig(sig) {
  for (const d of [500, 2000, 3000, 4500, 6000]) {
    await new Promise((r) => setTimeout(r, d));
    const t = await solRpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }]);
    if (t.result) return t.result.meta?.computeUnitsConsumed ?? 0;
  }
  return null;
}

export const bal = async (a) => { try { return (await getAccount(conn, PK(a))).amount; } catch { return 0n; } };
export const lpSupply = async () => (await getMint(conn, PK(pool.poolMint))).supply;
export const reserves = async () => ({ a: await bal(pool.vaultA), b: await bal(pool.vaultB) });
// Reserves of an arbitrary pool object (any fee tier).
export const reservesOf = async (p) => ({ a: await bal(p.vaultA), b: await bal(p.vaultB) });
// The `fees` struct (BigInt) for a tier entry from pools-tiers.json.
export const tierFees = (t) => ({
  tradeNum: BigInt(t.feeTradeNum), tradeDen: BigInt(t.feeTradeDen),
  ownerNum: BigInt(t.feeOwnerNum), ownerDen: BigInt(t.feeOwnerDen),
});
export const evmPdaFor = (eoa) =>
  PublicKey.findProgramAddressSync([Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(eoa.slice(2), "hex")], ROME_EVM)[0];

export async function ensureAta(mint, owner, allowOwnerOffCurve = false) {
  return (await getOrCreateAssociatedTokenAccount(conn, payer, PK(mint), PK(owner), allowOwnerOffCurve)).address;
}
export async function mintIfLow(mint, ata, min, top) {
  if ((await bal(ata)) < BigInt(min)) await mintTo(conn, payer, PK(mint), PK(ata), payer, BigInt(top));
}

// ---- lane executors ----

// Solana lane: sign+send an instruction directly with `signer` (default payer).
// `programId` defaults to the DEX program; farm/other callers override it.
export async function execSolana({ accounts, data, signer = payer, programId = pool.program, extraSigners = [] }) {
  const ix = new TransactionInstruction({ programId: PK(programId), keys: accounts, data });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer, ...extraSigners], { commitment: "confirmed" });
  return { ok: true, sig, cu: await cuOfSig(sig) };
}

// EVM lane: wrap the same instruction as a CPI.invoke and submit via MetaMask-style
// raw tx. `authority` inside `accounts` must be the EOA's external_auth PDA so Rome
// auto-signs. Returns per-leg CU (maxCu is the true single-pass exec cost).
export const b32 = (pk) => "0x" + Buffer.from(PK(pk).toBuffer()).toString("hex");
const cpiIface = new ethers.Interface(["function invoke(bytes32 program,(bytes32,bool,bool)[] accounts,bytes data)"]);

// Resolve EIP-1559 (type-2) fee fields + gasLimit for a Rome CPI tx (mirrors
// app/lib/gas.ts): gasLimit = eth_estimateGas(realTx)×1.3 (ceiling 300M only on
// estimate error); maxPriorityFeePerGas = eth_maxPriorityFeePerGas (idle=0, or a
// user tip in gwei); maxFeePerGas = baseFee×2 + priority (baseFee from latest
// block, falling back to feeHistory tail, floored so maxFee is never 0).
export async function resolveGas({ from, to, data, priorityFeeGwei }) {
  let baseFee = 0n;
  try {
    const blk = await evmRpc("eth_getBlockByNumber", ["latest", false]);
    const bf = blk.result?.baseFeePerGas;
    if (typeof bf === "string") baseFee = BigInt(bf);
  } catch { /* fall through */ }
  if (baseFee === 0n) {
    try {
      const fh = await evmRpc("eth_feeHistory", ["0x5", "latest", [50]]);
      const arr = fh.result?.baseFeePerGas;
      if (Array.isArray(arr) && arr.length) baseFee = BigInt(arr[arr.length - 1]);
    } catch { /* fall through */ }
  }
  if (baseFee === 0n) baseFee = BASE_FEE_FLOOR;

  let maxPriorityFeePerGas = 0n;
  if (priorityFeeGwei != null && priorityFeeGwei >= 0) {
    maxPriorityFeePerGas = BigInt(Math.round(priorityFeeGwei * 1e9));
  } else {
    try {
      const p = await evmRpc("eth_maxPriorityFeePerGas", []);
      if (typeof p.result === "string") maxPriorityFeePerGas = BigInt(p.result);
    } catch { /* keep 0 */ }
  }
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

  let gasLimit = GAS_CEILING;
  try {
    const est = await evmRpc("eth_estimateGas", [{ from, to, data, value: "0x0" }]);
    if (!est.error && typeof est.result === "string") {
      const scaled = (BigInt(est.result) * 13n) / 10n;
      gasLimit = scaled > GAS_CEILING ? GAS_CEILING : scaled;
    }
  } catch { /* keep ceiling fallback */ }
  return { maxFeePerGas, maxPriorityFeePerGas, gasLimit };
}

export async function execEvmCpi({ accounts, data, key, priorityFeeGwei, programId = pool.program }) {
  if (!key) throw new Error("execEvmCpi: HADRIAN_PRIVATE_KEY required");
  const accs = accounts.map((a) => [b32(a.pubkey), a.isSigner, a.isWritable]);
  const calldata = cpiIface.encodeFunctionData("invoke", [b32(programId), accs, "0x" + data.toString("hex")]);
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const w = new ethers.Wallet(key.trim(), provider);
  const nonce = await provider.getTransactionCount(w.address, "pending");
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit } = await resolveGas({ from: w.address, to: CPI, data: calldata, priorityFeeGwei });
  const signed = await w.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, maxFeePerGas, maxPriorityFeePerGas, gasLimit, to: CPI, value: 0n, data: calldata });
  const send = await evmRpc("eth_sendRawTransaction", [signed]);
  if (send.error) return { ok: false, error: JSON.stringify(send.error).slice(0, 300) };
  await provider.waitForTransaction(send.result, 1, 120000).catch(() => null);
  const sigs = (await evmRpc("rome_solanaTxForEvmTx", [send.result])).result || [];
  let totalCu = 0, maxCu = 0;
  for (const s of sigs) { const c = await cuOfSig(s); if (c) { totalCu += c; maxCu = Math.max(maxCu, c); } }
  return { ok: true, txHash: send.result, legs: sigs.length, totalCu, maxCu };
}
