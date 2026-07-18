// newuser-gaps.test.mjs — FRESH-KEY ACCEPTANCE, gap-fill.
//
// newuser.test.mjs proves the *router-folded* EVM-lane swap/add/zap + the
// Solana/EVM farm stake+claim from a BRAND-NEW wallet. This file fills the
// remaining brand-new-wallet on-chain gaps with the SAME discipline (a fresh
// EVM keypair via ethers.Wallet.createRandom() / a fresh Solana keypair via
// Keypair.generate(), funded ONLY gas + the input token the way a real user
// receives it, then the fresh key's OWN signatures drive the action):
//
//   1. SWAP exact-in  (Solana lane, direct pool Swap tag 1)
//   2. SWAP exact-out (EVM lane via router.swapExactOut + Solana lane tag 6)
//   3. ADD-LIQUIDITY  (Solana lane, DepositAllTokenTypes tag 2, LP ATA in-flow)
//   4. ZAP            (Solana lane, atomic swap+deposit)
//   5. REMOVE-LIQUIDITY (Solana lane WithdrawAllTokenTypes tag 3 + EVM via router)
//   6. FARM UNSTAKE   (Solana lane tag 3 + EVM lane tag 3)
//
// Every encoding is copied from an existing suite (cited inline as file:line) —
// nothing is invented. Header/helpers (freshUser, send, approve, createAta,
// cpiCalldata, the ifaces, conn, payer, provider, b32, ataFor, acc, u64, exists,
// bal) are copied verbatim from newuser.test.mjs; the Solana-lane builders
// (depositAccountsFor / withdrawAccountsFor) mirror lib.mjs 91-107 + full-parity.mjs
// 24/27, parameterised on the pool object.
//
// TWO POOLS, split by lane (a funding-source split, not a program difference —
// every pool uses the same DEX program Fv2Lgke…):
//   • SOLANA-LANE tests use the MINTABLE test pool `pool.json`. Its mintA/mintB
//     mint authority is the local payer (create-pool.mjs 29-30), so fresh Solana
//     keys are funded via `mintTo` (freshSolUserTest) — unlimited + depletion-
//     proof, exactly how dex.test.mjs / full-parity.mjs fund. (The real wUSDC
//     mint's authority is a wrapper PDA, so the payer CANNOT mint it; transferring
//     real wUSDC to fund fresh users drains a fixed ~230k budget and reverts with
//     SPL 0x1 "insufficient funds" — that was the original failure. mintTo on the
//     test pool removes the budget entirely.) mintA=6dp, mintB=9dp — same scale
//     as real USDC/SOL, so the proven amounts carry over unchanged.
//   • EVM-LANE tests stay on the router-registered REAL pool `P` (USDC/SOL 0.30%
//     from pools-real-pairs.json): the RomeDexRouter is registered ONLY for the
//     real pool, so router.swapExactOut / router.removeLiquidity must target it.
//     Real wUSDC funding is kept TINY (≈45k total across both EVM tests) to fit
//     the payer's remaining real-wUSDC budget.
//
// Run: HADRIAN_PRIVATE_KEY=$(…) node --import tsx --test newuser-gaps.test.mjs
// Every test is { skip: !KEY } (mirrors newuser.test.mjs — the whole set runs
// together when the key is present).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getAccount, getMint, transfer, mintTo,
  getOrCreateAssociatedTokenAccount, createSyncNativeInstruction,
  createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import os from "node:os";
import {
  CHAIN_ID, CPI, evmPdaFor, resolveGas, PK,
  swapAccountsFor, swapData, swapExactOutData, depositData, withdrawData,
  execSolanaMulti,
} from "./lib.mjs";
import { quoteZap, quoteExactOut } from "../sdk/quote.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.HADRIAN_PRIVATE_KEY;
// Default to hadrian-lt — the app's configured EVM RPC (app/lib/walletActions.ts).
const EVM_RPC = process.env.EVM_RPC || "https://hadrian-lt.testnet.romeprotocol.xyz/";
const SOL_RPC = "https://api.devnet.solana.com";

const router = JSON.parse(fs.readFileSync(path.join(DIR, "router.json"), "utf8"));
const farm = JSON.parse(fs.readFileSync(path.join(DIR, "farm.json"), "utf8"));
const pools = JSON.parse(fs.readFileSync(path.join(DIR, "pools-real-pairs.json"), "utf8"));
const P = pools.find((t) => t.pairId === "USDC-SOL" && t.tier === "0.30%");

