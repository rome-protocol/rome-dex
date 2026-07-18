// clmm-create-actions.ts — dual-lane submit for creating a NEW CLMM pool. Imports
// wallet/window runtime (NOT harness-imported). Both lanes drive the SAME pure
// builders (clmm-create.ts) that the on-chain proof (clmm-create-pool.test.mjs)
// verifies, so the UI path is byte-identical to what passed on Hadrian.
//
//   • Solana lane — the connected wallet signs: create the two vault ATAs + InitPool,
//     then one InitTickArray per array the initial range spans.
//   • EVM lane — the CPI precompile drives it: bootstrap the external_auth PDA with
//     lamports (gas→SOL) for all the rent, create the pool-PDA vault ATAs via the
//     HELPER, then InitPool + InitTickArray(s) via CPI (PDA auto-signed as payer).

import { ethers } from "ethers";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { CPI_PRECOMPILE, evmPdaFor } from "./walletActions";
import { resolveGas } from "./gas";
import { getActiveSolWallet } from "./solWallet";
import {
  poolPdaFor, tickArrayPdaFor, vaultAtaFor, orderMints, tickArrayStartsForRange,
  buildInitPoolIx, buildInitTickArrayIx, initPoolData, initTickArrayData,
} from "./clmm-create";
import type { ChainConfig } from "./chains/types";

// The active chain's CLMM program (throws if the chain has no CLMM product).
function clmmProgram(chain: ChainConfig): PublicKey {
  if (!chain.clmm) throw new Error("This chain has no CLMM product.");
  return new PublicKey(chain.clmm.program);
}
const HELPER = "0xff00000000000000000000000000000000000009";
// Account sizes for the EVM-lane rent bootstrap (clmm/src/state.rs; test:70-71).
const POOL_LEN = 204;
const TICK_ARRAY_LEN = 38 + 88 * 64; // 5670
const BOOTSTRAP_MARGIN = 5_000_000n;

const b32 = (pk: PublicKey): string => "0x" + Buffer.from(pk.toBuffer()).toString("hex");
const CPI_IFACE = new ethers.Interface(["function invoke(bytes32 program_id, (bytes32 pubkey, bool is_signer, bool is_writable)[] accounts, bytes data)"]);
const HELPER_IFACE = new ethers.Interface([
  "function swap_gas_to_lamports(uint64 lamports)",
  "function create_ata_for_key(bytes32 wallet, bytes32 mint)",
]);

export type OnStep = (i: number, total: number, label: string) => void;

export interface CreateClmmParams {
  mintA: string; mintB: string;
  feePips: number; tickSpacing: number;
  sqrtPrice: bigint;
  tickLower: number; tickUpper: number;
}

/** Read a mint's decimals from chain — also validates the address is a real mint. */
export async function fetchMintDecimals(mintAddr: string, solanaRpc: string): Promise<number> {
  const conn = new Connection(solanaRpc, "confirmed");
  const info = await getMint(conn, new PublicKey(mintAddr));
  return info.decimals;
}

