// createPool-actions.ts — DUAL-LANE submit for creating a simple (constant-product)
// pool via CreatePool (tag 7). Both lanes drive the pure builder in createPool.ts,
// which the on-chain proof (harness/create-simple-pool.test.mjs) verifies on both
// lanes. The caller funds the two vaults (authority's ATAs) from its own tokens,
// then CreatePool makes the pool/LP-mint/fee/destination PDAs internally.
//
//   • Solana lane — the connected wallet signs: create + fund the vaults, then CreatePool.
//   • EVM lane — the CPI precompile drives it: bootstrap the external_auth PDA with
//     lamports (gas→SOL) for the account rents, create + fund the vaults via the
//     HELPER, then CreatePool via CPI (PDA auto-signed as payer).
//
// RPC / program / chain-id all come from the active ChainConfig (multi-chain).

import { ethers } from "ethers";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { evmPdaFor } from "./walletActions";
import { resolveGas } from "./gas";
import { getActiveSolWallet } from "./solWallet";
import {
  CREATE_FEE_TIERS, resolveCreatePool, buildCreatePoolIx,
  buildEvmCreatePoolCalls, BOOTSTRAP_LAMPORTS,
} from "./createPool";
import type { ChainConfig } from "./chains/types";

export type OnStep = (i: number, total: number, label: string) => void;

export async function fetchMintDecimals(mintAddr: string, solanaRpc: string): Promise<number> {
  const conn = new Connection(solanaRpc, "confirmed");
  return (await getMint(conn, new PublicKey(mintAddr))).decimals;
}