const ROUTER = router.address;
const HELPER = "0xff00000000000000000000000000000000000009";
const USDC = new PublicKey(P.mintA);
const WSOL = new PublicKey(P.mintB);
const POOL = new PublicKey(P.swapState);
const POOL_MINT = new PublicKey(P.poolMint);
const VAULT_A = new PublicKey(P.vaultA), VAULT_B = new PublicKey(P.vaultB);
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = SystemProgram.programId;
const FARM_PROGRAM = new PublicKey(farm.farmProgram);
const FARM = new PublicKey(farm.farm);
const FARM_AUTHORITY = new PublicKey(farm.authority);
const LP_VAULT = new PublicKey(farm.lpVault);
const REWARD_MINT = new PublicKey(farm.rewardMint);
const LP_SRC = new PublicKey(P.destination); // payer-held initial LP (funds fresh users)
const MAX = 18_446_744_073_709_551_615n;

// ── Solana-lane test pool (pool.json) — MINTABLE + depletion-proof ──
// The payer (id.json) is the mint authority for testPool.mintA/mintB
// (create-pool.mjs 29-30), so fresh Solana keys are funded via mintTo. The
// RomeDexRouter is NOT registered for this pool, so it drives the Solana-lane
// (direct-program) DEX tests only; the EVM-lane router tests stay on `P`.
const testPool = JSON.parse(fs.readFileSync(path.join(DIR, "pool.json"), "utf8"));
const T_MINT_A = new PublicKey(testPool.mintA), T_MINT_B = new PublicKey(testPool.mintB);
const T_POOL_MINT = new PublicKey(testPool.poolMint);
const T_VAULT_A = new PublicKey(testPool.vaultA), T_VAULT_B = new PublicKey(testPool.vaultB);

const conn = new Connection(SOL_RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))));
const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const b32 = (pk) => "0x" + Buffer.from(pk.toBuffer()).toString("hex");
const ataFor = (owner, mint) => getAssociatedTokenAddress(mint, owner, true, TOKEN_PROGRAM_ID);
const routerPda = () => evmPdaFor(ROUTER);
const exists = async (pk) => !!(await conn.getAccountInfo(pk));
const bal = async (a) => { try { return (await getAccount(conn, a)).amount; } catch { return 0n; } };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const acc = (k, s, w) => ({ pubkey: new PublicKey(k), isSigner: !!s, isWritable: !!w });

// ROUTER_IFACE — the 3 fns from newuser.test.mjs 81-85 PLUS swapExactOut +
// removeLiquidity, copied verbatim from router.test.mjs 43-47.
const ROUTER_IFACE = new ethers.Interface([
  "function swap(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minOut)",
  "function swapExactOut(bytes32 poolId, bool aToB, uint64 amountOut, uint64 maxIn)",
  "function addLiquidity(bytes32 poolId, uint64 lp, uint64 maxA, uint64 maxB)",
  "function removeLiquidity(bytes32 poolId, uint64 lp, uint64 minA, uint64 minB)",
  "function zapIn(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minLp, uint64 maxOther)",
]);
const CPI_IFACE = new ethers.Interface(["function invoke(bytes32 program,(bytes32,bool,bool)[] accounts,bytes data)"]);
const HELPER_IFACE = new ethers.Interface(["function create_ata(address user, bytes32 mint)"]);

