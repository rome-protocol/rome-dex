// myPoolTrade.ts — trade a SIMPLE (constant-product) pool YOU created, from the
// /pools "Pools you created" list. The main swap card is static (PAIRS +
// server-side /api/tiers) and can't see a device-local pool, so we trade a created
// pool directly: quote client-side (the byte-faithful lib/quote.ts mirror over
// live reserves) and execute by its explicit accounts — Solana direct Swap ix, or
// EVM DIRECT-CPI (no router; created pools aren't router-registered). All accounts
// are the deterministic CreatePool PDAs re-derived from the two mints + fee.
//
// CLMM created pools are NOT handled here (tick-array swap path is separate).

import { ethers } from "ethers";
import {
  Connection, PublicKey, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, getAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  CPI_PRECOMPILE, evmPdaFor, buildSwapAccounts, buildEvmCalldata, type Pool,
} from "./walletActions";
import { resolveGas } from "./gas";
import { getActiveSolWallet } from "./solWallet";
import { quoteExactIn, spotPrice } from "./quote";
import { CREATE_FEE_TIERS, resolveCreatePool } from "./createPool";
import { readMyPoolState, type MyPool } from "./myPools";
import type { ChainConfig } from "./chains/types";

const HELPER = "0xff00000000000000000000000000000000000009";
const HELPER_IFACE = new ethers.Interface(["function create_ata(address user, bytes32 mint)"]);
const u64 = (v: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const swapData = (amountIn: bigint, minOut: bigint): Buffer =>
  Buffer.concat([Buffer.from([1]), u64(amountIn), u64(minOut)]);
const b32 = (pk: PublicKey): string => "0x" + Buffer.from(pk.toBuffer()).toString("hex");

/** Reconstruct the full Pool config for a created SIMPLE pool from its registry
 *  entry (all accounts are deterministic CreatePool PDAs). */
export function poolConfigFor(entry: MyPool): Pool {
  const program = new PublicKey(entry.program);
  const mintA = new PublicKey(entry.mintA), mintB = new PublicKey(entry.mintB);
  const r = resolveCreatePool(program, mintA, mintB, entry.feeBps);
  return {
    program, swapState: r.pool, authority: r.authority,
    mintA, mintB, vaultA: r.vaultA, vaultB: r.vaultB,
    poolMint: r.lpMint, feeAccount: r.feeAcct,
    symbolA: entry.symbolA, symbolB: entry.symbolB,
    decimalsA: entry.decimalsA, decimalsB: entry.decimalsB,
    // Identity fields the Pool type carries but buildSwapAccounts doesn't read.
    pairId: `${entry.symbolA}-${entry.symbolB}`, pairName: `${entry.symbolA} / ${entry.symbolB}`,
    poolId: 0, tier: entry.tier, bps: entry.feeBps,
  };
}

const feesFor = (bps: number) => (CREATE_FEE_TIERS.find((t) => t.feeBps === bps) ?? CREATE_FEE_TIERS[1]).fees;

export interface TradeQuote { amountOut: bigint; minOut: bigint; price: number; spot: number; }

/** Quote a swap on a created pool from live reserves. dir "AtoB" sells token A. */
export async function quoteMyPool(chain: ChainConfig, entry: MyPool, dir: "AtoB" | "BtoA", amountIn: bigint, slippageBps = 50): Promise<TradeQuote> {
  const { reserveA, reserveB } = await readMyPoolState(entry, chain.solanaRpc);
  const [reserveIn, reserveOut] = dir === "AtoB" ? [reserveA, reserveB] : [reserveB, reserveA];
  const q = quoteExactIn({ amountIn, reserveIn, reserveOut, fees: feesFor(entry.feeBps) });
  const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return { amountOut: q.amountOut, minOut, price: q.price, spot: spotPrice({ reserveIn, reserveOut }) };
}

const rpc = (solanaRpc: string, method: string, params: unknown[]) =>
  fetch(solanaRpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

async function confirm(solanaRpc: string, sig: string): Promise<string> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = (await rpc(solanaRpc, "getSignatureStatuses", [[sig], { searchTransactionHistory: true }])).result?.value?.[0];
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error("transaction not confirmed in time");
}

/** Execute the swap on a created pool. Returns the tx signature/hash. */
export async function tradeMyPool(chain: ChainConfig, entry: MyPool, lane: "solana" | "evm", walletAddr: string, dir: "AtoB" | "BtoA", amountIn: bigint, minOut: bigint): Promise<string> {
  const pool = poolConfigFor(entry);
  const [srcMint, dstMint] = dir === "AtoB" ? [pool.mintA, pool.mintB] : [pool.mintB, pool.mintA];
  const conn = new Connection(chain.solanaRpc, "confirmed");

  if (lane === "solana") {
    const sol = getActiveSolWallet();
    if (!sol) throw new Error("Connect a Solana wallet.");
    const user = new PublicKey(walletAddr);
    const srcAta = getAssociatedTokenAddressSync(srcMint, user, true, TOKEN_PROGRAM_ID);
    const dstAta = getAssociatedTokenAddressSync(dstMint, user, true, TOKEN_PROGRAM_ID);
    const ixs: TransactionInstruction[] = [];
    if (!(await conn.getAccountInfo(dstAta))) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, dstAta, user, dstMint, TOKEN_PROGRAM_ID));
    }
    ixs.push(new TransactionInstruction({ programId: pool.program, keys: buildSwapAccounts(dir, user, srcAta, dstAta, pool), data: swapData(amountIn, minOut) }));
    const { blockhash } = (await rpc(chain.solanaRpc, "getLatestBlockhash", [{ commitment: "confirmed" }])).result.value;
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: user });
    for (const ix of ixs) tx.add(ix);
    const signed = await sol.signTransaction(tx);
    const send = await rpc(chain.solanaRpc, "sendTransaction", [signed.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    if (send.error) throw new Error(send.error.message || JSON.stringify(send.error));
    return confirm(chain.solanaRpc, send.result as string);
  }

  // EVM: direct-CPI (owner = external_auth PDA, Rome auto-signs; no router).
  if (!window.ethereum) throw new Error("EVM wallet not available");
  const owner = evmPdaFor(walletAddr, chain.romeEvmProgramId);
  const srcAta = getAssociatedTokenAddressSync(srcMint, owner, true, TOKEN_PROGRAM_ID);
  const dstAta = getAssociatedTokenAddressSync(dstMint, owner, true, TOKEN_PROGRAM_ID);
  const provider = new ethers.BrowserProvider(window.ethereum, { chainId: Number(chain.chainId), name: chain.name.toLowerCase() });
  const signer = await provider.getSigner();
  const send = async (to: string, data: string) => {
    const g = await resolveGas({ from: walletAddr, to, data }, chain.evmRpc);
    const tx = await signer.sendTransaction({ to, data, type: 2, value: 0n, ...g });
    await tx.wait(1);
    return tx.hash;
  };
  if (!(await conn.getAccountInfo(dstAta))) {
    await send(HELPER, HELPER_IFACE.encodeFunctionData("create_ata", [walletAddr, b32(dstMint)]));
  }
  const calldata = buildEvmCalldata(buildSwapAccounts(dir, owner, srcAta, dstAta, pool), swapData(amountIn, minOut), pool.program);
  return send(CPI_PRECOMPILE, calldata);
}
