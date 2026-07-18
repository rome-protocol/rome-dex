/**
 * orders.ts — Solana-lane client for the native rome-dex orders program
 * (limit orders + DCA). Program id ordWTzt…, deployed + proven on-chain
 * (harness/orders.test.mjs). This module mirrors that harness byte-for-byte:
 *   • instruction encodings  (Place tag 0, Cancel tag 2)
 *   • account layouts        (Place = 11, Cancel = 5)
 *   • the 230-byte Order account parse (harness/keeper.mjs parseOrder)
 *
 * Solana lane only: the connected Solana wallet pubkey is the order owner
 * and the fee payer; escrows are ATAs owned by the order PDA (off-curve). No
 * keys held here — signing is delegated to the wallet, and the app submits the
 * signed tx to Rome's substrate RPC itself (never signAndSendTransaction, which
 * would broadcast to the wallet-default public cluster where the pool doesn't exist).
 *
 * Order tracking is wallet-only (no backend): placed order PDAs are persisted
 * to localStorage keyed by owner pubkey; the open-orders table reads them back
 * and hydrates live state via getMultipleAccountsInfo (getProgramAccounts is
 * throttled on this RPC).
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { ethers } from "ethers";
import { CPI_PRECOMPILE, evmPdaFor, buildEvmCalldata, type Pool } from "./walletActions";
import { resolveGas } from "./gas";
import { requireEvmProvider } from "./evmWallet";
import { getActiveSolWallet } from "./solWallet";
import type { ChainConfig } from "./chains/types";

// ---- program constants (mirror harness/orders.test.mjs) ----
export const ORDERS_PROGRAM = new PublicKey("ordWTztCBW7fpoq6eLHQBp2aeoB17CAbmAx6FjtfQ7C");
export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
export const SYSTEM_PROGRAM = SystemProgram.programId;

/** On-chain cap on the keeper fee (bps). The program rejects anything above. */
export const MAX_KEEPER_FEE_BPS = 50;
/** Default keeper fee the app places orders with: 0.10%. */
export const KEEPER_FEE_BPS = 10;
/** Default order lifetime: 7 days. */
export const DEFAULT_EXPIRY_SECS = 7 * 24 * 60 * 60;

/** Packed Order account size (orders/src/state.rs). */
export const ORDER_LEN = 230;

/** Order status byte (offset 2). */
export enum OrderStatus {
  Open = 0,
  Filled = 1,
  Cancelled = 2,
  Expired = 3,
}

// ---- little-endian scalar encoders (mirror the harness) ----
function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function i64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
}
function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

export interface PlaceFields {
  nonce: bigint;
  bump: number;
  aToB: boolean;
  amountInTotal: bigint;
  trancheIn: bigint;
  minOutPerTranche: bigint;
  intervalSecs: bigint;
  expiryTs: bigint;
  keeperFeeBps: number;
}

/**
 * Place instruction data (tag 0). Byte-for-byte identical to the harness:
 * [0] + u64(nonce) + u8(bump) + u8(aToB) + u64(amountInTotal) + u64(trancheIn)
 *     + u64(minOutPerTranche) + u64(intervalSecs) + i64(expiryTs) + u16(keeperFeeBps)
 */
export function placeData(o: PlaceFields): Buffer {
  return Buffer.concat([
    Buffer.from([0]),
    u64le(o.nonce),
    Buffer.from([o.bump]),
    Buffer.from([o.aToB ? 1 : 0]),
    u64le(o.amountInTotal),
    u64le(o.trancheIn),
    u64le(o.minOutPerTranche),
    u64le(o.intervalSecs),
    i64le(o.expiryTs),
    u16le(o.keeperFeeBps),
  ]);
}

/** Cancel instruction data (tag 2). */
export function cancelData(): Buffer {
  return Buffer.from([2]);
}

// ---- PDA + escrow derivation ----

/** Order PDA: ["order", owner, u64le(nonce)]. */
export function orderPda(owner: PublicKey, nonce: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), owner.toBuffer(), u64le(nonce)],
    ORDERS_PROGRAM,
  );
}