const evmRpc = async (m, p) => (await (await fetch(EVM_RPC, { method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json());

// One signed send by the fresh key. Returns {status, legs}. (newuser.test.mjs 94-107)
async function send(wallet, to, data) {
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const prev = process.env.EVM_RPC; process.env.EVM_RPC = EVM_RPC;
  const g = await resolveGas({ from: wallet.address, to, data });
  process.env.EVM_RPC = prev;
  const signed = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce,
    maxFeePerGas: g.maxFeePerGas, maxPriorityFeePerGas: g.maxPriorityFeePerGas,
    gasLimit: g.gasLimit, to, value: 0n, data });
  const r = await evmRpc("eth_sendRawTransaction", [signed]);
  if (r.error) throw new Error("send failed: " + JSON.stringify(r.error).slice(0, 300));
  const rcpt = await provider.waitForTransaction(r.result, 1, 120000);
  const sigs = (await evmRpc("rome_solanaTxForEvmTx", [r.result])).result || [];
  return { hash: r.result, status: rcpt?.status, legs: sigs.length };
}

// ---- app-mirrored builders (byte-identical to newuser.test.mjs 110-119) ----
const cpiCalldata = (program, accounts, data) => CPI_IFACE.encodeFunctionData("invoke",
  [b32(program), accounts.map((a) => [b32(a.pubkey), a.isSigner, a.isWritable]), "0x" + data.toString("hex")]);
const approveData = () => { const d = Buffer.alloc(9); d[0] = 4; d.writeBigUInt64LE(MAX, 1); return d; };
const approve = (wallet, ata) => send(wallet, CPI,
  cpiCalldata(SPL_TOKEN, [acc(ata, 0, 1), acc(routerPda(), 0, 0), acc(evmPdaFor(wallet.address), 1, 0)], approveData()));
const createAta = (wallet, mint) => send(wallet, HELPER, HELPER_IFACE.encodeFunctionData("create_ata", [wallet.address, b32(mint)]));

// ---- fresh-user funding (gas + received input token — newuser.test.mjs 122-140) ----
async function freshUser(usdcAmt, wsolAmt = 0n) {
  const wallet = ethers.Wallet.createRandom().connect(provider);
  const pda = evmPdaFor(wallet.address);
  const dep = new ethers.Wallet(KEY.trim(), provider);
  // Gas floor: a real router/CPI tx reserves ~0.0006 ETH; 0.05 covers several
  // txs per wallet with wide margin (was 5 — 5000× overkill). Deployer gas ETH
  // is non-scarce; unspent stays in the throwaway wallet (recoverable if needed).
  await (await dep.sendTransaction({ to: wallet.address, value: ethers.parseEther("0.05") })).wait(1);
  if (usdcAmt > 0n) {
    const srcA = (await getOrCreateAssociatedTokenAccount(conn, payer, USDC, pda, true)).address;
    await transfer(conn, payer, await ataFor(payer.publicKey, USDC), srcA, payer, usdcAmt);
  }
  if (wsolAmt > 0n) {
    const srcB = (await getOrCreateAssociatedTokenAccount(conn, payer, WSOL, pda, true)).address;
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: srcB, lamports: Number(wsolAmt) }),
      createSyncNativeInstruction(srcB)), [payer], { commitment: "confirmed" });
  }
  return { wallet, pda };
}

// [UNUSED after the test-pool migration — kept for reference] Fresh SOLANA keypair
// funded by TRANSFERRING real tokens from the payer. The DEX Solana-lane tests now
// use freshSolUserTest (mintTo on the mintable test pool) instead: the payer cannot
// mint real wUSDC (authority = a wrapper PDA), so real-wUSDC transfers drain a fixed
// ~230k budget and revert. Mirrors newuser.test.mjs 216-220 / orders-newuser 86-90.
async function freshSolUser({ usdc = 0n, wsolLamports = 0n, lp = 0n, sol = 40_000_000 } = {}) {
  const user = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: sol })), [payer], { commitment: "confirmed" });
  const out = { user };
  if (usdc > 0n) {
    out.usdcAta = (await getOrCreateAssociatedTokenAccount(conn, payer, USDC, user.publicKey)).address;
    await transfer(conn, payer, await ataFor(payer.publicKey, USDC), out.usdcAta, payer, usdc);
  }
  if (wsolLamports > 0n) {
    out.wsolAta = (await getOrCreateAssociatedTokenAccount(conn, payer, WSOL, user.publicKey)).address;
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: out.wsolAta, lamports: Number(wsolLamports) }),
      createSyncNativeInstruction(out.wsolAta)), [payer], { commitment: "confirmed" });
  }
  if (lp > 0n) {
    out.lpAta = (await getOrCreateAssociatedTokenAccount(conn, payer, POOL_MINT, user.publicKey)).address;
    await transfer(conn, payer, LP_SRC, out.lpAta, payer, lp); // receive LP (input funding)
  }
  return out;
}

