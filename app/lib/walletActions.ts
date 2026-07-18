/**
 * walletActions.ts — client-side transaction builders for both wallet lanes.
 *
 * EVM lane:
 *   Encodes a CPI invoke() call to 0xFF..08. The connected EOA's external_auth
 *   PDA is authority (index 2). Rome auto-signs via the PDA bump.
 *
 * Solana lane:
 *   Builds a plain Solana Transaction mirroring exactly the account layout from
 *   harness/lib.mjs. The connected Solana wallet pubkey is user_transfer_authority
 *   (signer at account index 2), using the user's own ATAs.
 *
 * No keys are held here — all signing is delegated to the wallet.
 */

import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ethers } from "ethers";
import { deriveAuthorityPda, deriveAta, encodeInvoke, CPI_PRECOMPILE as SDK_CPI_PRECOMPILE } from "@rome-protocol/sdk";
import { resolveGas } from "./gas";
import { ensureAtaIxs, wrapSolIxs, isNativeMint } from "./solPrep";
import { getActiveSolWallet } from "./solWallet";
import { requireEvmProvider } from "./evmWallet";
import { ataBalance } from "./balances";
import type { ChainConfig } from "./chains/types";

// ---- chain-agnostic constants ----
// The CPI precompile address (0xFF..08) is sourced from @rome-protocol/sdk.
export const CPI_PRECOMPILE = SDK_CPI_PRECOMPILE;
const TOKEN = TOKEN_PROGRAM_ID;

// Pool constants — a decoded fee-tier pool of a specific pair (mirror
// chain.ts / the active chain's dex.tiers). Every pool carries its pair identity
// so the app is multi-pair: the same tier label (e.g. "0.30%") exists across
// pairs, so resolution is always (pairId, tier), and `poolId` is the
// globally-unique route id.
export interface Pool {
  pairId: string;
  pairName: string;
  poolId: number;
  tier: string;
  bps: number;
  program: PublicKey;
  swapState: PublicKey;
  authority: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  poolMint: PublicKey;
  feeAccount: PublicKey;
  symbolA: string;
  symbolB: string;
  decimalsA: number;
  decimalsB: number;
}

interface RawTier {
  pairId?: string; pairName?: string; poolId?: number;
  tier: string; bps: number; program: string; swapState: string; authority: string;
  mintA: string; mintB: string; vaultA: string; vaultB: string; poolMint: string; feeAccount: string;
  decimalsA?: number; decimalsB?: number;
  symbols?: { A?: string; B?: string }; symbolA?: string; symbolB?: string;
}

const symA = (t: RawTier) => t.symbols?.A ?? t.symbolA ?? "A";
const symB = (t: RawTier) => t.symbols?.B ?? t.symbolB ?? "B";

function decodePool(t: RawTier): Pool {
  const a = symA(t), b = symB(t);
  return {
    pairId: t.pairId ?? `${a}-${b}`,
    pairName: t.pairName ?? `${a} / ${b}`,
    poolId: t.poolId ?? t.bps,
    tier: t.tier, bps: t.bps,
    program: new PublicKey(t.program), swapState: new PublicKey(t.swapState), authority: new PublicKey(t.authority),
    mintA: new PublicKey(t.mintA), mintB: new PublicKey(t.mintB),
    vaultA: new PublicKey(t.vaultA), vaultB: new PublicKey(t.vaultB),
    poolMint: new PublicKey(t.poolMint), feeAccount: new PublicKey(t.feeAccount),
    symbolA: a, symbolB: b,
    decimalsA: t.decimalsA ?? 6, decimalsB: t.decimalsB ?? 9,
  };
}

// Every pool across every pair for a chain, in config order (ordered by pair,
// then bps). Sourced from the active chain's dex.tiers.
export function tiersOf(chain: ChainConfig): Pool[] {
  return (chain.dex.tiers as unknown as RawTier[]).map(decodePool);
}

// A tradeable pair = its identity + the set of fee-tier pools that exist for it.
export interface Pair {
  pairId: string;
  pairName: string;
  symbolA: string;
  symbolB: string;
  decimalsA: number;
  decimalsB: number;
  mintA: PublicKey;
  mintB: PublicKey;
  tiers: Pool[];
}