/** Escrow ATA — owned by the order PDA (off-curve owner). */
export function escrowFor(mint: PublicKey, pda: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, pda, true);
}

/**
 * A user's own ATA for a mint. `allowOwnerOffCurve: true` because the owner is
 * a Solana wallet on the Solana lane (on-curve) BUT the EVM lane's owner is the
 * external_auth PDA (off-curve) — the derived address is identical either way;
 * the flag only skips the on-curve assertion that would otherwise throw
 * TokenOwnerOffCurveError for the PDA case.
 */
export function ownerAta(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}

// ---- Order account parse (mirror harness/keeper.mjs parseOrder offsets) ----

export interface ParsedOrder {
  isInitialized: boolean;
  bump: number;
  status: number; // 0 Open, 1 Filled, 2 Cancelled, 3 Expired
  owner: string;
  pool: string; // swapState
  inputEscrow: string;
  outputEscrow: string;
  dstAta: string;
  nonce: bigint;
  aToB: boolean;
  amountInTotal: bigint;
  remainingIn: bigint;
  trancheIn: bigint;
  minOutPerTranche: bigint;
  intervalSecs: bigint;
  lastExecTs: bigint;
  expiryTs: bigint;
  keeperFeeBps: number;
}

export function parseOrder(buf: Buffer): ParsedOrder {
  const pk = (o: number) => new PublicKey(buf.subarray(o, o + 32)).toBase58();
  return {
    isInitialized: buf[0] === 1,
    bump: buf[1],
    status: buf[2],
    owner: pk(3),
    pool: pk(35),
    inputEscrow: pk(67),
    outputEscrow: pk(99),
    dstAta: pk(131),
    nonce: buf.readBigUInt64LE(163),
    aToB: buf[171] === 1,
    amountInTotal: buf.readBigUInt64LE(172),
    remainingIn: buf.readBigUInt64LE(180),
    trancheIn: buf.readBigUInt64LE(188),
    minOutPerTranche: buf.readBigUInt64LE(196),
    intervalSecs: buf.readBigUInt64LE(204),
    lastExecTs: buf.readBigInt64LE(212),
    expiryTs: buf.readBigInt64LE(220),
    keeperFeeBps: buf.readUInt16LE(228),
  };
}

// ---- shared Solana-lane submit (sign via wallet, submit to SOL_RPC) ----

async function rpc<T>(solanaRpc: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(solanaRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result as T;
}

/**
 * Build → wallet-sign → submit → confirm one Solana tx. The wallet SIGNS only;
 * the app submits to Rome's substrate RPC (chain.solanaRpc). Mirrors the
 * swap/liquidity lane in walletActions.ts.
 */
async function submitSolanaTx(solanaRpc: string, ixs: TransactionInstruction[], feePayer: PublicKey, onSign?: () => void): Promise<string> {
  const wallet = getActiveSolWallet();
  if (!wallet) throw new Error("Solana wallet not connected");

  const { value } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
    solanaRpc,
    "getLatestBlockhash",
    [{ commitment: "confirmed" }],
  );

  const tx = new Transaction({ recentBlockhash: value.blockhash, feePayer });
  for (const ix of ixs) tx.add(ix);

  onSign?.();
  const signed = await wallet.signTransaction(tx);
  const signature = await rpc<string>(solanaRpc, "sendTransaction", [
    signed.serialize().toString("base64"),
    { encoding: "base64", preflightCommitment: "confirmed" },
  ]);

  // Poll for confirmation, bailing if the blockhash expires.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await rpc<{ value: ({ confirmationStatus?: string } | null)[] }>(
      solanaRpc,
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
    );
    const conf = status.value?.[0]?.confirmationStatus;
    if (conf === "confirmed" || conf === "finalized") break;
    const height = await rpc<number>(solanaRpc, "getBlockHeight", []);
    if (height > value.lastValidBlockHeight) throw new Error("Transaction expired (block height exceeded)");
  }
  return signature;
}

// ---- place ----

