/**
 * farm.ts — dual-lane client for the rome-dex liquidity-mining farm.
 *
 * Mirrors harness/farm.test.mjs exactly (account layouts + instruction
 * encoders). One MasterChef-style farm: stake a rome-dex LP mint, earn the RDX
 * reward SPL over time, claim, unstake. Authority-agnostic — the same account
 * layout serves both lanes:
 *
 *   • Solana lane — the connected pubkey is `authority` (a signer over
 *     its own LP/reward ATAs). the Solana wallet signs a native tx; the app submits it to
 *     Rome's substrate RPC (chain.solanaRpc), exactly like phantomSwap.
 *   • EVM lane   — the EOA's external_auth PDA is `authority`; the
 *     call goes through CPI 0xFF..08 and Rome auto-signs the PDA (no delegate/
 *     approve — the farm pulls LP straight from the PDA-owned ATA, which the PDA
 *     signs for). This is the same seam the harness EVM lane (execEvmCpi) uses.
 *
 * No keys are held here — all signing is delegated to the connected wallet.
 * Reads (staked / pending / total / APR) are plain getAccountInfo against the
 * farm + UserStake PDA, decoding the Rust byte layout in farm/src/state.rs.
 *
 * Farm data comes from the active chain's dex.farm (cfg.dex.farm), no longer a
 * static JSON import. A chain without a farm throws on any farm action.
 */
"use client";

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ethers } from "ethers";
import {
  CPI_PRECOMPILE, evmPdaFor, buildEvmCalldata,
  tiersOf, type AccMeta, type Pool,
} from "./walletActions";
import { resolveGas } from "./gas";
import { requireEvmProvider } from "./evmWallet";
import { getActiveSolWallet } from "./solWallet";
import type { ChainConfig } from "./chains/types";

// ---- chain-agnostic constants ----
export const LP_DECIMALS = 6; // rome-dex LP mints are 6-decimal
export const REWARD_SYMBOL = "RDX";

const TOKEN = TOKEN_PROGRAM_ID;
const SYSTEM = SystemProgram.programId;
const ACC_PRECISION = 1_000_000_000_000n; // state.rs ACC_PRECISION (1e12)
const SECONDS_PER_YEAR = 31_536_000n;

// ---- farm config (from the active chain's dex.farm — setup-farm.mjs output) ----
// Same object shape as the old farm.json.
interface RawFarm {
  farmProgram: string; farm: string; authority: string; bump: number;
  lpMint: string; rewardMint: string; rewardDecimals: number;
  lpVault: string; owner: string; rewardPerSecond: string;
}

export interface FarmConfig {
  farmProgram: PublicKey;
  farm: PublicKey;
  farmAuthority: PublicKey;
  lpMint: PublicKey;
  rewardMint: PublicKey;
  lpVault: PublicKey;
  rewardDecimals: number;
}

/** Resolve the active chain's farm config, or throw when the chain has no farm. */
export function farmConfig(chain: ChainConfig): FarmConfig {
  const raw = chain.dex.farm as unknown as RawFarm | undefined;
  if (!raw || !raw.farmProgram) throw new Error("no farm on this chain");
  return {
    farmProgram: new PublicKey(raw.farmProgram),
    farm: new PublicKey(raw.farm),
    farmAuthority: new PublicKey(raw.authority),
    lpMint: new PublicKey(raw.lpMint),
    rewardMint: new PublicKey(raw.rewardMint),
    lpVault: new PublicKey(raw.lpVault),
    rewardDecimals: raw.rewardDecimals,
  };
}

/** Reward-token decimals for the active chain's farm (RDX). */
export function rewardDecimalsOf(chain: ChainConfig): number {
  return farmConfig(chain).rewardDecimals;
}

/** The rome-dex pool whose LP mint this farm stakes (e.g. USDC/SOL 0.30%). */
export function farmPool(chain: ChainConfig): Pool | undefined {
  const lpMint = farmConfig(chain).lpMint;
  return tiersOf(chain).find((t) => t.poolMint.equals(lpMint));
}

// ---- instruction encoders (mirror harness/farm.test.mjs) ----
function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
const initUserStakeData = () => Buffer.from([1]);
const stakeData = (amt: bigint) => Buffer.concat([Buffer.from([2]), u64(amt)]);
const unstakeData = (amt: bigint) => Buffer.concat([Buffer.from([3]), u64(amt)]);
const claimData = () => Buffer.from([4]);