// Derive the pair list for a chain (dedup by pairId, preserving first-seen order).
export function pairsOf(chain: ChainConfig): Pair[] {
  const byId = new Map<string, Pair>();
  for (const p of tiersOf(chain)) {
    let pair = byId.get(p.pairId);
    if (!pair) {
      pair = {
        pairId: p.pairId, pairName: p.pairName,
        symbolA: p.symbolA, symbolB: p.symbolB,
        decimalsA: p.decimalsA, decimalsB: p.decimalsB,
        mintA: p.mintA, mintB: p.mintB, tiers: [],
      };
      byId.set(p.pairId, pair);
    }
    pair.tiers.push(p);
  }
  return [...byId.values()];
}

export function defaultPairId(chain: ChainConfig): string {
  return pairsOf(chain)[0]?.pairId ?? "USDC-SOL";
}

export function pairById(chain: ChainConfig, pairId?: string | null): Pair {
  const pairs = pairsOf(chain);
  return pairs.find((p) => p.pairId === pairId) ?? pairs[0];
}

// Symbols for the default pair (home hero + LegStrip).
export function poolSymbols(chain: ChainConfig): { A: string; B: string } {
  const first = pairsOf(chain)[0];
  return { A: first?.symbolA ?? "A", B: first?.symbolB ?? "B" };
}

// Resolve (pairId, tier) to a pool. Defaults: default pair, then its 0.30% tier.
export function poolForTier(chain: ChainConfig, tier?: string | null, pairId?: string | null): Pool {
  const tiers = tiersOf(chain);
  const pid = pairId ?? defaultPairId(chain);
  const inPair = tiers.filter((t) => t.pairId === pid);
  return (
    inPair.find((t) => t.tier === tier) ??
    inPair.find((t) => t.tier === "0.30%") ??
    inPair[0] ?? tiers[0]
  );
}

// ---- encoding helpers ----
function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

export function swapExactInData(amountIn: bigint, minOut: bigint): Buffer {
  return Buffer.concat([Buffer.from([1]), u64le(amountIn), u64le(minOut)]);
}
export function swapExactOutData(amountOut: bigint, maxIn: bigint): Buffer {
  return Buffer.concat([Buffer.from([6]), u64le(amountOut), u64le(maxIn)]);
}
export function depositData(lp: bigint, maxA: bigint, maxB: bigint): Buffer {
  return Buffer.concat([Buffer.from([2]), u64le(lp), u64le(maxA), u64le(maxB)]);
}
export function withdrawData(lp: bigint, minA: bigint, minB: bigint): Buffer {
  return Buffer.concat([Buffer.from([3]), u64le(lp), u64le(minA), u64le(minB)]);
}

// ---- PDA derivation ----

/** Derive the external_auth PDA for an EVM EOA (EIP-55 or lowercase 0x... accepted). */
export function evmPdaFor(eoa: string, romeEvmProgramId: string): PublicKey {
  return deriveAuthorityPda(eoa, romeEvmProgramId);
}

/** Derive an ATA for `owner` (PublicKey) and `mint` (PublicKey). */
export async function ataFor(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
  return deriveAta(owner, mint);
}

// ---- 14-account swap layout (mirrors harness/lib.mjs swapAccountsFor) ----

export type AccMeta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };

export function buildSwapAccounts(
  dir: "AtoB" | "BtoA",
  authority: PublicKey,
  srcAta: PublicKey,
  dstAta: PublicKey,
  pool: Pool,
): AccMeta[] {
  const [srcVault, dstVault, srcMint, dstMint] =
    dir === "AtoB"
      ? [pool.vaultA, pool.vaultB, pool.mintA, pool.mintB]
      : [pool.vaultB, pool.vaultA, pool.mintB, pool.mintA];

  return [
    { pubkey: pool.swapState, isSigner: false, isWritable: false },
    { pubkey: pool.authority, isSigner: false, isWritable: false },
    { pubkey: authority,      isSigner: true,  isWritable: false },
    { pubkey: srcAta,         isSigner: false, isWritable: true  },
    { pubkey: srcVault,       isSigner: false, isWritable: true  },
    { pubkey: dstVault,       isSigner: false, isWritable: true  },
    { pubkey: dstAta,         isSigner: false, isWritable: true  },
    { pubkey: pool.poolMint,  isSigner: false, isWritable: true  },
    { pubkey: pool.feeAccount,isSigner: false, isWritable: true  },
    { pubkey: srcMint,        isSigner: false, isWritable: false },
    { pubkey: dstMint,        isSigner: false, isWritable: false },
    { pubkey: TOKEN,          isSigner: false, isWritable: false },
    { pubkey: TOKEN,          isSigner: false, isWritable: false },
    { pubkey: TOKEN,          isSigner: false, isWritable: false },
  ];
}

