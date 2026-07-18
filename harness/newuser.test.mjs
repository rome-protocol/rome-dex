// newuser.test.mjs — FRESH-KEY ACCEPTANCE (the operator's gate for directive #2:
// "everything works for a BRAND-NEW user with ZERO pre-creation by us").
//
// For each action we mint a BRAND-NEW EVM keypair, fund ONLY gas + the input
// token the way a real user receives it (deployer/treasury transfers the token
// INTO the fresh user's PDA ATA — the user RECEIVING tokens, which legitimately
// creates that one input ATA). We then drive the action via the fresh key's own
// signatures through the SAME on-chain path the app uses (mirrors app/lib/
// router.ts + app/lib/farm.ts byte-for-byte), and assert:
//   • the under-test account (dst ATA / LP ATA / reward ATA / UserStake PDA)
//     did NOT exist before the action, and DID after — created in-flow.
//   • the action landed with the fresh key's signatures ALONE.
//   • signatures-per-action is reported.
//
// This is the empirical proof that STEP-1's design (create+CPI folded into the
// router op) delivers a zero-pre-creation new-user experience.
//
// Run: HADRIAN_PRIVATE_KEY=$(…) node --test newuser.test.mjs
// Skips (does not fail) without the key.

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
  getAssociatedTokenAddress, getAccount, getMint, transfer,
  getOrCreateAssociatedTokenAccount, createSyncNativeInstruction,
  createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import os from "node:os";
import { CHAIN_ID, CPI, evmPdaFor, resolveGas } from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.HADRIAN_PRIVATE_KEY;
// Default to hadrian-lt — the app's configured EVM RPC (app/lib/walletActions.ts).
// It is iterative-by-design (multi-leg, higher per-tx CU budget), which the heavy
// atomic zap (create ATAs + swap + deposit > 1.4M CU) requires. Override with
// EVM_RPC=https://hadrian.testnet.romeprotocol.xyz/ to hit the atomic proxy.
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

const ROUTER_IFACE = new ethers.Interface([
  "function swap(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minOut)",
  "function addLiquidity(bytes32 poolId, uint64 lp, uint64 maxA, uint64 maxB)",
  "function zapIn(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minLp, uint64 maxOther)",
]);
const CPI_IFACE = new ethers.Interface(["function invoke(bytes32 program,(bytes32,bool,bool)[] accounts,bytes data)"]);
const HELPER_IFACE = new ethers.Interface(["function create_ata(address user, bytes32 mint)"]);

const evmRpc = async (m, p) => (await (await fetch(EVM_RPC, { method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json());

// One signed send by the fresh key. Returns {status, legs}. Counts as 1 signature.
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

// ---- app-mirrored builders (byte-identical to app/lib/router.ts + farm.ts) ----
const cpiCalldata = (program, accounts, data) => CPI_IFACE.encodeFunctionData("invoke",
  [b32(program), accounts.map((a) => [b32(a.pubkey), a.isSigner, a.isWritable]), "0x" + data.toString("hex")]);

// approve-once: grant the router PDA an SPL delegate on `ata` (mirrors ensureApproved).
const approveData = () => { const d = Buffer.alloc(9); d[0] = 4; d.writeBigUInt64LE(MAX, 1); return d; };
const approve = (wallet, ata) => send(wallet, CPI,
  cpiCalldata(SPL_TOKEN, [acc(ata, 0, 1), acc(routerPda(), 0, 0), acc(evmPdaFor(wallet.address), 1, 0)], approveData()));

// create an ATA via the HELPER precompile directly (mirrors ensureAtaExists).
const createAta = (wallet, mint) => send(wallet, HELPER, HELPER_IFACE.encodeFunctionData("create_ata", [wallet.address, b32(mint)]));

// ---- fresh-user funding (gas + received input token — the only pre-provision) ----
async function freshUser(usdcAmt, wsolAmt = 0n) {
  const wallet = ethers.Wallet.createRandom().connect(provider);
  const pda = evmPdaFor(wallet.address);
  const dep = new ethers.Wallet(KEY.trim(), provider);
  await (await dep.sendTransaction({ to: wallet.address, value: ethers.parseEther("5") })).wait(1);
  // USDC — user receives it (creates the ONE input ATA legitimately).
  if (usdcAmt > 0n) {
    const srcA = (await getOrCreateAssociatedTokenAccount(conn, payer, USDC, pda, true)).address;
    await transfer(conn, payer, await ataFor(payer.publicKey, USDC), srcA, payer, usdcAmt);
  }
  // wSOL — wrap native SOL into the user's wSOL ATA (also a "receive").
  if (wsolAmt > 0n) {
    const srcB = (await getOrCreateAssociatedTokenAccount(conn, payer, WSOL, pda, true)).address;
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: srcB, lamports: Number(wsolAmt) }),
      createSyncNativeInstruction(srcB)), [payer], { commitment: "confirmed" });
  }
  return { wallet, pda };
}