const acc = (pk: PublicKey, s: boolean, w: boolean): AccMeta => ({ pubkey: pk, isSigner: s, isWritable: w });

/** UserStake PDA for a staking authority = (farm, authority). */
export function userStakePda(fc: FarmConfig, authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([fc.farm.toBuffer(), authority.toBuffer()], fc.farmProgram)[0];
}

async function ataFor(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

// Account layouts — identical bytes on both lanes (authority-agnostic seam).
const initUserStakeAccounts = (fc: FarmConfig, authority: PublicKey, ustake: PublicKey, payer: PublicKey): AccMeta[] => [
  acc(fc.farm, false, false), acc(authority, false, false), acc(ustake, false, true),
  acc(payer, true, true), acc(SYSTEM, false, false),
];
const stakeAccounts = (fc: FarmConfig, authority: PublicKey, ustake: PublicKey, userLp: PublicKey): AccMeta[] => [
  acc(fc.farm, false, true), acc(fc.farmAuthority, false, false), acc(authority, true, false),
  acc(ustake, false, true), acc(userLp, false, true), acc(fc.lpVault, false, true), acc(TOKEN, false, false),
];
const unstakeAccounts = (fc: FarmConfig, authority: PublicKey, ustake: PublicKey, userLp: PublicKey): AccMeta[] => [
  acc(fc.farm, false, true), acc(fc.farmAuthority, false, false), acc(authority, true, false),
  acc(ustake, false, true), acc(fc.lpVault, false, true), acc(userLp, false, true), acc(TOKEN, false, false),
];
const claimAccounts = (fc: FarmConfig, authority: PublicKey, ustake: PublicKey, userReward: PublicKey): AccMeta[] => [
  acc(fc.farm, false, true), acc(fc.farmAuthority, false, false), acc(authority, true, false),
  acc(ustake, false, true), acc(fc.rewardMint, false, true), acc(userReward, false, true), acc(TOKEN, false, false),
];

// ============================================================
// READS — getAccountInfo + decode the Rust byte layout
// ============================================================

const leU64 = (b: Uint8Array, off: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
};
const leU128 = (b: Uint8Array, off: number): bigint => {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
};
const leI64 = (b: Uint8Array, off: number): bigint => {
  const u = leU64(b, off);
  return u >= 1n << 63n ? u - (1n << 64n) : u;
};

async function accountData(solanaRpc: string, pk: PublicKey): Promise<Uint8Array | null> {
  const res = await fetch(solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [pk.toBase58(), { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const d = await res.json();
  const val = d?.result?.value;
  if (!val?.data?.[0]) return null;
  return Uint8Array.from(Buffer.from(val.data[0], "base64"));
}

export interface FarmState {
  rewardPerSecond: bigint;
  lastUpdateTs: bigint;
  accRewardPerShare: bigint;
  totalStaked: bigint;
}

// Farm byte offsets (state.rs FARM_LEN=202): is_init(1) bump(1) owner(32)
// lp_mint(32) reward_mint(32) lp_vault(32) token_program(32) reward_per_second@162
// last_update_ts@170 acc_reward_per_share@178 total_staked@194.
export async function readFarm(chain: ChainConfig): Promise<FarmState | null> {
  const fc = farmConfig(chain);
  const b = await accountData(chain.solanaRpc, fc.farm);
  if (!b || b.length < 202) return null;
  return {
    rewardPerSecond: leU64(b, 162),
    lastUpdateTs: leI64(b, 170),
    accRewardPerShare: leU128(b, 178),
    totalStaked: leU64(b, 194),
  };
}

export interface UserStakeState {
  amount: bigint;
  rewardDebt: bigint;
  rewardPending: bigint;
}

// UserStake byte offsets (USER_STAKE_LEN=33): is_init(1) amount@1 reward_debt@9 reward_pending@25.
export async function readUserStake(chain: ChainConfig, authority: PublicKey): Promise<UserStakeState | null> {
  const fc = farmConfig(chain);
  const b = await accountData(chain.solanaRpc, userStakePda(fc, authority));
  if (!b || b.length < 33 || b[0] !== 1) return null;
  return { amount: leU64(b, 1), rewardDebt: leU128(b, 9), rewardPending: leU64(b, 25) };
}

/** Live accumulator advanced to `nowTs` — mirrors Farm::accrue. */
function accrueTo(f: FarmState, nowTs: bigint): bigint {
  if (nowTs <= f.lastUpdateTs || f.totalStaked === 0n || f.rewardPerSecond === 0n) return f.accRewardPerShare;
  const elapsed = nowTs - f.lastUpdateTs;
  const perShare = (elapsed * f.rewardPerSecond * ACC_PRECISION) / f.totalStaked;
  return f.accRewardPerShare + perShare;
}

/** Pending reward (raw reward units) for a position — mirrors UserStake::pending after a live accrue. */
export function pendingReward(f: FarmState, u: UserStakeState, nowTs: bigint = BigInt(Math.floor(Date.now() / 1000))): bigint {
  const acc = accrueTo(f, nowTs);
  const gross = (u.amount * acc) / ACC_PRECISION;
  const accrued = gross > u.rewardDebt ? gross - u.rewardDebt : 0n;
  return u.rewardPending + accrued;
}

export interface FarmStats {
  totalStaked: bigint;
  rewardPerSecond: bigint;
  /** RDX emitted per day (raw reward units). */
  emissionPerDay: bigint;
  /**
   * Reward-terms APR: annual RDX emitted per staked LP, as a percentage.
   * Assumes 1 RDX ≈ 1 LP in value (no reward-token price feed) — a reward-rate
   * signal, not a USD yield. null when nothing is staked yet.
   */
  aprPct: number | null;
}

export function farmStats(f: FarmState, rewardDecimals: number): FarmStats {
  const emissionPerDay = f.rewardPerSecond * 86_400n;
  let aprPct: number | null = null;
  if (f.totalStaked > 0n) {
    const annualReward = Number(f.rewardPerSecond * SECONDS_PER_YEAR) / 10 ** rewardDecimals;
    const stakedTokens = Number(f.totalStaked) / 10 ** LP_DECIMALS;
    if (stakedTokens > 0) aprPct = (annualReward / stakedTokens) * 100;
  }
  return { totalStaked: f.totalStaked, rewardPerSecond: f.rewardPerSecond, emissionPerDay, aprPct };
}

/** Does the (farm, authority) UserStake PDA exist and hold state? */
export async function userStakeExists(chain: ChainConfig, authority: PublicKey): Promise<boolean> {
  return (await readUserStake(chain, authority)) !== null;
}

// ============================================================
// SOLANA LANE — the Solana wallet signs a native tx; app submits to chain.solanaRpc
// ============================================================

async function sendSolana(solanaRpc: string, ixs: TransactionInstruction[], feePayer: PublicKey): Promise<string> {
  const sol = getActiveSolWallet();
  if (!sol) throw new Error("Solana wallet not connected");

  const bhRes = await fetch(solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
  });
  const { blockhash, lastValidBlockHeight } = (await bhRes.json()).result.value;

  const tx = new Transaction({ recentBlockhash: blockhash, feePayer });
  for (const ix of ixs) tx.add(ix);

  // The Solana wallet SIGNS only; the app submits to Rome's substrate RPC — the
  // rome-dex farm lives there, not on the wallet-default public cluster.
  const signed = await sol.signTransaction(tx);
  const sendRes = await fetch(solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [signed.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }] }),
  });
  const sendJson = await sendRes.json();
  if (sendJson.error) throw new Error(sendJson.error.message || JSON.stringify(sendJson.error));
  const signature = sendJson.result as string;

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[signature], { searchTransactionHistory: true }] }),
    });
    const conf = (await statusRes.json()).result?.value?.[0]?.confirmationStatus;
    if (conf === "confirmed" || conf === "finalized") break;
    const slotRes = await fetch(solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] }),
    });
    if ((await slotRes.json()).result > lastValidBlockHeight) throw new Error("Transaction expired (block height exceeded)");
  }
  return signature;
}