export interface PlaceOrderParams {
  /** Connected Solana wallet pubkey (base58) — order owner + fee payer. */
  ownerPubkey: string;
  /** The pool this order routes through (resolved from the chain's dex.tiers). */
  pool: Pool;
  /** true = sell mintA for mintB. */
  aToB: boolean;
  amountInTotal: bigint;
  /** Per-fill input. Equals amountInTotal for a one-shot limit order. */
  trancheIn: bigint;
  /** Slippage floor per tranche (dst smallest unit). 0 = market (no floor). */
  minOutPerTranche: bigint;
  /** DCA cadence. 0 = one-shot (fill as soon as the limit is reachable). */
  intervalSecs: bigint;
  /** Override the default 0.10% keeper fee (bps, ≤ MAX_KEEPER_FEE_BPS). */
  keeperFeeBps?: number;
  /** Override the default now+7d expiry (unix seconds). */
  expiryTs?: bigint;
  /** Flow-tracking callback: the wallet prompt is about to open. */
  onSign?: () => void;
}

export interface PlaceOrderResult {
  signature: string;
  pda: string;
  nonce: bigint;
}

/**
 * Place a limit / DCA order on the Solana lane. The sole (input) escrow ATA is
 * created in-flow (idempotent) as part of the same tx. The owner's destination
 * ATA is NOT created here — the swap output lands in it only at Execute, which
 * the keeper provisions (fee-from-input model, no output escrow). Returns the tx
 * signature + the order PDA + nonce so the caller can persist it.
 */
export async function placeOrder(chain: ChainConfig, params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const { pool, aToB, amountInTotal, trancheIn, minOutPerTranche, intervalSecs } = params;
  const owner = new PublicKey(params.ownerPubkey);

  const nonce = BigInt(Date.now());
  const [pda, bump] = orderPda(owner, nonce);

  const srcMint = aToB ? pool.mintA : pool.mintB;
  const dstMint = aToB ? pool.mintB : pool.mintA;

  const inEscrow = escrowFor(srcMint, pda);
  const ownerSrc = ownerAta(srcMint, owner);
  const ownerDst = ownerAta(dstMint, owner);

  const keeperFeeBps = params.keeperFeeBps ?? KEEPER_FEE_BPS;
  const expiryTs = params.expiryTs ?? BigInt(Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECS);

  // In-flow creation (idempotent): only the (input) PDA-owned escrow. ownerSrc
  // must already hold the input — you can't place an order without funds. The
  // owner's dst ATA is deferred to Execute (keeper-provisioned).
  const prep = [
    createAssociatedTokenAccountIdempotentInstruction(owner, inEscrow, pda, srcMint),
  ];

  const acc = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  const place = new TransactionInstruction({
    programId: ORDERS_PROGRAM,
    keys: [
      acc(pda, false, true),       // order
      acc(owner, true, false),     // owner (authority)
      acc(inEscrow, false, true),  // input escrow (the sole escrow now)
      acc(ownerSrc, false, true),  // owner source ATA (debited)
      acc(ownerDst, false, false), // owner dest ATA (recorded as dstAta)
      acc(srcMint, false, false),
      acc(dstMint, false, false),
      acc(pool.swapState, false, false),
      acc(owner, true, true),      // payer = owner (rent for the order account)
      acc(TOKEN_PROGRAM, false, false),
      acc(SYSTEM_PROGRAM, false, false),
    ],
    data: placeData({ nonce, bump, aToB, amountInTotal, trancheIn, minOutPerTranche, intervalSecs, expiryTs, keeperFeeBps }),
  });

  const signature = await submitSolanaTx(chain.solanaRpc, [...prep, place], owner, params.onSign);
  return { signature, pda: pda.toBase58(), nonce };
}

// ---- cancel ----

/** Everything cancelOrder needs from a tracked/parsed order row. */
export interface CancelableOrder {
  pda: string;
  inputEscrow: string;
  aToB: boolean;
  pool: Pool;
}

export interface CancelOrderParams {
  ownerPubkey: string;
  order: CancelableOrder;
}

/**
 * Cancel an open order — refunds the remaining input escrow to the owner's
 * source ATA. Only the owner can cancel (they sign). The refund ATA is ensured
 * in-flow (idempotent) so a since-closed ATA can't strand the refund.
 */