// Fresh SOLANA keypair funded via mintTo on the MINTABLE test pool. The payer is
// the mint authority for testPool.mintA/mintB (create-pool.mjs 29-30), so this
// mints test tokens straight into the fresh key's ATAs — unlimited + depletion-
// proof (the funding pattern of dex.test.mjs 33-34 / full-parity.mjs 53-54). Funds
// only the SRC tokens a fresh user "receives"; dst/LP ATAs are created in-flow by
// the test. mintA=6dp, mintB=9dp (same scale as real USDC/SOL).
async function freshSolUserTest({ a = 0n, b = 0n, sol = 40_000_000 } = {}) {
  const user = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: sol })), [payer], { commitment: "confirmed" });
  const out = { user };
  if (a > 0n) {
    out.aAta = (await getOrCreateAssociatedTokenAccount(conn, payer, T_MINT_A, user.publicKey)).address;
    await mintTo(conn, payer, T_MINT_A, out.aAta, payer, a);
  }
  if (b > 0n) {
    out.bAta = (await getOrCreateAssociatedTokenAccount(conn, payer, T_MINT_B, user.publicKey)).address;
    await mintTo(conn, payer, T_MINT_B, out.bAta, payer, b);
  }
  return out;
}

const userStakePda = (authority) => PublicKey.findProgramAddressSync([FARM.toBuffer(), authority.toBuffer()], FARM_PROGRAM)[0];

// Solana-lane pool account lists for the USDC/SOL 0.30% pool `P`. Byte-identical
// order to lib.mjs depositAccounts (91-98) / withdrawAccounts (100-107) and
// full-parity.mjs depositAccts (24) / withdrawAccts (27) — only parameterised on
// the pool object (lib's versions are hardcoded to the pool.json primary pool).
const depositAccountsFor = (p, authority, uA, uB, uLp) => [
  acc(p.swapState, 0, 0), acc(p.authority, 0, 0), acc(authority, 1, 0),
  acc(uA, 0, 1), acc(uB, 0, 1), acc(p.vaultA, 0, 1), acc(p.vaultB, 0, 1),
  acc(p.poolMint, 0, 1), acc(uLp, 0, 1), acc(p.mintA, 0, 0), acc(p.mintB, 0, 0),
  acc(SPL_TOKEN, 0, 0), acc(SPL_TOKEN, 0, 0), acc(SPL_TOKEN, 0, 0),
];
const withdrawAccountsFor = (p, authority, uLp, uA, uB) => [
  acc(p.swapState, 0, 0), acc(p.authority, 0, 0), acc(authority, 1, 0),
  acc(p.poolMint, 0, 1), acc(uLp, 0, 1), acc(p.vaultA, 0, 1), acc(p.vaultB, 0, 1),
  acc(uA, 0, 1), acc(uB, 0, 1), acc(p.feeAccount, 0, 1), acc(p.mintA, 0, 0), acc(p.mintB, 0, 0),
  acc(SPL_TOKEN, 0, 0), acc(SPL_TOKEN, 0, 0), acc(SPL_TOKEN, 0, 0),
];

// ── 1. SWAP exact-in (Solana lane) — fresh keypair, direct pool Swap (tag 1) ──
// Mirrors dex.test.mjs 47-57 (swapData tag 1 + swapAccounts), on the MINTABLE
// test pool. The dst (token B) ATA is created in-flow in the SAME self-signed tx
// via the idempotent-create ix (the raw Solana Swap does not create it) — the
// create-ATA-in-flow pattern from the native farm claim, newuser.test.mjs 238-240.
test("SWAP exact-in (Solana lane) — fresh keypair, dst ATA created in-flow", { skip: !KEY }, async () => {
  const { user, aAta } = await freshSolUserTest({ a: 600_000n });
  const dstAta = await ataFor(user.publicKey, T_MINT_B);
  assert.equal(await exists(dstAta), false, "dst (token B) ATA must NOT be pre-created");
  const before = await bal(dstAta);
  const swapIx = new TransactionInstruction({
    programId: PK(testPool.program),
    keys: swapAccountsFor(testPool, "AtoB", user.publicKey, aAta, dstAta),
    data: swapData(400_000n, 1n),
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, dstAta, user.publicKey, T_MINT_B),
    swapIx), [user], { commitment: "confirmed" });
  assert.equal(await exists(dstAta), true, "dst ATA created in-flow (native)");
  assert.ok((await bal(dstAta)) > before, "token B received by the fresh keypair");
  console.log("  SWAP exact-in (Solana): 1 self-signed tx (create dst + swap) · dst ATA created in-flow · test pool");
});