const farmIx = (programId: PublicKey, accounts: AccMeta[], data: Buffer): TransactionInstruction =>
  new TransactionInstruction({ programId, keys: accounts, data });

// ============================================================
// EVM LANE — the EVM wallet sends one CPI invoke() to 0xFF..08 per action
// ============================================================

async function sendEvmInvoke(chain: ChainConfig, eoa: string, accounts: AccMeta[], data: Buffer, program: PublicKey, priorityFeeGwei?: number): Promise<string> {
  const calldata = buildEvmCalldata(accounts, data, program);
  const provider = new ethers.BrowserProvider(requireEvmProvider(), { chainId: Number(chain.chainId), name: chain.name.toLowerCase() });
  const signer = await provider.getSigner();
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit } = await resolveGas({ from: eoa, to: CPI_PRECOMPILE, data: calldata, priorityFeeGwei }, chain.evmRpc);
  const tx = await signer.sendTransaction({ to: CPI_PRECOMPILE, data: calldata, type: 2, maxFeePerGas, maxPriorityFeePerGas, gasLimit, value: 0n });
  await tx.wait(1);
  return tx.hash;
}

// Create the caller's ATA for `mint` (owned by their external_auth PDA) via the
// HELPER precompile directly. On the EVM lane a CPI to the ATA program's
// createIdempotent does NOT emulate (Rome only special-cases account creation
// through its own HELPER/ATA precompiles, not a third-party CPI), so the reward
// ATA is provisioned this way — the same path the DEX router uses. Verified on
// Hadrian (harness/probe-farm2.mjs). No-op when the ATA already exists.
const HELPER_ADDRESS = "0xff00000000000000000000000000000000000009";
const HELPER_IFACE = new ethers.Interface([
  "function create_ata(address user, bytes32 mint)",
  "function swap_gas_to_lamports(uint64 lamports)",
]);
async function sendEvmHelper(chain: ChainConfig, eoa: string, data: string, priorityFeeGwei?: number): Promise<void> {
  const provider = new ethers.BrowserProvider(requireEvmProvider(), { chainId: Number(chain.chainId), name: chain.name.toLowerCase() });
  const signer = await provider.getSigner();
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit } = await resolveGas({ from: eoa, to: HELPER_ADDRESS, data, priorityFeeGwei }, chain.evmRpc);
  const tx = await signer.sendTransaction({ to: HELPER_ADDRESS, data, type: 2, maxFeePerGas, maxPriorityFeePerGas, gasLimit, value: 0n });
  await tx.wait(1);
}
async function evmCreateAta(chain: ChainConfig, eoa: string, mint: PublicKey, priorityFeeGwei?: number): Promise<void> {
  await sendEvmHelper(chain, eoa, HELPER_IFACE.encodeFunctionData("create_ata", [eoa, "0x" + mint.toBuffer().toString("hex")]), priorityFeeGwei);
}
// One-time rent bootstrap for a cold external_auth PDA — it pays the UserStake
// account's rent inside InitUserStake. Same floor/topup as the CLMM open flow.
const PDA_RENT_FLOOR = 3_000_000n;
const PDA_RENT_TOPUP = 12_000_000n;
async function evmEnsurePdaLamports(chain: ChainConfig, eoa: string, owner: PublicKey, priorityFeeGwei?: number): Promise<void> {
  const res = await fetch(chain.solanaRpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [owner.toBase58(), { commitment: "confirmed" }] }),
  });
  const lamports = BigInt((await res.json())?.result?.value ?? 0);
  if (lamports < PDA_RENT_FLOOR) {
    await sendEvmHelper(chain, eoa, HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [PDA_RENT_TOPUP]), priorityFeeGwei);
  }
}