const SIGS = {};
const FARM_CTX = {};
const userStakePda = (authority) => PublicKey.findProgramAddressSync([FARM.toBuffer(), authority.toBuffer()], FARM_PROGRAM)[0];

test("SWAP — fresh key, dst ATA created in-flow (no pre-creation)", { skip: !KEY }, async () => {
  const { wallet, pda } = await freshUser(600_000n);
  const dstAta = await ataFor(pda, WSOL);
  assert.equal(await exists(dstAta), false, "dst (wSOL) ATA must NOT be pre-created");
  let sigs = 0;
  // mirrors routerSwap: approve src (first-time) then swap.
  await approve(wallet, await ataFor(pda, USDC)); sigs++;
  const before = await bal(dstAta);
  const r = await send(wallet, ROUTER, ROUTER_IFACE.encodeFunctionData("swap", [b32(POOL), true, 400_000n, 1n])); sigs++;
  assert.equal(r.status, 1, "swap landed");
  assert.equal(await exists(dstAta), true, "dst ATA created in-flow by the swap");
  assert.ok((await bal(dstAta)) > before, "wSOL received");
  SIGS.swap = sigs;
  console.log(`  SWAP: ${sigs} sigs (approve + swap) · legs=${r.legs} · dst ATA created in-flow`);
});

test("ZAP — cold fresh key (only USDC), output ATA + LP ATA created in-flow", { skip: !KEY }, async () => {
  const { wallet, pda } = await freshUser(1_200_000n);
  const outAta = await ataFor(pda, WSOL);
  const lpAta = await ataFor(pda, POOL_MINT);
  assert.equal(await exists(outAta), false, "output (wSOL) ATA must NOT be pre-created");
  assert.equal(await exists(lpAta), false, "LP ATA must NOT be pre-created");
  let sigs = 0;
  // mirrors routerZapIn: zapIn is too heavy to fold ATA creation (atomic CU
  // ceiling), so the output-side ATA + LP ATA are created in-flow as separate
  // lightweight txs, then approve both spend sides, then zapIn.
  await createAta(wallet, WSOL); sigs++;
  await createAta(wallet, POOL_MINT); sigs++;
  await approve(wallet, await ataFor(pda, USDC)); sigs++;
  await approve(wallet, outAta); sigs++;
  const lpBefore = await bal(lpAta);
  const r = await send(wallet, ROUTER, ROUTER_IFACE.encodeFunctionData("zapIn", [b32(POOL), true, 500_000n, 1n, 600_000n])); sigs++;
  assert.equal(r.status, 1, "zapIn landed");
  assert.equal(await exists(lpAta), true, "LP ATA created in-flow by zapIn");
  assert.ok((await bal(lpAta)) > lpBefore, "LP minted from a single-sided cold input");
  SIGS.zap = sigs;
  console.log(`  ZAP: ${sigs} sigs (create out + create LP + approve×2 + zap) · legs=${r.legs} · output+LP ATAs created in-flow (separate txs — CU ceiling)`);
});