export function buildDepositAccounts(
  authority: PublicKey,
  uA: PublicKey,
  uB: PublicKey,
  uLp: PublicKey,
  pool: Pool,
): AccMeta[] {
  return [
    { pubkey: pool.swapState, isSigner: false, isWritable: false },
    { pubkey: pool.authority, isSigner: false, isWritable: false },
    { pubkey: authority,      isSigner: true,  isWritable: false },
    { pubkey: uA,             isSigner: false, isWritable: true  },
    { pubkey: uB,             isSigner: false, isWritable: true  },
    { pubkey: pool.vaultA,    isSigner: false, isWritable: true  },
    { pubkey: pool.vaultB,    isSigner: false, isWritable: true  },
    { pubkey: pool.poolMint,  isSigner: false, isWritable: true  },
    { pubkey: uLp,            isSigner: false, isWritable: true  },
    { pubkey: pool.mintA,     isSigner: false, isWritable: false },
    { pubkey: pool.mintB,     isSigner: false, isWritable: false },
    { pubkey: TOKEN,          isSigner: false, isWritable: false },
    { pubkey: TOKEN,          isSigner: false, isWritable: false },
    { pubkey: TOKEN,          isSigner: false, isWritable: false },
  ];
}

export function buildWithdrawAccounts(
  authority: PublicKey,
  uLp: PublicKey,
  uA: PublicKey,
  uB: PublicKey,
  pool: Pool,
): AccMeta[] {
  return [
    { pubkey: pool.swapState,  isSigner: false, isWritable: false },
    { pubkey: pool.authority,  isSigner: false, isWritable: false },
    { pubkey: authority,       isSigner: true,  isWritable: false },
    { pubkey: pool.poolMint,   isSigner: false, isWritable: true  },
    { pubkey: uLp,             isSigner: false, isWritable: true  },
    { pubkey: pool.vaultA,     isSigner: false, isWritable: true  },
    { pubkey: pool.vaultB,     isSigner: false, isWritable: true  },
    { pubkey: uA,              isSigner: false, isWritable: true  },
    { pubkey: uB,              isSigner: false, isWritable: true  },
    { pubkey: pool.feeAccount, isSigner: false, isWritable: true  },
    { pubkey: pool.mintA,      isSigner: false, isWritable: false },
    { pubkey: pool.mintB,      isSigner: false, isWritable: false },
    { pubkey: TOKEN,           isSigner: false, isWritable: false },
    { pubkey: TOKEN,           isSigner: false, isWritable: false },
    { pubkey: TOKEN,           isSigner: false, isWritable: false },
  ];
}

// ============================================================
// EVM LANE — the EVM wallet signs an eth_sendTransaction to 0xFF..08
// ============================================================

/** Build invoke() calldata for the CPI precompile targeting `program`. */
export function buildEvmCalldata(accounts: AccMeta[], data: Buffer, program: PublicKey): string {
  return encodeInvoke(program, accounts, `0x${data.toString("hex")}`);
}

/**
 * Ensure the connected EVM wallet is on `chain`'s network, switching (or adding,
 * on 4902) as needed. Call on chain-switch and before EVM-lane writes so a tx
 * never lands on the wrong network. Throws if the user rejects the switch.
 */
export async function ensureEvmNetwork(chain: ChainConfig): Promise<void> {
  const eth = requireEvmProvider();
  const hexId = "0x" + Number(chain.chainId).toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: `Rome ${chain.name}`,
          rpcUrls: [chain.evmRpc],
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          blockExplorerUrls: [chain.explorerBase.replace(/\/tx$/, "")],
        }],
      });
    } else {
      throw e;
    }
  }
}