export async function cancelOrder(chain: ChainConfig, params: CancelOrderParams): Promise<string> {
  const { order } = params;
  const owner = new PublicKey(params.ownerPubkey);
  const srcMint = order.aToB ? order.pool.mintA : order.pool.mintB;
  const ownerSrc = ownerAta(srcMint, owner);
  const pda = new PublicKey(order.pda);
  const inEscrow = new PublicKey(order.inputEscrow);

  const acc = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  const prep = createAssociatedTokenAccountIdempotentInstruction(owner, ownerSrc, owner, srcMint);
  const cancel = new TransactionInstruction({
    programId: ORDERS_PROGRAM,
    keys: [
      acc(pda, false, true),      // order
      acc(owner, true, true),     // owner (authority + rent-reclaim dest)
      acc(inEscrow, false, true), // input escrow
      acc(ownerSrc, false, true), // owner source ATA (refunded)
      acc(TOKEN_PROGRAM, false, false),
    ],
    data: cancelData(),
  });

  return submitSolanaTx(chain.solanaRpc, [prep, cancel], owner);
}

// ---- EVM lane (the EVM wallet via the CPI precompile) ----
// The order owner is the EVM user's external_auth PDA (Rome auto-signs it). A
// wallet-only the EVM wallet user creates the sole (input) order-PDA-owned escrow via
// HELPER create_ata_for_key (raw-pubkey owner; operator pays rent) — a raw
// ATA-program CPI would NOT emulate on the EVM lane (only Rome's native HELPER
// precompile does). Then Place goes through the CPI precompile. The owner's dst
// ATA is deferred to Execute (keeper-provisioned; fee-from-input model has no
// output escrow). Proven end-to-end wallet-only in harness/orders.test.mjs.
const HELPER_ADDRESS = "0xff00000000000000000000000000000000000009";
const HELPER_IFACE = new ethers.Interface([
  "function create_ata(address user, bytes32 mint)",
  "function create_ata_for_key(bytes32 wallet, bytes32 mint)",
  "function swap_gas_to_lamports(uint64 lamports)",
]);
const b32 = (pk: PublicKey) => "0x" + pk.toBuffer().toString("hex");

// A brand-new EVM user's external_auth PDA holds ZERO SOL (gas funding doesn't
// materialize as PDA lamports), but Place pays the order-account rent from that
// PDA. So a cold PDA must first convert a little gas → SOL lamports (self-paid,
// no operator subsidy; one-time — the PDA keeps the balance for later orders).
// Warm PDAs (already funded) skip this. Threshold covers ~a few orders' rent.
const PDA_RENT_FLOOR = 3_000_000n;   // top up when the PDA is below this
const PDA_RENT_TOPUP = 10_000_000n;  // ~0.01 SOL → ~6 orders of 230-byte rent

async function evmSend(chain: ChainConfig, eoa: string, to: string, data: string): Promise<string> {
  const provider = new ethers.BrowserProvider(requireEvmProvider(), { chainId: Number(chain.chainId), name: chain.name.toLowerCase() });
  const signer = await provider.getSigner();
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit } = await resolveGas({ from: eoa, to, data }, chain.evmRpc);
  const tx = await signer.sendTransaction({ to, data, type: 2, maxFeePerGas, maxPriorityFeePerGas, gasLimit, value: 0n });
  await tx.wait(1);
  return tx.hash;
}

export interface PlaceOrderEvmParams extends Omit<PlaceOrderParams, "ownerPubkey" | "onSign"> {
  /** Connected EVM EOA (0x…). The order owner is its external_auth PDA. */
  eoa: string;
  /** Progress callback for the multi-tx flow (account prep → place). */
  onProgress?: (msg: string) => void;
  /** Flow-tracking stage callback: setup → the account-setup prompt(s) are
   *  about to open; place → the order prompt is about to open. */
  onStage?: (stage: "setup" | "place") => void;
}

export interface PlaceOrderEvmResult {
  txHash: string;
  pda: string;
  nonce: bigint;
  /** Order owner (external_auth PDA, base58) — the localStorage tracking key. */
  owner: string;
}