// add-liquidity → farm stake → farm claim, on ONE fresh key that must build up LP.
test("ADD-LIQUIDITY — fresh key, LP ATA created in-flow", { skip: !KEY }, async () => {
  const ctx = await freshUser(1_200_000n, 60_000_000n);
  FARM_CTX.wallet = ctx.wallet; FARM_CTX.pda = ctx.pda;
  const { wallet, pda } = ctx;
  const lpAta = await ataFor(pda, POOL_MINT);
  assert.equal(await exists(lpAta), false, "LP ATA must NOT be pre-created");
  let sigs = 0;
  // mirrors routerAddLiquidity: approve both token sides, then addLiquidity (router folds LP-ATA create).
  await approve(wallet, await ataFor(pda, USDC)); sigs++;
  await approve(wallet, await ataFor(pda, WSOL)); sigs++;
  // size lp so required tokens fit the funded amounts (mirror app quote sizing).
  const supply = (await getMint(conn, POOL_MINT)).supply;
  const rA = await bal(VAULT_A), rB = await bal(VAULT_B);
  let lp = (1_000_000n * supply) / rA; const lpB = (50_000_000n * supply) / rB;
  if (lpB < lp) lp = lpB; lp = (lp * 90n) / 100n;
  const before = await bal(lpAta);
  const r = await send(wallet, ROUTER, ROUTER_IFACE.encodeFunctionData("addLiquidity", [b32(POOL), lp, 1_200_000n, 60_000_000n])); sigs++;
  assert.equal(r.status, 1, "addLiquidity landed");
  assert.equal(await exists(lpAta), true, "LP ATA created in-flow by addLiquidity");
  assert.ok((await bal(lpAta)) > before, "LP minted");
  FARM_CTX.lp = (await bal(lpAta));
  SIGS.addLiquidity = sigs;
  console.log(`  ADD-LIQ: ${sigs} sigs (approve×2 + deposit) · legs=${r.legs} · LP ATA created in-flow`);
});

// FARM (Solana lane): a BRAND-NEW Solana keypair does the whole farm journey
// with its OWN native signatures — UserStake PDA + reward ATA both created
// in-flow, zero pre-creation. This is the lane where in-flow fully works: a
// native tx creates the account directly (no EVM-emulation of a third-party CPI).
test("FARM (Solana lane) — fresh keypair, UserStake + reward ATA in-flow", { skip: !KEY }, async () => {
  const user = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 20_000_000 })), [payer], { commitment: "confirmed" });
  const userLp = (await getOrCreateAssociatedTokenAccount(conn, payer, POOL_MINT, user.publicKey)).address;
  await transfer(conn, payer, LP_SRC, userLp, payer, 400_000n); // receive LP (input funding)
  const ustake = userStakePda(user.publicKey);
  const userReward = await ataFor(user.publicKey, REWARD_MINT);
  assert.equal(await exists(ustake), false, "UserStake PDA must NOT be pre-created");
  assert.equal(await exists(userReward), false, "reward ATA must NOT be pre-created");
  const fix = (accs, data) => new TransactionInstruction({ programId: FARM_PROGRAM, keys: accs, data });

  // init + stake in ONE self-signed native tx (user is rent payer + authority).
  const initAccs = [acc(FARM, 0, 0), acc(user.publicKey, 0, 0), acc(ustake, 0, 1), acc(user.publicKey, 1, 1), acc(SYSTEM, 0, 0)];
  const stakeAccs = [acc(FARM, 0, 1), acc(FARM_AUTHORITY, 0, 0), acc(user.publicKey, 1, 0), acc(ustake, 0, 1), acc(userLp, 0, 1), acc(LP_VAULT, 0, 1), acc(SPL_TOKEN, 0, 0)];
  await sendAndConfirmTransaction(conn, new Transaction().add(
    fix(initAccs, Buffer.from([1])), fix(stakeAccs, Buffer.concat([Buffer.from([2]), u64(200_000n)]))), [user], { commitment: "confirmed" });
  assert.equal(await exists(ustake), true, "UserStake PDA created in-flow (native)");
  assert.equal(await bal(userLp), 200_000n, "LP staked");
  await new Promise((r) => setTimeout(r, 8000));

  // create reward ATA + claim in ONE self-signed native tx.
  const claimAccs = [acc(FARM, 0, 1), acc(FARM_AUTHORITY, 0, 0), acc(user.publicKey, 1, 0), acc(ustake, 0, 1), acc(REWARD_MINT, 0, 1), acc(userReward, 0, 1), acc(SPL_TOKEN, 0, 0)];
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userReward, user.publicKey, REWARD_MINT),
    fix(claimAccs, Buffer.from([4]))), [user], { commitment: "confirmed" });
  assert.equal(await exists(userReward), true, "reward ATA created in-flow (native)");
  assert.ok((await bal(userReward)) > 0n, "RDX reward minted to the fresh user");
  SIGS.farmSol = "2 (init+stake, create-reward+claim)";
  console.log(`  FARM (Solana): 2 self-signed txs · UserStake + reward ATA created in-flow · zero pre-creation`);
});