export interface EvmSwapParams {
  /** The active chain config. */
  chain: ChainConfig;
  /** Connected EOA (0x...). */
  eoa: string;
  dir: "AtoB" | "BtoA";
  mode: "exactIn" | "exactOut";
  /** Fee-tier label (e.g. "0.05%"); defaults to the 0.30% tier. */
  tier?: string;
  /** Pair id (e.g. "USDC-SOL"); defaults to the default pair. */
  pairId?: string;
  amountIn?: bigint;   // exactIn
  minOut?: bigint;     // exactIn
  amountOut?: bigint;  // exactOut
  maxIn?: bigint;      // exactOut
  /** User-chosen priority tip (gwei). Omitted → congestion-aware network default. */
  priorityFeeGwei?: number;
}

/**
 * Execute a swap via EVM lane.
 * Returns the EVM tx hash on success.
 */
export async function evmSwap(params: EvmSwapParams): Promise<string> {
  const { chain, eoa, dir, mode, tier, pairId, amountIn, minOut, amountOut, maxIn, priorityFeeGwei } = params;
  // Route to the selected pair + fee tier's pool.
  const pool = poolForTier(chain, tier, pairId);
  // Derive authority PDA for EOA
  const pda = evmPdaFor(eoa, chain.romeEvmProgramId);
  // Use PDA's ATAs as src/dst (same as server-side chain.ts)
  const srcMint = dir === "AtoB" ? pool.mintA : pool.mintB;
  const dstMint = dir === "AtoB" ? pool.mintB : pool.mintA;
  const srcAta = await ataFor(pda, srcMint);
  const dstAta = await ataFor(pda, dstMint);

  const accounts = buildSwapAccounts(dir, pda, srcAta, dstAta, pool);
  const data = mode === "exactIn"
    ? swapExactInData(amountIn!, minOut ?? 0n)
    : swapExactOutData(amountOut!, maxIn ?? 0n);

  const calldata = buildEvmCalldata(accounts, data, pool.program);

  // Use ethers BrowserProvider to send through the EVM wallet
  const provider = new ethers.BrowserProvider(requireEvmProvider(), {
    chainId: Number(chain.chainId),
    name: chain.name.toLowerCase(),
  });
  const signer = await provider.getSigner();
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit } = await resolveGas({ from: eoa, to: CPI_PRECOMPILE, data: calldata, priorityFeeGwei }, chain.evmRpc);
  const tx = await signer.sendTransaction({
    to: CPI_PRECOMPILE,
    data: calldata,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    value: 0n,
  });
  await tx.wait(1);
  return tx.hash;
}

export interface SolanaSwapParams {
  /** The active chain config. */
  chain: ChainConfig;
  /** Connected the Solana wallet public key (base58). */
  userPubkey: string;
  dir: "AtoB" | "BtoA";
  mode: "exactIn" | "exactOut";
  /** Fee-tier label (e.g. "0.05%"); defaults to the 0.30% tier. */
  tier?: string;
  /** Pair id (e.g. "USDC-SOL"); defaults to the default pair. */
  pairId?: string;
  amountIn?: bigint;   // exactIn
  minOut?: bigint;     // exactIn
  amountOut?: bigint;  // exactOut
  maxIn?: bigint;      // exactOut
  /** Flow-tracking callback: the wallet prompt is about to open. */
  onStage?: (stage: "sign") => void;
}

// ============================================================
// SOLANA LANE — the Solana wallet signs a native Solana Transaction
// ============================================================

/**
 * Execute a swap via Solana lane.
 * The connected pubkey is the user_transfer_authority (signer at idx 2).
 * The user's own ATAs are used as src/dst.
 * Returns the Solana tx signature on success.
 */