/**
 * Place a limit / DCA order on the EVM lane. Creates the sole (input)
 * order-PDA-owned escrow (create_ata_for_key) via HELPER, then Place via the CPI
 * precompile. The owner's dst ATA is deferred to Execute (keeper-provisioned).
 * Returns the owner PDA so the caller tracks the order under it (the open-orders
 * table reads EVM orders by external_auth PDA).
 */
export async function placeOrderEvm(chain: ChainConfig, params: PlaceOrderEvmParams): Promise<PlaceOrderEvmResult> {
  const { eoa, pool, aToB, amountInTotal, trancheIn, minOutPerTranche, intervalSecs } = params;
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId); // order owner = external_auth PDA
  const nonce = BigInt(Date.now());
  const [pda, bump] = orderPda(owner, nonce);

  const srcMint = aToB ? pool.mintA : pool.mintB;
  const dstMint = aToB ? pool.mintB : pool.mintA;
  const inEscrow = escrowFor(srcMint, pda);
  const ownerSrc = ownerAta(srcMint, owner);
  const ownerDst = ownerAta(dstMint, owner);

  const keeperFeeBps = params.keeperFeeBps ?? KEEPER_FEE_BPS;
  const expiryTs = params.expiryTs ?? BigInt(Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECS);

  // Provision ONLY what doesn't already exist, to minimize wallet prompts.
  // Rome's ~1.4M atomic CU ceiling means an ATA-create can't bundle with the
  // place, so it's its own tx. Fee-from-input has a single escrow (the input)
  // and the owner's dst ATA is deferred to Execute (keeper-provisioned) — so a
  // fresh placement is 1 escrow-create + 1 place = 2 prompts (or just 1 place if
  // the input escrow already exists).
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const [inInfo] = await conn.getMultipleAccountsInfo([inEscrow]);
  const creates: string[] = [];
  // Cold-PDA rent bootstrap (brand-new EVM user): fund the PDA's SOL so Place
  // can pay the order-account rent. Self-paid from gas; skipped for warm PDAs.
  const pdaLamports = BigInt(await conn.getBalance(owner));
  if (pdaLamports < PDA_RENT_FLOOR) {
    creates.push(HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [PDA_RENT_TOPUP]));
  }
  if (!inInfo) creates.push(HELPER_IFACE.encodeFunctionData("create_ata_for_key", [b32(pda), b32(srcMint)]));
  const total = creates.length + 1; // + the place tx
  if (creates.length) params.onStage?.("setup");
  for (let i = 0; i < creates.length; i++) {
    params.onProgress?.(`Setting up accounts (${i + 1}/${total})…`);
    await evmSend(chain, eoa, HELPER_ADDRESS, creates[i]);
  }

  params.onStage?.("place");
  params.onProgress?.(`Placing order (${total}/${total})…`);
  const acc = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  const keys = [
    acc(pda, false, true),        // order
    acc(owner, true, false),      // owner = external_auth PDA (auto-signed)
    acc(inEscrow, false, true),   // input escrow (the sole escrow now)
    acc(ownerSrc, false, true),
    acc(ownerDst, false, false),
    acc(srcMint, false, false),
    acc(dstMint, false, false),
    acc(pool.swapState, false, false),
    acc(owner, true, true),       // payer = external_auth PDA (auto-signed)
    acc(TOKEN_PROGRAM, false, false),
    acc(SYSTEM_PROGRAM, false, false),
  ];
  const calldata = buildEvmCalldata(keys, placeData({ nonce, bump, aToB, amountInTotal, trancheIn, minOutPerTranche, intervalSecs, expiryTs, keeperFeeBps }), ORDERS_PROGRAM);
  const txHash = await evmSend(chain, eoa, CPI_PRECOMPILE, calldata);
  return { txHash, pda: pda.toBase58(), nonce, owner: owner.toBase58() };
}

export interface OrderEvmPreview {
  /** Cold external_auth PDA → a one-time account-funding prompt precedes setup. */
  needsPdaTopup: boolean;
  /** Total wallet prompts this placement will take (setup(s) + the order). */
  prompts: number;
}