// ── 2a. SWAP exact-out (EVM lane) — fresh key via router.swapExactOut ──
// Mirrors router.test.mjs 148-157 (swapExactOut ABI + quoteExactOut-sized cap)
// with the newuser.test.mjs 146-160 fresh-key structure (approve src, then swap).
// The dst (wSOL) ATA is provisioned in-flow via the HELPER precompile first
// (the ZAP cold-path, newuser.test.mjs 172) so the exact-out has somewhere to
// deliver regardless of whether the router folds dst-ATA creation.
test("SWAP exact-out (EVM lane) — fresh key via router, exact output delivered", { skip: !KEY }, async () => {
  const { wallet, pda } = await freshUser(3_000n); // minimal real wUSDC (want=5k wSOL costs ~0.75k) — of the payer's ~230k budget
  const dstAta = await ataFor(pda, WSOL);
  await createAta(wallet, WSOL);
  await approve(wallet, await ataFor(pda, USDC));
  const want = 5_000n; // tiny wSOL out — exact-out still delivers EXACTLY this
  const q = quoteExactOut({ amountOut: want, reserveIn: await bal(VAULT_A), reserveOut: await bal(VAULT_B) });
  const maxIn = q ? q.amountIn + 10n : 1_200_000n; // tight cap from live reserves (router.test.mjs 153)
  const before = await bal(dstAta);
  const r = await send(wallet, ROUTER, ROUTER_IFACE.encodeFunctionData("swapExactOut", [b32(POOL), true, want, maxIn]));
  assert.equal(r.status, 1, "swapExactOut landed");
  assert.equal((await bal(dstAta)) - before, want, "router delivers EXACTLY the requested output");
  console.log(`  SWAP exact-out (EVM): approve + swapExactOut · legs=${r.legs} · exact ${want} wSOL delivered`);
});

// ── 2b. SWAP exact-out (Solana lane) — fresh keypair (tag 6) ──
// Mirrors dex.test.mjs 23-34 (swapExactOutData tag 6 + swapAccounts), on the
// MINTABLE test pool. dst ATA created in-flow in the same self-signed tx
// (newuser.test.mjs 238-240). maxIn from quoteExactOut over live test-pool
// reserves (tiny — ~100 raw A buys 100k raw B at the 100:100 seed ratio).
test("SWAP exact-out (Solana lane) — fresh keypair, exact output delivered", { skip: !KEY }, async () => {
  const { user, aAta } = await freshSolUserTest({ a: 1_200_000n });
  const dstAta = await ataFor(user.publicKey, T_MINT_B);
  assert.equal(await exists(dstAta), false, "dst (token B) ATA must NOT be pre-created");
  const want = 100_000n;
  const q = quoteExactOut({ amountOut: want, reserveIn: await bal(T_VAULT_A), reserveOut: await bal(T_VAULT_B) });
  const maxIn = q ? q.amountIn + 10n : 1_200_000n;
  const before = await bal(dstAta);
  const swapIx = new TransactionInstruction({
    programId: PK(testPool.program),
    keys: swapAccountsFor(testPool, "AtoB", user.publicKey, aAta, dstAta),
    data: swapExactOutData(want, maxIn),
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, dstAta, user.publicKey, T_MINT_B),
    swapIx), [user], { commitment: "confirmed" });
  assert.equal(await exists(dstAta), true, "dst ATA created in-flow (native)");
  assert.equal((await bal(dstAta)) - before, want, "delivers EXACTLY the requested output");
  console.log(`  SWAP exact-out (Solana): 1 self-signed tx · exact ${want} token B delivered · test pool`);
});