export function toRaw(human: string, decimals: number): bigint {
  const [w, f = ""] = human.trim().split(".");
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f)) return 0n;
  return BigInt((w || "0") + (f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export interface CreateSimpleParams {
  mintA: string; mintB: string; decimalsA: number; decimalsB: number;
  feeBps: number; seedAHuman: string; seedBHuman: string;
}
export interface CreateResult {
  pool: string;
  signatures: string[];
  // Everything the "my pools" registry needs to list + read the new pool live.
  vaultA: string; vaultB: string;
}

const rpc = (solanaRpc: string, method: string, params: unknown[]) =>
  fetch(solanaRpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

function tierFees(feeBps: number) {
  const t = CREATE_FEE_TIERS.find((x) => x.feeBps === feeBps);
  if (!t) throw new Error(`unknown fee tier: ${feeBps} bps`);
  return t.fees;
}

// ── Solana lane ──────────────────────────────────────────────────────────────
async function signSendSolana(solanaRpc: string, ixs: TransactionInstruction[], feePayer: PublicKey): Promise<string> {
  const sol = getActiveSolWallet();
  if (!sol) throw new Error("Connect a Solana wallet.");
  const { blockhash } = (await rpc(solanaRpc, "getLatestBlockhash", [{ commitment: "confirmed" }])).result.value;
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer });
  for (const ix of ixs) tx.add(ix);
  const signed = await sol.signTransaction(tx);
  const send = await rpc(solanaRpc, "sendTransaction", [signed.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
  if (send.error) throw new Error(send.error.message || JSON.stringify(send.error));
  const sig = send.result as string;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = (await rpc(solanaRpc, "getSignatureStatuses", [[sig], { searchTransactionHistory: true }])).result?.value?.[0];
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error("transaction not confirmed in time");
}

export async function createSimplePoolSolana(chain: ChainConfig, creator: string, p: CreateSimpleParams, onStep?: OnStep): Promise<CreateResult> {
  const program = new PublicKey(chain.dex.dexProgram);
  const owner = new PublicKey(creator);
  const mintA = new PublicKey(p.mintA), mintB = new PublicKey(p.mintB);
  if (mintA.equals(mintB)) throw new Error("Pick two different tokens.");
  const seedA = toRaw(p.seedAHuman, p.decimalsA), seedB = toRaw(p.seedBHuman, p.decimalsB);
  if (seedA <= 0n || seedB <= 0n) throw new Error("Enter a starting amount for both tokens.");
  const r = resolveCreatePool(program, mintA, mintB, p.feeBps);
  const srcA = getAssociatedTokenAddressSync(mintA, owner, true, TOKEN_PROGRAM_ID);
  const srcB = getAssociatedTokenAddressSync(mintB, owner, true, TOKEN_PROGRAM_ID);
  const sigs: string[] = [];

  // Step 1: create + fund the vaults (authority's ATAs) from the creator's tokens.
  onStep?.(0, 2, "Set up the pool's vaults");
  sigs.push(await signSendSolana(chain.solanaRpc, [
    createAssociatedTokenAccountIdempotentInstruction(owner, r.vaultA, r.authority, mintA, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, r.vaultB, r.authority, mintB, TOKEN_PROGRAM_ID),
    createTransferInstruction(srcA, r.vaultA, owner, seedA, [], TOKEN_PROGRAM_ID),
    createTransferInstruction(srcB, r.vaultB, owner, seedB, [], TOKEN_PROGRAM_ID),
  ], owner));

  // Step 2: CreatePool (makes the pool + LP mint + fee/destination PDAs, mints LP).
  onStep?.(1, 2, "Create the pool and open it");
  sigs.push(await signSendSolana(chain.solanaRpc, [
    buildCreatePoolIx({ program, payer: owner, mintA, mintB, feeBps: p.feeBps, fees: tierFees(p.feeBps), ...r }),
  ], owner));
  return { pool: r.pool.toBase58(), signatures: sigs, vaultA: r.vaultA.toBase58(), vaultB: r.vaultB.toBase58() };
}

// ── EVM lane ─────────────────────────────────────────────────────────────────
async function sendEvm(chain: ChainConfig, eoa: string, to: string, data: string): Promise<string> {
  if (!window.ethereum) throw new Error("EVM wallet not available");
  const provider = new ethers.BrowserProvider(window.ethereum, { chainId: Number(chain.chainId), name: chain.name.toLowerCase() });
  const signer = await provider.getSigner();
  const g = await resolveGas({ from: eoa, to, data }, chain.evmRpc);
  const tx = await signer.sendTransaction({ to, data, type: 2, value: 0n, ...g });
  await tx.wait(1);
  return tx.hash;
}
export async function createSimplePoolEvm(chain: ChainConfig, eoa: string, p: CreateSimpleParams, onStep?: OnStep): Promise<CreateResult> {
  const program = new PublicKey(chain.dex.dexProgram);
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId); // external_auth PDA — CreatePool payer + vault-funder
  const mintA = new PublicKey(p.mintA), mintB = new PublicKey(p.mintB);
  if (mintA.equals(mintB)) throw new Error("Pick two different tokens.");
  const seedA = toRaw(p.seedAHuman, p.decimalsA), seedB = toRaw(p.seedBHuman, p.decimalsB);
  if (seedA <= 0n || seedB <= 0n) throw new Error("Enter a starting amount for both tokens.");
  const r = resolveCreatePool(program, mintA, mintB, p.feeBps);
  const conn = new Connection(chain.solanaRpc, "confirmed");

  // The pure builder encodes the whole sequence (bootstrap → vaults → fund →
  // CreatePool); this file only signs + sends. Same bytes as the on-chain proof
  // (harness/create-pool-app-path.test.mjs).
  const { calls } = buildEvmCreatePoolCalls({
    program, owner, mintA, mintB, feeBps: p.feeBps, fees: tierFees(p.feeBps), seedA, seedB,
    needBootstrap: BigInt(await conn.getBalance(owner)) < BOOTSTRAP_LAMPORTS,
    needVaultA: !(await conn.getAccountInfo(r.vaultA)),
    needVaultB: !(await conn.getAccountInfo(r.vaultB)),
  });
  const hashes: string[] = [];
  for (const [i, call] of calls.entries()) {
    onStep?.(i, calls.length, call.label);
    hashes.push(await sendEvm(chain, eoa, call.to, call.data));
  }
  return { pool: r.pool.toBase58(), signatures: hashes, vaultA: r.vaultA.toBase58(), vaultB: r.vaultB.toBase58() };
}