/**
 * Look-ahead for an EVM-lane placement, from REAL chain reads — so the strip can
 * state an honest prompt count before the user commits. A fresh nonce means a
 * brand-new input escrow every time, so the escrow-setup prompt is always one; a
 * cold PDA (below the rent floor) adds a one-time funding prompt; the order is
 * the last. Mirrors exactly what placeOrderEvm decides at execution time.
 */
export async function previewOrderEvm(chain: ChainConfig, eoa: string): Promise<OrderEvmPreview> {
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId);
  const pdaLamports = BigInt(await conn.getBalance(owner));
  const needsPdaTopup = pdaLamports < PDA_RENT_FLOOR;
  const prompts = 1 /* escrow setup */ + (needsPdaTopup ? 1 : 0) + 1 /* place */;
  return { needsPdaTopup, prompts };
}

/** Cancel an order on the EVM lane (owner = external_auth PDA, via CPI precompile). */
export async function cancelOrderEvm(chain: ChainConfig, params: { eoa: string; order: CancelableOrder }): Promise<string> {
  const { eoa, order } = params;
  const owner = evmPdaFor(eoa, chain.romeEvmProgramId);
  const srcMint = order.aToB ? order.pool.mintA : order.pool.mintB;
  const ownerSrc = ownerAta(srcMint, owner);
  const acc = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  const keys = [
    acc(new PublicKey(order.pda), false, true),
    acc(owner, true, true), // owner (authority + rent-reclaim dest)
    acc(new PublicKey(order.inputEscrow), false, true),
    acc(ownerSrc, false, true),
    acc(TOKEN_PROGRAM, false, false),
  ];
  const calldata = buildEvmCalldata(keys, cancelData(), ORDERS_PROGRAM);
  return evmSend(chain, eoa, CPI_PRECOMPILE, calldata);
}

// ---- read live order state ----

export type OrderWithPda = ParsedOrder & { pda: string };

/**
 * Hydrate live state for a set of order PDAs. Uses getMultipleAccountsInfo
 * (getProgramAccounts is throttled on this RPC). Filters to accounts actually
 * owned by the orders program and order-sized.
 */
export async function readOrders(chain: ChainConfig, pdaStrings: string[]): Promise<OrderWithPda[]> {
  if (!pdaStrings.length) return [];
  const conn = new Connection(chain.solanaRpc, "confirmed");
  const pubkeys = pdaStrings.map((s) => new PublicKey(s));
  const infos = await conn.getMultipleAccountsInfo(pubkeys);
  const out: OrderWithPda[] = [];
  infos.forEach((info, i) => {
    if (info && info.owner.equals(ORDERS_PROGRAM) && info.data.length === ORDER_LEN) {
      out.push({ ...parseOrder(info.data as Buffer), pda: pubkeys[i].toBase58() });
    }
  });
  return out;
}

// ---- wallet-only order tracking (localStorage, keyed by owner pubkey) ----

/**
 * A placed order the app tracks locally. The pool is stored as its serializable
 * identity (pairId + tier) — poolForTier() resolves it back to the full Pool.
 */
export interface StoredOrder {
  pda: string;
  nonce: string; // stringified bigint
  pairId: string;
  tier: string;
  aToB: boolean;
  kind: "limit" | "dca";
  placedAt: number; // ms epoch
}

const LS_PREFIX = "rome-dex:orders:";

/** Read every tracked order PDA for an owner. Safe on SSR / disabled storage. */
export function loadTrackedOrders(owner: string | null | undefined): StoredOrder[] {
  if (!owner || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + owner);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as StoredOrder[]) : [];
  } catch {
    return [];
  }
}

/** Append a placed order (newest first), de-duped by PDA. */
export function saveTrackedOrder(owner: string, order: StoredOrder): void {
  if (!owner || typeof window === "undefined") return;
  try {
    const cur = loadTrackedOrders(owner);
    if (cur.some((o) => o.pda === order.pda)) return;
    window.localStorage.setItem(LS_PREFIX + owner, JSON.stringify([order, ...cur]));
  } catch {
    // storage full / disabled — tracking is best-effort, never blocks placement.
  }
}