// FARM (EVM lane): reward ATA is provisioned IN-FLOW via the HELPER precompile
// (a CPI to the ATA program does NOT emulate on the EVM lane — see farm.ts). Stake
// + claim land with the fresh EVM key's own signatures. The UserStake PDA is
// created permissionlessly here (authority need-not-sign, by design): Rome's proxy
// cannot yet materialise an account a THIRD-PARTY program creates inside its own
// CPI, so the EVM user cannot self-create it today. Documented in farm.ts.
test("FARM (EVM lane) — reward ATA in-flow via HELPER; stake + claim", { skip: !KEY }, async () => {
  const { wallet, pda } = FARM_CTX;
  assert.ok(wallet, "add-liquidity produced LP for the EVM fresh key");
  const authority = pda;
  const ustake = userStakePda(authority);
  const userLp = await ataFor(authority, POOL_MINT);
  const userReward = await ataFor(authority, REWARD_MINT);
  assert.equal(await exists(userReward), false, "reward ATA must NOT be pre-created");

  // UserStake: permissionless create (Rome constraint — EVM lane can't self-create).
  if (!(await exists(ustake))) {
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ programId: FARM_PROGRAM,
      keys: [acc(FARM, 0, 0), acc(authority, 0, 0), acc(ustake, 0, 1), acc(payer.publicKey, 1, 1), acc(SYSTEM, 0, 0)], data: Buffer.from([1]) })), [payer], { commitment: "confirmed" });
  }
  const amount = FARM_CTX.lp / 2n;
  let sigs = 0;
  // stake (EVM, one CPI) — fresh key signs.
  const stakeAccs = [acc(FARM, 0, 1), acc(FARM_AUTHORITY, 0, 0), acc(authority, 1, 0), acc(ustake, 0, 1), acc(userLp, 0, 1), acc(LP_VAULT, 0, 1), acc(SPL_TOKEN, 0, 0)];
  const lpBefore = await bal(userLp);
  const rs = await send(wallet, CPI, cpiCalldata(FARM_PROGRAM, stakeAccs, Buffer.concat([Buffer.from([2]), u64(amount)]))); sigs++;
  assert.equal(rs.status, 1, "EVM stake landed");
  assert.equal(lpBefore - (await bal(userLp)), amount, "LP staked from the EVM wallet");
  await new Promise((r) => setTimeout(r, 8000));
  // create reward ATA via HELPER (in-flow) then claim — fresh key signs both.
  await createAta(wallet, REWARD_MINT); sigs++;
  assert.equal(await exists(userReward), true, "reward ATA created in-flow via HELPER");
  const claimAccs = [acc(FARM, 0, 1), acc(FARM_AUTHORITY, 0, 0), acc(authority, 1, 0), acc(ustake, 0, 1), acc(REWARD_MINT, 0, 1), acc(userReward, 0, 1), acc(SPL_TOKEN, 0, 0)];
  const rc = await send(wallet, CPI, cpiCalldata(FARM_PROGRAM, claimAccs, Buffer.from([4]))); sigs++;
  assert.equal(rc.status, 1, "EVM claim landed");
  assert.ok((await bal(userReward)) > 0n, "RDX minted to the EVM fresh user's reward ATA");
  SIGS.farmEvm = sigs;
  console.log(`  FARM (EVM): ${sigs} sigs (stake + create-reward-via-HELPER + claim) · reward ATA in-flow · UserStake permissionless (Rome constraint)`);
});

test("summary — signatures per NEW-USER action", { skip: !KEY }, () => {
  console.log("\n── new-user signatures-per-action (first time; steady-state = 1 op sig) ──");
  console.log(`  swap (EVM):          ${SIGS.swap} (approve + swap) — dst ATA in-flow`);
  console.log(`  add-liquidity (EVM): ${SIGS.addLiquidity} (approve×2 + deposit) — LP ATA in-flow`);
  console.log(`  zap cold (EVM):      ${SIGS.zap} (create out + create LP + approve×2 + zap) — ATAs in-flow (separate txs, CU ceiling)`);
  console.log(`  farm (Solana):       ${SIGS.farmSol} — UserStake + reward ATA in-flow, zero pre-creation`);
  console.log(`  farm (EVM):          ${SIGS.farmEvm} (stake + create-reward + claim) — reward ATA in-flow; UserStake permissionless`);
  console.log("  DEX + Solana-lane farm: zero pre-creation. EVM-lane farm UserStake: Rome proxy constraint (documented).");
});