// ============================================================
// PUBLIC DUAL-LANE WRITES
// ============================================================

export type Lane = "evm" | "solana";

export interface FarmWriteParams {
  chain: ChainConfig;
  lane: Lane;
  /** EOA (0x…) for the EVM lane, or base58 pubkey for the Solana lane. */
  address: string;
  amount?: bigint;
  priorityFeeGwei?: number;
  /** Called before a one-time setup tx (UserStake init / reward-ATA create). */
  onSetup?: (msg: string) => void;
}

/** Resolve the staking authority for a lane: EVM → external_auth PDA, Solana → the pubkey. */
export function authorityFor(chain: ChainConfig, lane: Lane, address: string): PublicKey {
  return lane === "evm" ? evmPdaFor(address, chain.romeEvmProgramId) : new PublicKey(address);
}

/** Stake LP into the farm. Creates the UserStake PDA first if it does not exist. */
export async function stakeLP(p: FarmWriteParams): Promise<string> {
  const { chain } = p;
  const fc = farmConfig(chain);
  const amount = p.amount!;
  const authority = authorityFor(chain, p.lane, p.address);
  const ustake = userStakePda(fc, authority);
  const userLp = await ataFor(authority, fc.lpMint);
  const needInit = !(await userStakeExists(chain, authority));

  if (p.lane === "solana") {
    const ixs: TransactionInstruction[] = [];
    if (needInit) ixs.push(farmIx(fc.farmProgram, initUserStakeAccounts(fc, authority, ustake, authority), initUserStakeData()));
    ixs.push(farmIx(fc.farmProgram, stakeAccounts(fc, authority, ustake, userLp), stakeData(amount)));
    return sendSolana(chain.solanaRpc, ixs, authority);
  }
  // EVM lane, MEASURED 2026-07-09 (fresh wallet on live Hadrian): InitUserStake
  // LANDS via the CPI precompile once the external_auth PDA holds rent lamports
  // — the proxy DOES materialise the farm program's created account (the old
  // "third-party creates never emulate" constraint is stale; a cold PDA fails
  // with Custom(1) = the payer can't fund rent, which read as a discovery wall).
  // So the one-time setup is: rent bootstrap (if cold) → InitUserStake → Stake.
  if (needInit) {
    p.onSetup?.("One-time staking setup…");
    await evmEnsurePdaLamports(chain, p.address, authority, p.priorityFeeGwei);
    await sendEvmInvoke(chain, p.address, initUserStakeAccounts(fc, authority, ustake, authority), initUserStakeData(), fc.farmProgram, p.priorityFeeGwei);
  }
  return sendEvmInvoke(chain, p.address, stakeAccounts(fc, authority, ustake, userLp), stakeData(amount), fc.farmProgram, p.priorityFeeGwei);
}