// ── 3. ADD-LIQUIDITY (Solana lane) — fresh keypair, LP ATA created in-flow ──
// Mirrors full-parity.mjs depositAccts/depData (24/29/41) via depositAccountsFor
// (tag 2) + the LP-sizing from newuser.test.mjs 197-200, on the MINTABLE test
// pool. LP ATA created in-flow in the same self-signed tx (DepositAllTokenTypes
// mints into it; it must exist). B-bound at the test pool's 100:100 seed ratio
// → consumes ~45M B (9dp) + ~45k A (6dp), well within the funded caps.
test("ADD-LIQUIDITY (Solana lane) — fresh keypair, LP ATA created in-flow", { skip: !KEY }, async () => {
  const { user, aAta, bAta } = await freshSolUserTest({ a: 1_200_000n, b: 60_000_000n });
  const lpAta = await ataFor(user.publicKey, T_POOL_MINT);
  assert.equal(await exists(lpAta), false, "LP ATA must NOT be pre-created");
  const supply = (await getMint(conn, T_POOL_MINT)).supply;
  const rA = await bal(T_VAULT_A), rB = await bal(T_VAULT_B);
  let lp = (1_000_000n * supply) / rA; const lpB = (50_000_000n * supply) / rB;
  if (lpB < lp) lp = lpB; lp = (lp * 90n) / 100n;
  const before = await bal(lpAta);
  const depIx = new TransactionInstruction({
    programId: PK(testPool.program),
    keys: depositAccountsFor(testPool, user.publicKey, aAta, bAta, lpAta),
    data: depositData(lp, 1_200_000n, 60_000_000n),
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, lpAta, user.publicKey, T_POOL_MINT),
    depIx), [user], { commitment: "confirmed" });
  assert.equal(await exists(lpAta), true, "LP ATA created in-flow (native)");
  assert.ok((await bal(lpAta)) > before, "LP minted to the fresh keypair");
  console.log("  ADD-LIQ (Solana): 1 self-signed tx (create LP + deposit) · LP ATA created in-flow · test pool");
});

// ── 4. ZAP (Solana lane) — fresh keypair (atomic swap + deposit) ──
// Mirrors zap.test.mjs 16-36 (quoteZap + execSolanaMulti [swap, deposit]) with a
// fresh signer + the test-pool accounts. execSolanaMulti pins programId to
// lib.mjs's `pool.program` = pool.json = the test pool's own program (Fv2Lgke…),
// so the atomic swap+deposit runs entirely on the mintable test pool.
test("ZAP (Solana lane) — fresh keypair, single-sided input mints LP", { skip: !KEY }, async () => {
  const { user, aAta } = await freshSolUserTest({ a: 1_200_000n });
  const wsolAta = await ataFor(user.publicKey, T_MINT_B);
  const lpAta = await ataFor(user.publicKey, T_POOL_MINT);
  // intermediate token-B ATA (swap output) + LP ATA (deposit output) must exist
  // for the atomic swap+deposit — create both empty (payer-funded receive).
  await getOrCreateAssociatedTokenAccount(conn, payer, T_MINT_B, user.publicKey);
  await getOrCreateAssociatedTokenAccount(conn, payer, T_POOL_MINT, user.publicKey);
  const supply = (await getMint(conn, T_POOL_MINT)).supply;
  const q = quoteZap({ amountIn: 500_000n, reserveA: await bal(T_VAULT_A), reserveB: await bal(T_VAULT_B), lpSupply: supply });
  assert.ok(q.lpTokens > 0n, "zap should yield LP");
  const lpBefore = await bal(lpAta);
  const r = await execSolanaMulti([
    { accounts: swapAccountsFor(testPool, "AtoB", user.publicKey, aAta, wsolAta), data: swapData(q.swapAmount, 0n) },
    { accounts: depositAccountsFor(testPool, user.publicKey, aAta, wsolAta, lpAta), data: depositData(q.lpTokens, q.maxA, q.maxB) },
  ], user);
  assert.ok(r.ok, "atomic zap landed");
  assert.equal((await bal(lpAta)) - lpBefore, q.lpTokens, "LP minted equals the quote (single atomic tx)");
  console.log(`  ZAP (Solana): 1 atomic tx (swap + deposit) · LP minted ${q.lpTokens} · test pool`);
});