const rpc = (solanaRpc: string, method: string, params: unknown[]) =>
  fetch(solanaRpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

// ── Solana lane ──────────────────────────────────────────────────────────────
async function signSendSolana(solanaRpc: string, ixs: TransactionInstruction[], feePayer: PublicKey): Promise<string> {
  const sol = getActiveSolWallet();
  if (!sol) throw new Error("Connect a Solana wallet to create a pool.");
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

export async function createClmmPoolSolana(
  chain: ChainConfig, creator: string, p: CreateClmmParams, onStep?: OnStep,
): Promise<{ poolPda: string; signatures: string[] }> {
  const program = clmmProgram(chain);
  const owner = new PublicKey(creator);
  const { mint0, mint1 } = orderMints(new PublicKey(p.mintA), new PublicKey(p.mintB));
  const [poolPda, bump] = poolPdaFor(program, mint0, mint1, p.feePips);
  const vault0 = vaultAtaFor(poolPda, mint0), vault1 = vaultAtaFor(poolPda, mint1);
  const starts = tickArrayStartsForRange(p.tickLower, p.tickUpper, p.tickSpacing);
  const total = 1 + starts.length;
  const sigs: string[] = [];

  // Step 1: create the two vault ATAs + InitPool (one tx, creator signs + pays).
  onStep?.(0, total, "Create the pool and its vaults");
  sigs.push(await signSendSolana(chain.solanaRpc, [
    createAssociatedTokenAccountIdempotentInstruction(owner, vault0, poolPda, mint0, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, vault1, poolPda, mint1, TOKEN_PROGRAM_ID),
    buildInitPoolIx({ program, poolPda, bump, mint0, mint1, vault0, vault1, payer: owner, feePips: p.feePips, tickSpacing: p.tickSpacing, sqrtPrice: p.sqrtPrice }),
  ], owner));

  // Step 2..: one InitTickArray per array the initial range spans.
  for (let k = 0; k < starts.length; k++) {
    onStep?.(1 + k, total, "Prepare the price range");
    const [ta, taBump] = tickArrayPdaFor(program, poolPda, starts[k]);
    sigs.push(await signSendSolana(chain.solanaRpc, [
      buildInitTickArrayIx({ program, poolPda, tickArrayPda: ta, bump: taBump, startIndex: starts[k], payer: owner }),
    ], owner));
  }
  return { poolPda: poolPda.toBase58(), signatures: sigs };
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
const cpi = (chain: ChainConfig, program: PublicKey, eoa: string, accounts: readonly (readonly [string, boolean, boolean])[], data: Buffer) =>
  sendEvm(chain, eoa, CPI_PRECOMPILE, CPI_IFACE.encodeFunctionData("invoke", [b32(program), accounts, "0x" + data.toString("hex")]));
const meta = (pk: PublicKey, s: boolean, w: boolean) => [b32(pk), s, w] as const;

export async function createClmmPoolEvm(
  chain: ChainConfig, eoa: string, p: CreateClmmParams, onStep?: OnStep,
): Promise<{ poolPda: string; txHashes: string[] }> {
  const program = clmmProgram(chain);
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId); // external_auth PDA — InitPool payer, auto-signed by Rome
  const { mint0, mint1 } = orderMints(new PublicKey(p.mintA), new PublicKey(p.mintB));
  const [poolPda, bump] = poolPdaFor(program, mint0, mint1, p.feePips);
  const vault0 = vaultAtaFor(poolPda, mint0), vault1 = vaultAtaFor(poolPda, mint1);
  const starts = tickArrayStartsForRange(p.tickLower, p.tickUpper, p.tickSpacing);
  const total = 2 + starts.length; // bootstrap+vaults, InitPool, arrays
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const hashes: string[] = [];

  // Bootstrap the cold PDA with lamports for ALL the CPI rent it will pay (pool +
  // tick arrays); tick arrays are ~40M lamports EACH (test:324-327).
  onStep?.(0, total, "Prepare your account");
  const poolRent = BigInt(await conn.getMinimumBalanceForRentExemption(POOL_LEN));
  const taRent = BigInt(await conn.getMinimumBalanceForRentExemption(TICK_ARRAY_LEN));
  const need = poolRent + BigInt(starts.length) * taRent + BOOTSTRAP_MARGIN;
  const have = BigInt(await conn.getBalance(owner));
  if (have < need) {
    hashes.push(await sendEvm(chain, eoa, HELPER, HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [need - have])));
  }
  // Create the pool-PDA vault ATAs from the EVM lane (foreign raw-pubkey owner).
  for (const mint of [mint0, mint1]) {
    const vault = getAssociatedTokenAddressSync(mint, poolPda, true, TOKEN_PROGRAM_ID);
    if (!(await conn.getAccountInfo(vault))) {
      hashes.push(await sendEvm(chain, eoa, HELPER, HELPER_IFACE.encodeFunctionData("create_ata_for_key", [b32(poolPda), b32(mint)])));
    }
  }

  // InitPool via CPI — payer = external_auth PDA, Rome auto-signs. Reuses the
  // pure builder's exact data encoding (buildInitPoolIx assembles the same ix for
  // the Solana lane); the CPI path just needs its `.data` + its own meta triples.
  onStep?.(1, total, "Create the pool");
  const initPoolIx = buildInitPoolIx({ program, poolPda, bump, mint0, mint1, vault0, vault1, payer: owner, feePips: p.feePips, tickSpacing: p.tickSpacing, sqrtPrice: p.sqrtPrice });
  hashes.push(await cpi(chain, program, eoa, initPoolIx.keys.map((k) => meta(k.pubkey, k.isSigner, k.isWritable)), initPoolData(bump, p.feePips, p.tickSpacing, p.sqrtPrice)));

  // InitTickArray(s) via CPI — same auto-signed PDA payer.
  for (let k = 0; k < starts.length; k++) {
    onStep?.(2 + k, total, "Prepare the price range");
    const [ta, taBump] = tickArrayPdaFor(program, poolPda, starts[k]);
    const taIx = buildInitTickArrayIx({ program, poolPda, tickArrayPda: ta, bump: taBump, startIndex: starts[k], payer: owner });
    hashes.push(await cpi(chain, program, eoa, taIx.keys.map((k2) => meta(k2.pubkey, k2.isSigner, k2.isWritable)), initTickArrayData(starts[k], taBump)));
  }
  return { poolPda: poolPda.toBase58(), txHashes: hashes };
}
