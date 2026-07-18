// clmmPoolTrade.ts — trade a CLMM pool YOU created, from the /pools list. Mirrors
// myPoolTrade.ts (constant-product) for the concentrated case: quote client-side
// via the byte-faithful engine mirror (quoteClmmExactInSync) over the live pool +
// its walk-order tick arrays, and execute by explicit accounts — Solana direct
// Swap (tag 7), or EVM DIRECT-CPI. The pool's tick spacing + current tick are read
// on-chain, so the walk arrays are derived at trade time (nothing extra to store).

import { ethers } from "ethers";
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { CPI_PRECOMPILE, evmPdaFor, buildEvmCalldata, type AccMeta } from "./walletActions";
import { resolveGas } from "./gas";
import { getActiveSolWallet } from "./solWallet";
import { decodePool, decodeTickArray, quoteClmmExactInSync, TICK_ARRAY_SIZE, type TickArrayView } from "./clmm-quote";
import { tickArrayPdaFor } from "./clmm-create";
import { type MyPool } from "./myPools";
import { type TradeQuote } from "./myPoolTrade";
import type { ChainConfig } from "./chains/types";

const TOKEN = TOKEN_PROGRAM_ID;
const HELPER = "0xff00000000000000000000000000000000000009";
const HELPER_IFACE = new ethers.Interface(["function create_ata(address user, bytes32 mint)"]);
const u64 = (v: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const u128 = (v: bigint): Buffer => { const b = Buffer.alloc(16); b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(v >> 64n, 8); return b; };
const b32 = (pk: PublicKey): string => "0x" + Buffer.from(pk.toBuffer()).toString("hex");
// CLMM Swap tag 7: [7, zeroForOne u8, amountIn u64, minOut u64, sqrtPriceLimit u128]
const swapDataClmm = (zeroForOne: boolean, amountIn: bigint, minOut: bigint, limit = 0n): Buffer =>
  Buffer.concat([Buffer.from([7]), Buffer.from([zeroForOne ? 1 : 0]), u64(amountIn), u64(minOut), u128(limit)]);

const rpc = (solanaRpc: string, method: string, params: unknown[]) =>
  fetch(solanaRpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

// Read the created CLMM pool + its walk-order tick arrays for `dir`. `zeroForOne`
// = selling token0 (mint0 = registry mintA). Walk starts at the array holding the
// current tick and steps in the swap direction (engine.rs validates arrays[0]).
async function readPoolAndArrays(solanaRpc: string, entry: MyPool, zeroForOne: boolean) {
  const conn = new Connection(solanaRpc, "confirmed");
  const program = new PublicKey(entry.program);
  const poolPk = new PublicKey(entry.pool);
  const info = await conn.getAccountInfo(poolPk);
  if (!info) throw new Error("pool not found on-chain");
  const pool = decodePool(info.data);
  const span = TICK_ARRAY_SIZE * pool.tickSpacing;
  const start = Math.floor(pool.currentTick / span) * span;
  const starts = zeroForOne ? [start, start - span] : [start, start + span];
  const pdas = starts.map((s) => tickArrayPdaFor(program, poolPk, s)[0]);
  const infos = (await rpc(solanaRpc, "getMultipleAccounts", [pdas.map((p) => p.toBase58()), { encoding: "base64" }])).result?.value ?? [];
  const arrays: TickArrayView[] = [];
  const arrayPdas: PublicKey[] = [];
  infos.forEach((acct: { data?: [string, string] } | null, i: number) => {
    if (acct?.data?.[0]) { arrays.push(decodeTickArray(Buffer.from(acct.data[0], "base64"))); arrayPdas.push(pdas[i]); }
  });
  return { conn, program, poolPk, pool, arrays, arrayPdas };
}

/** Quote a CLMM swap on a created pool. dir "AtoB" sells token0 (mintA). */
export async function quoteClmmMyPool(chain: ChainConfig, entry: MyPool, dir: "AtoB" | "BtoA", amountIn: bigint, slippageBps = 50): Promise<TradeQuote> {
  const zeroForOne = dir === "AtoB";
  const { pool, arrays } = await readPoolAndArrays(chain.solanaRpc, entry, zeroForOne);
  const q = quoteClmmExactInSync(pool, arrays, zeroForOne, amountIn);
  const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return { amountOut: q.amountOut, minOut, price: amountIn === 0n ? 0 : Number(q.amountOut) / Number(amountIn), spot: 0 };
}

/** Execute a CLMM swap on a created pool. Returns the tx signature/hash. */
export async function tradeClmmMyPool(chain: ChainConfig, entry: MyPool, lane: "solana" | "evm", walletAddr: string, dir: "AtoB" | "BtoA", amountIn: bigint, minOut: bigint): Promise<string> {
  const zeroForOne = dir === "AtoB";
  const { conn, program, poolPk, arrayPdas } = await readPoolAndArrays(chain.solanaRpc, entry, zeroForOne);
  const mint0 = new PublicKey(entry.mintA), mint1 = new PublicKey(entry.mintB);
  const vault0 = new PublicKey(entry.vaultA), vault1 = new PublicKey(entry.vaultB);
  const [srcMint, dstMint] = zeroForOne ? [mint0, mint1] : [mint1, mint0];
  const data = swapDataClmm(zeroForOne, amountIn, minOut);

  const acct = (pk: PublicKey, s: boolean, w: boolean): AccMeta => ({ pubkey: pk, isSigner: s, isWritable: w });
  const buildAccounts = (authority: PublicKey, src: PublicKey, dst: PublicKey): AccMeta[] => [
    acct(poolPk, false, true), acct(authority, true, false), acct(src, false, true), acct(dst, false, true),
    acct(vault0, false, true), acct(vault1, false, true), acct(TOKEN, false, false),
    ...arrayPdas.map((a) => acct(a, false, true)),
  ];

  if (lane === "solana") {
    const sol = getActiveSolWallet();
    if (!sol) throw new Error("Connect a Solana wallet.");
    const user = new PublicKey(walletAddr);
    const src = getAssociatedTokenAddressSync(srcMint, user, true, TOKEN);
    const dst = getAssociatedTokenAddressSync(dstMint, user, true, TOKEN);
    const ixs: TransactionInstruction[] = [];
    if (!(await conn.getAccountInfo(dst))) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, dst, user, dstMint, TOKEN));
    ixs.push(new TransactionInstruction({ programId: program, keys: buildAccounts(user, src, dst), data }));
    const { blockhash } = (await rpc(chain.solanaRpc, "getLatestBlockhash", [{ commitment: "confirmed" }])).result.value;
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: user });
    // CLMM swaps run close to (past, at real-price ticks) the 200K default CU.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
    for (const ix of ixs) tx.add(ix);
    const signed = await sol.signTransaction(tx);
    const send = await rpc(chain.solanaRpc, "sendTransaction", [signed.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    if (send.error) throw new Error(send.error.message || JSON.stringify(send.error));
    const sig = send.result as string;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const st = (await rpc(chain.solanaRpc, "getSignatureStatuses", [[sig], { searchTransactionHistory: true }])).result?.value?.[0];
      if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    }
    throw new Error("transaction not confirmed in time");
  }

  // EVM: direct-CPI (owner = external_auth PDA, auto-signed).
  if (!window.ethereum) throw new Error("EVM wallet not available");
  const owner = evmPdaFor(walletAddr, chain.romeEvmProgramId);
  const src = getAssociatedTokenAddressSync(srcMint, owner, true, TOKEN);
  const dst = getAssociatedTokenAddressSync(dstMint, owner, true, TOKEN);
  const provider = new ethers.BrowserProvider(window.ethereum, { chainId: Number(chain.chainId), name: chain.name.toLowerCase() });
  const signer = await provider.getSigner();
  const send = async (to: string, d: string) => {
    const g = await resolveGas({ from: walletAddr, to, data: d }, chain.evmRpc);
    const tx = await signer.sendTransaction({ to, data: d, type: 2, value: 0n, ...g });
    await tx.wait(1);
    return tx.hash;
  };
  if (!(await conn.getAccountInfo(dst))) await send(HELPER, HELPER_IFACE.encodeFunctionData("create_ata", [walletAddr, b32(dstMint)]));
  return send(CPI_PRECOMPILE, buildEvmCalldata(buildAccounts(owner, src, dst), data, program));
}