// ── 5a. REMOVE-LIQUIDITY (Solana lane) — fresh keypair (tag 3), self-contained ──
// The test pool's LP mint has no payer-held reserve to seed from (unlike the real
// pool's `destination`), so the fresh key mints A+B, DEPOSITS to obtain its own LP
// (tag 2, mirrors the ADD-LIQ test), then WITHDRAWS it (tag 3) — no external LP
// source. Mirrors full-parity.mjs deposit/withdraw (24/27/29/30).
test("REMOVE-LIQUIDITY (Solana lane) — fresh keypair, LP burned for underlying", { skip: !KEY }, async () => {
  const { user, aAta, bAta } = await freshSolUserTest({ a: 1_200_000n, b: 60_000_000n });
  const lpAta = await ataFor(user.publicKey, T_POOL_MINT);
  // 1) deposit to obtain LP (same sizing as the ADD-LIQ test) — LP ATA in-flow.
  const supply = (await getMint(conn, T_POOL_MINT)).supply;
  const rA = await bal(T_VAULT_A), rB = await bal(T_VAULT_B);
  let lp = (1_000_000n * supply) / rA; const lpB = (50_000_000n * supply) / rB;
  if (lpB < lp) lp = lpB; lp = (lp * 90n) / 100n;
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, lpAta, user.publicKey, T_POOL_MINT),
    new TransactionInstruction({
      programId: PK(testPool.program),
      keys: depositAccountsFor(testPool, user.publicKey, aAta, bAta, lpAta),
      data: depositData(lp, 1_200_000n, 60_000_000n),
    })), [user], { commitment: "confirmed" });
  const lpMinted = await bal(lpAta);
  assert.ok(lpMinted > 0n, "deposit obtained LP to burn");
  // 2) withdraw the freshly-minted LP back for underlying (tag 3).
  const aBefore = await bal(aAta);
  const wdIx = new TransactionInstruction({
    programId: PK(testPool.program),
    keys: withdrawAccountsFor(testPool, user.publicKey, lpAta, aAta, bAta),
    data: withdrawData(lpMinted, 0n, 0n),
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(wdIx), [user], { commitment: "confirmed" });
  assert.ok((await bal(aAta)) - aBefore > 0n, "burned LP returned token A to the fresh keypair");
  console.log(`  REMOVE-LIQ (Solana): deposit→withdraw self-contained · burned ${lpMinted} LP for underlying · test pool`);
});

// ── 5b. REMOVE-LIQUIDITY (EVM lane) — fresh key via router.removeLiquidity ──
// Mirrors router.test.mjs 159-172 (approve the LP ATA as router-PDA delegate,
// then removeLiquidity). The fresh EVM user receives tiny USDC + wSOL (creating
// the router's on-chain-derived withdrawal-destination ATAs) then LP into the
// PDA's LP ATA (payer transfer from LP_SRC — newuser.test.mjs 220).
test("REMOVE-LIQUIDITY (EVM lane) — fresh key via router, LP burned for underlying", { skip: !KEY }, async () => {
  const { wallet, pda } = await freshUser(1_000n, 1_000_000n); // minimal: just creates the dest USDC/wSOL ATAs; LP comes from LP_SRC
  const lpAta = (await getOrCreateAssociatedTokenAccount(conn, payer, POOL_MINT, pda, true)).address;
  await transfer(conn, payer, LP_SRC, lpAta, payer, 3_000n); // minimal real LP (of the payer's ~300k)
  const uA = await ataFor(pda, USDC);
  const lpToBurn = 1_000n;
  await approve(wallet, lpAta);
  const aBefore = await bal(uA);
  const r = await send(wallet, ROUTER, ROUTER_IFACE.encodeFunctionData("removeLiquidity", [b32(POOL), lpToBurn, 0n, 0n]));
  assert.equal(r.status, 1, "removeLiquidity landed");
  assert.ok((await bal(uA)) - aBefore > 0n, "burned LP returned token A (USDC) to the PDA's ATA");
  console.log(`  REMOVE-LIQ (EVM): approve LP + removeLiquidity · legs=${r.legs} · burned ${lpToBurn} LP`);
});