export async function solanaSwap(params: SolanaSwapParams): Promise<string> {
  const { chain, userPubkey, dir, mode, tier, pairId, amountIn, minOut, amountOut, maxIn } = params;
  const sol = getActiveSolWallet();
  if (!sol) throw new Error("Solana wallet not connected");

  // Route to the selected pair + fee tier's pool.
  const pool = poolForTier(chain, tier, pairId);
  const authority = new PublicKey(userPubkey);
  const srcMint = dir === "AtoB" ? pool.mintA : pool.mintB;
  const dstMint = dir === "AtoB" ? pool.mintB : pool.mintA;
  const srcAta = await ataFor(authority, srcMint);
  const dstAta = await ataFor(authority, dstMint);

  const accounts = buildSwapAccounts(dir, authority, srcAta, dstAta, pool);
  const data = mode === "exactIn"
    ? swapExactInData(amountIn!, minOut ?? 0n)
    : swapExactOutData(amountOut!, maxIn ?? 0n);

  // In-flow account prep (brand-new-wallet rule): ensure the destination ATA
  // (and source, when it's wSOL) exists, and wrap plain SOL to cover a native
  // input. Idempotent — no-ops for returning users.
  const prepIxs = ensureAtaIxs(authority, isNativeMint(srcMint) ? [srcMint, dstMint] : [dstMint]);
  if (isNativeMint(srcMint)) {
    const needIn = mode === "exactIn" ? amountIn! : maxIn ?? 0n;
    prepIxs.push(...wrapSolIxs(authority, needIn, await ataBalance(chain.solanaRpc, srcAta)));
  }

  const ix = new TransactionInstruction({
    programId: pool.program,
    keys: accounts,
    data,
  });

  // Fetch a recent blockhash from the Solana RPC
  const bhRes = await fetch(chain.solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
  });
  const bhData = await bhRes.json();
  const { blockhash, lastValidBlockHeight } = bhData.result.value;

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: authority,
  });
  for (const p of prepIxs) tx.add(p);
  tx.add(ix);

  // The Solana wallet SIGNS only; the app submits to Rome's substrate RPC (SOL_RPC).
  // signAndSendTransaction would broadcast via the wallet-default public cluster (public
  // mainnet/devnet), where the rome-dex pool doesn't exist → "unexpected error".
  params.onStage?.("sign");
  const signedTx = await sol.signTransaction(tx);
  const sendRes = await fetch(chain.solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [signedTx.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }] }),
  });
  const sendJson = await sendRes.json();
  if (sendJson.error) throw new Error(sendJson.error.message || JSON.stringify(sendJson.error));
  const signed = { signature: sendJson.result as string };
  // Wait for confirmation
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(chain.solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[signed.signature], { searchTransactionHistory: true }] }),
    });
    const s = await statusRes.json();
    const conf = s.result?.value?.[0]?.confirmationStatus;
    if (conf === "confirmed" || conf === "finalized") break;
    // If block height exceeded, bail early
    const slotRes = await fetch(chain.solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] }),
    });
    const slot = (await slotRes.json()).result;
    if (slot > lastValidBlockHeight) throw new Error("Transaction expired (block height exceeded)");
  }
  return signed.signature;
}

// ============================================================
// EVM LANE — Deposit / Withdraw (the EVM wallet)
// ============================================================

export interface EvmDepositParams {
  chain: ChainConfig;
  eoa: string;
  tier?: string;
  pairId?: string;
  lp: bigint;
  maxA: bigint;
  maxB: bigint;
  /** User-chosen priority tip (gwei). Omitted → congestion-aware network default. */
  priorityFeeGwei?: number;
}

export async function evmDeposit(params: EvmDepositParams): Promise<string> {
  const { chain, eoa, tier, pairId, lp, maxA, maxB, priorityFeeGwei } = params;
  const pool = poolForTier(chain, tier, pairId);
  const pda = evmPdaFor(eoa, chain.romeEvmProgramId);
  const uA = await ataFor(pda, pool.mintA);
  const uB = await ataFor(pda, pool.mintB);
  const uLp = await ataFor(pda, pool.poolMint);

  const accounts = buildDepositAccounts(pda, uA, uB, uLp, pool);
  const data = depositData(lp, maxA, maxB);
  const calldata = buildEvmCalldata(accounts, data, pool.program);

  const provider = new ethers.BrowserProvider(requireEvmProvider(), {
    chainId: Number(chain.chainId),
    name: chain.name.toLowerCase(),
  });
  const signer = await provider.getSigner();
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit } = await resolveGas({ from: eoa, to: CPI_PRECOMPILE, data: calldata, priorityFeeGwei }, chain.evmRpc);
  const tx = await signer.sendTransaction({
    to: CPI_PRECOMPILE,
    data: calldata,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    value: 0n,
  });
  await tx.wait(1);
  return tx.hash;
}