/** Unstake LP back to the staker's LP ATA. */
export async function unstakeLP(p: FarmWriteParams): Promise<string> {
  const { chain } = p;
  const fc = farmConfig(chain);
  const amount = p.amount!;
  const authority = authorityFor(chain, p.lane, p.address);
  const ustake = userStakePda(fc, authority);
  const userLp = await ataFor(authority, fc.lpMint);

  if (p.lane === "solana") {
    return sendSolana(chain.solanaRpc, [farmIx(fc.farmProgram, unstakeAccounts(fc, authority, ustake, userLp), unstakeData(amount))], authority);
  }
  return sendEvmInvoke(chain, p.address, unstakeAccounts(fc, authority, ustake, userLp), unstakeData(amount), fc.farmProgram, p.priorityFeeGwei);
}

/** Claim accrued RDX to the staker's reward ATA (creating it first if needed). */
export async function claimRewards(p: FarmWriteParams): Promise<string> {
  const { chain } = p;
  const fc = farmConfig(chain);
  const authority = authorityFor(chain, p.lane, p.address);
  const ustake = userStakePda(fc, authority);
  const userReward = await ataFor(authority, fc.rewardMint);
  const rewardAtaData = await accountData(chain.solanaRpc, userReward);
  const needAta = rewardAtaData === null;

  if (p.lane === "solana") {
    const ixs: TransactionInstruction[] = [];
    if (needAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(authority, userReward, authority, fc.rewardMint));
    ixs.push(farmIx(fc.farmProgram, claimAccounts(fc, authority, ustake, userReward), claimData()));
    return sendSolana(chain.solanaRpc, ixs, authority);
  }
  // EVM: create the reward ATA (owned by the external_auth PDA) via the HELPER
  // precompile, then claim. Both in-flow, user-signed — no pre-creation.
  if (needAta) {
    p.onSetup?.("Creating your reward account…");
    await evmCreateAta(chain, p.address, fc.rewardMint, p.priorityFeeGwei);
  }
  return sendEvmInvoke(chain, p.address, claimAccounts(fc, authority, ustake, userReward), claimData(), fc.farmProgram, p.priorityFeeGwei);
}

/** LP balance (raw) available to stake for a lane's authority. */
export async function stakeableLp(chain: ChainConfig, lane: Lane, address: string): Promise<bigint> {
  const fc = farmConfig(chain);
  const authority = authorityFor(chain, lane, address);
  const ata = await ataFor(authority, fc.lpMint);
  const res = await fetch(chain.solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [ata.toBase58()] }),
  });
  const amt = (await res.json())?.result?.value?.amount;
  return amt ? BigInt(amt) : 0n;
}