// ── 6a. FARM UNSTAKE (Solana lane) — fresh keypair (tag 3) ──
// init(1) + stake(2) then unstake(3). init/stake mirror newuser.test.mjs 228-231;
// unstake mirrors farm.test.mjs unstakeAccounts (64-67) + unstakeData (46) — note
// unstake orders lpVault BEFORE userLp (vault is the source), the reverse of stake.
test("FARM UNSTAKE (Solana lane) — fresh keypair, staked LP returned", { skip: !KEY }, async () => {
  const user = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 20_000_000 })), [payer], { commitment: "confirmed" });
  const userLp = (await getOrCreateAssociatedTokenAccount(conn, payer, POOL_MINT, user.publicKey)).address;
  await transfer(conn, payer, LP_SRC, userLp, payer, 3_000n); // receive minimal real LP (input funding)
  const ustake = userStakePda(user.publicKey);
  const STAKE = 1_000n;
  const fix = (accs, data) => new TransactionInstruction({ programId: FARM_PROGRAM, keys: accs, data });

  const initAccs = [acc(FARM, 0, 0), acc(user.publicKey, 0, 0), acc(ustake, 0, 1), acc(user.publicKey, 1, 1), acc(SYSTEM, 0, 0)];
  const stakeAccs = [acc(FARM, 0, 1), acc(FARM_AUTHORITY, 0, 0), acc(user.publicKey, 1, 0), acc(ustake, 0, 1), acc(userLp, 0, 1), acc(LP_VAULT, 0, 1), acc(SPL_TOKEN, 0, 0)];
  await sendAndConfirmTransaction(conn, new Transaction().add(
    fix(initAccs, Buffer.from([1])), fix(stakeAccs, Buffer.concat([Buffer.from([2]), u64(STAKE)]))), [user], { commitment: "confirmed" });
  const staked = await bal(userLp);

  const unstakeAccs = [acc(FARM, 0, 1), acc(FARM_AUTHORITY, 0, 0), acc(user.publicKey, 1, 0), acc(ustake, 0, 1), acc(LP_VAULT, 0, 1), acc(userLp, 0, 1), acc(SPL_TOKEN, 0, 0)];
  await sendAndConfirmTransaction(conn, new Transaction().add(
    fix(unstakeAccs, Buffer.concat([Buffer.from([3]), u64(STAKE)]))), [user], { commitment: "confirmed" });
  assert.equal(await bal(userLp), staked + STAKE, "staked LP returned by unstake (native)");
  console.log("  FARM UNSTAKE (Solana): init+stake, then unstake · LP returned · zero pre-creation");
});

// ── 6b. FARM UNSTAKE (EVM lane) — fresh key ──
// Mirrors the newuser.test.mjs 253-285 EVM-farm pattern (cpiCalldata to
// FARM_PROGRAM, authority = external_auth PDA, UserStake created permissionlessly)
// with a stake(2) then unstake(3). Unstake accounts mirror farm.test.mjs 64-67.
test("FARM UNSTAKE (EVM lane) — fresh key, staked LP returned to external_auth ATA", { skip: !KEY }, async () => {
  const { wallet, pda } = await freshUser(0n); // gas only
  const authority = pda;
  const lpAta = (await getOrCreateAssociatedTokenAccount(conn, payer, POOL_MINT, authority, true)).address;
  await transfer(conn, payer, LP_SRC, lpAta, payer, 3_000n); // receive minimal real LP
  const ustake = userStakePda(authority);
  const STAKE = 1_000n;

  // UserStake: permissionless create (Rome constraint — EVM lane can't self-create; newuser.test.mjs 263-266).
  if (!(await exists(ustake))) {
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ programId: FARM_PROGRAM,
      keys: [acc(FARM, 0, 0), acc(authority, 0, 0), acc(ustake, 0, 1), acc(payer.publicKey, 1, 1), acc(SYSTEM, 0, 0)], data: Buffer.from([1]) })), [payer], { commitment: "confirmed" });
  }
  const stakeAccs = [acc(FARM, 0, 1), acc(FARM_AUTHORITY, 0, 0), acc(authority, 1, 0), acc(ustake, 0, 1), acc(lpAta, 0, 1), acc(LP_VAULT, 0, 1), acc(SPL_TOKEN, 0, 0)];
  const rs = await send(wallet, CPI, cpiCalldata(FARM_PROGRAM, stakeAccs, Buffer.concat([Buffer.from([2]), u64(STAKE)])));
  assert.equal(rs.status, 1, "EVM stake landed");
  const staked = await bal(lpAta);

  const unstakeAccs = [acc(FARM, 0, 1), acc(FARM_AUTHORITY, 0, 0), acc(authority, 1, 0), acc(ustake, 0, 1), acc(LP_VAULT, 0, 1), acc(lpAta, 0, 1), acc(SPL_TOKEN, 0, 0)];
  const ru = await send(wallet, CPI, cpiCalldata(FARM_PROGRAM, unstakeAccs, Buffer.concat([Buffer.from([3]), u64(STAKE)])));
  assert.equal(ru.status, 1, "EVM unstake landed");
  assert.equal(await bal(lpAta), staked + STAKE, "staked LP returned to the external_auth ATA by unstake");
  console.log(`  FARM UNSTAKE (EVM): stake + unstake via CPI · legs=${ru.legs} · LP returned`);
});