export interface EvmWithdrawParams {
  chain: ChainConfig;
  eoa: string;
  tier?: string;
  pairId?: string;
  lp: bigint;
  minA: bigint;
  minB: bigint;
  /** User-chosen priority tip (gwei). Omitted → congestion-aware network default. */
  priorityFeeGwei?: number;
}

export async function evmWithdraw(params: EvmWithdrawParams): Promise<string> {
  const { chain, eoa, tier, pairId, lp, minA, minB, priorityFeeGwei } = params;
  const pool = poolForTier(chain, tier, pairId);
  const pda = evmPdaFor(eoa, chain.romeEvmProgramId);
  const uA = await ataFor(pda, pool.mintA);
  const uB = await ataFor(pda, pool.mintB);
  const uLp = await ataFor(pda, pool.poolMint);

  const accounts = buildWithdrawAccounts(pda, uLp, uA, uB, pool);
  const data = withdrawData(lp, minA, minB);
  const calldata = buildEvmCalldata(accounts, data, pool.program);

  const provider = new ethers.BrowserProvider(requireEvmProvider(), {
    chainId: Number(chain.chainId),
    name: chain.name.toLowerCase(),
  });
  const signer = await provider.getSigner();
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit } = await resolveGas({ from: eoa, to: CPI_PRECOMPILE, data: calldata, priorityFeeGwei }, chain.evmRpc);
  const tx = await signer.sendTransaction({
    to: CPI_PRECOMPILE,
    data: calldata,
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    value: 0n,
  });
  await tx.wait(1);
  return tx.hash;
}

// ============================================================
// SOLANA LANE — Deposit / Withdraw (the Solana wallet)
// ============================================================

export interface SolanaDepositParams {
  chain: ChainConfig;
  userPubkey: string;
  tier?: string;
  pairId?: string;
  lp: bigint;
  maxA: bigint;
  maxB: bigint;
  /** Flow-tracking callback: the wallet prompt is about to open. */
  onSign?: () => void;
}

export async function solanaDeposit(params: SolanaDepositParams): Promise<string> {
  const { chain, userPubkey, tier, pairId, lp, maxA, maxB } = params;
  const sol = getActiveSolWallet();
  if (!sol) throw new Error("Solana wallet not connected");

  const pool = poolForTier(chain, tier, pairId);
  const authority = new PublicKey(userPubkey);
  const uA = await ataFor(authority, pool.mintA);
  const uB = await ataFor(authority, pool.mintB);
  const uLp = await ataFor(authority, pool.poolMint);

  const accounts = buildDepositAccounts(authority, uA, uB, uLp, pool);
  const data = depositData(lp, maxA, maxB);

  // In-flow account prep (brand-new-wallet rule): the LP-mint ATA never exists
  // for a first-time LP — create A/B/LP idempotently, and wrap plain SOL to
  // cover a native-side deposit.
  const prepIxs = ensureAtaIxs(authority, [pool.mintA, pool.mintB, pool.poolMint]);
  if (isNativeMint(pool.mintA)) prepIxs.push(...wrapSolIxs(authority, maxA, await ataBalance(chain.solanaRpc, uA)));
  if (isNativeMint(pool.mintB)) prepIxs.push(...wrapSolIxs(authority, maxB, await ataBalance(chain.solanaRpc, uB)));

  const ix = new TransactionInstruction({
    programId: pool.program,
    keys: accounts,
    data,
  });

  const bhRes = await fetch(chain.solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
  });
  const bhData = await bhRes.json();
  const { blockhash, lastValidBlockHeight } = bhData.result.value;

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: authority,
  });
  for (const p of prepIxs) tx.add(p);
  tx.add(ix);

  // The Solana wallet SIGNS only; the app submits to Rome's substrate RPC (SOL_RPC).
  // signAndSendTransaction would broadcast via the wallet-default public cluster (public
  // mainnet/devnet), where the rome-dex pool doesn't exist → "unexpected error".
  params.onSign?.();
  const signedTx = await sol.signTransaction(tx);
  const sendRes = await fetch(chain.solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [signedTx.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }] }),
  });
  const sendJson = await sendRes.json();
  if (sendJson.error) throw new Error(sendJson.error.message || JSON.stringify(sendJson.error));
  const signed = { signature: sendJson.result as string };

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(chain.solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[signed.signature], { searchTransactionHistory: true }] }),
    });
    const s = await statusRes.json();
    const conf = s.result?.value?.[0]?.confirmationStatus;
    if (conf === "confirmed" || conf === "finalized") break;
    const slotRes = await fetch(chain.solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] }),
    });
    const slot = (await slotRes.json()).result;
    if (slot > lastValidBlockHeight) throw new Error("Transaction expired (block height exceeded)");
  }
  return signed.signature;
}

export interface SolanaWithdrawParams {
  chain: ChainConfig;
  userPubkey: string;
  tier?: string;
  pairId?: string;
  lp: bigint;
  minA: bigint;
  minB: bigint;
  /** Flow-tracking callback: the wallet prompt is about to open. */
  onSign?: () => void;
}

export async function solanaWithdraw(params: SolanaWithdrawParams): Promise<string> {
  const { chain, userPubkey, tier, pairId, lp, minA, minB } = params;
  const sol = getActiveSolWallet();
  if (!sol) throw new Error("Solana wallet not connected");

  const pool = poolForTier(chain, tier, pairId);
  const authority = new PublicKey(userPubkey);
  const uA = await ataFor(authority, pool.mintA);
  const uB = await ataFor(authority, pool.mintB);
  const uLp = await ataFor(authority, pool.poolMint);

  const accounts = buildWithdrawAccounts(authority, uLp, uA, uB, pool);
  const data = withdrawData(lp, minA, minB);

  // In-flow account prep: output A/B ATAs may not exist (e.g. LP tokens
  // received by transfer). Idempotent — no-ops for returning users.
  const prepIxs = ensureAtaIxs(authority, [pool.mintA, pool.mintB]);

  const ix = new TransactionInstruction({
    programId: pool.program,
    keys: accounts,
    data,
  });

  const bhRes = await fetch(chain.solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
  });
  const bhData = await bhRes.json();
  const { blockhash, lastValidBlockHeight } = bhData.result.value;

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: authority,
  });
  for (const p of prepIxs) tx.add(p);
  tx.add(ix);

  // The Solana wallet SIGNS only; the app submits to Rome's substrate RPC (SOL_RPC).
  // signAndSendTransaction would broadcast via the wallet-default public cluster (public
  // mainnet/devnet), where the rome-dex pool doesn't exist → "unexpected error".
  params.onSign?.();
  const signedTx = await sol.signTransaction(tx);
  const sendRes = await fetch(chain.solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [signedTx.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }] }),
  });
  const sendJson = await sendRes.json();
  if (sendJson.error) throw new Error(sendJson.error.message || JSON.stringify(sendJson.error));
  const signed = { signature: sendJson.result as string };

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(chain.solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[signed.signature], { searchTransactionHistory: true }] }),
    });
    const s = await statusRes.json();
    const conf = s.result?.value?.[0]?.confirmationStatus;
    if (conf === "confirmed" || conf === "finalized") break;
    const slotRes = await fetch(chain.solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] }),
    });
    const slot = (await slotRes.json()).result;
    if (slot > lastValidBlockHeight) throw new Error("Transaction expired (block height exceeded)");
  }
  return signed.signature;
}

// Type augmentation for window.ethereum and window.solana
declare global {
  interface Window {
    ethereum?: ethers.Eip1193Provider & {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    solana?: {
      isPhantom?: boolean;
      connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
      disconnect: () => Promise<void>;
      signTransaction: (tx: Transaction) => Promise<Transaction>;
      signAndSendTransaction: (tx: Transaction) => Promise<{ signature: string }>;
      publicKey?: { toString(): string } | null;
    };
  }
}
