// orders-cancel-newuser.test.mjs — BRAND-NEW-WALLET ACCEPTANCE for order CANCEL,
// BOTH lanes (operator standing rule: test every feature with a fresh wallet +
// tiny amount; the first-time/cold path is where bugs hide — memory
// feedback_brand_new_wallet_testing).
//
// A fresh wallet PLACES an order (real app helpers from ../app/lib/orders.ts —
// orderPda/escrowFor/ownerAta/placeData/cancelData/parseOrder, same as
// orders-newuser.test.mjs) then CANCELS it with its OWN signature, and we assert:
//   • the escrow ATA + order-state account are CLOSED after cancel (rent reclaimed)
//   • the escrowed input is refunded to the owner
//   • the owner's lamports went up by ~the reclaimed rent (Solana lane)
// The Cancel encoding (tag 2 + accounts [order(w), owner(s,w), input_escrow(w),
// owner_src(w), token_program]) is copied from orders-close.test.mjs 58-59 and
// the app's cancelData() (app/lib/orders.ts 111); the account order matches the
// on-chain doc at orders/src/instruction.rs 44.
//
// EVM lane: the Orders program's Cancel IS authority-agnostic — orders/src/
// processor.rs `fn cancel` gates only on `!owner_ai.is_signer || *owner_ai.key !=
// order.owner`, the SAME seam Place uses. On the EVM lane the owner is the
// caller's external_auth PDA, which the CPI precompile (0xFF..08) auto-signs — so
// an EVM user can cancel exactly as they Place (orders.test.mjs / orders-newuser
// prove EVM-lane Place). This EVM-cancel path is NOT exercised by any pre-existing
// test — it is derived from the verified authority-agnostic handler, so verify it
// on-chain before trusting it (see the report's UNSURE flags).
//
// Run (tsx loader — app helpers are TypeScript):
//   HADRIAN_PRIVATE_KEY=$(…) node --import tsx --test orders-cancel-newuser.test.mjs
// Solana-lane test runs without the key; the EVM-lane test skips without it
// (mirrors orders-newuser.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, transfer,
  createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ethers } from "ethers";
import {
  conn, payer, PK, evmPdaFor, EVM_RPC, CHAIN_ID, resolveGas, evmRpc, b32, tiers, execSolana,
} from "./lib.mjs";
// THE REAL APP CODE under test — derivation + encoding, imported directly:
import {
  orderPda, escrowFor, ownerAta, placeData, cancelData, parseOrder,
  ORDERS_PROGRAM, KEEPER_FEE_BPS, DEFAULT_EXPIRY_SECS,
} from "../app/lib/orders.ts";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const HELPER = "0xff00000000000000000000000000000000000009";
const CPI = "0xFF00000000000000000000000000000000000008";
const TOKEN = TOKEN_PROGRAM_ID;
const SYSTEM = SystemProgram.programId;
const P = tiers.find((t) => t.tier === "0.30%");
const SRC = new PublicKey(P.mintA), DST = new PublicKey(P.mintB); // USDC → SOL
const AMOUNT = 100_000n; // 0.1 USDC — tiny

const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const ataFor = (owner, mint) => getAssociatedTokenAddressSync(PK(mint), PK(owner), true, TOKEN_PROGRAM_ID);
const exists = async (pk) => !!(await conn.getAccountInfo(PK(pk)));
const bal = async (a) => { try { return (await getAccount(conn, PK(a))).amount; } catch { return 0n; } };
const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const HELPER_IFACE = new ethers.Interface([
  "function create_ata_for_key(bytes32 wallet, bytes32 mint)",
  "function swap_gas_to_lamports(uint64 lamports)",
]);
const CPI_IFACE = new ethers.Interface([
  "function invoke(bytes32 program, (bytes32 pubkey, bool is_signer, bool is_writable)[] accounts, bytes data)",
]);

// ── Solana lane: a BRAND-NEW keypair places then cancels, rent fully reclaimed ──
test("ORDERS CANCEL (Solana lane) — fresh keypair, escrow+state closed, rent refunded", async () => {
  const user = Keypair.generate();
  // Fund ONLY what a real new user has: a little SOL (gas/rent) + received USDC.
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 50_000_000 })),
    [payer], { commitment: "confirmed" });
  const userSrc = (await getOrCreateAssociatedTokenAccount(conn, payer, SRC, user.publicKey)).address;
  await transfer(conn, payer, ataFor(payer.publicKey, SRC), userSrc, payer, AMOUNT);

  // Place via the REAL app helpers (mirrors orders-newuser.test.mjs 94-114).
  const nonce = BigInt(Date.now());
  const [pda, bump] = orderPda(user.publicKey, nonce);
  const inEscrow = escrowFor(SRC, pda);
  const ownerDst = ownerAta(DST, user.publicKey);
  const data = placeData({
    nonce, bump, aToB: true, amountInTotal: AMOUNT, trancheIn: AMOUNT,
    minOutPerTranche: 1n, intervalSecs: 0n,
    expiryTs: BigInt(Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECS), keeperFeeBps: KEEPER_FEE_BPS,
  });
  const placeAccts = [
    acc(pda, 0, 1), acc(user.publicKey, 1, 0), acc(inEscrow, 0, 1), acc(userSrc, 0, 1),
    acc(ownerDst, 0, 0), acc(SRC, 0, 0), acc(DST, 0, 0), acc(P.swapState, 0, 0),
    acc(user.publicKey, 1, 1), acc(TOKEN, 0, 0), acc(SYSTEM, 0, 0),
  ];
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(user.publicKey, PK(inEscrow), PK(pda), SRC))
    .add({ programId: PK(ORDERS_PROGRAM), keys: placeAccts.map((a) => ({ ...a })), data }), [user], { commitment: "confirmed" });
  assert.ok(await exists(inEscrow), "input escrow created at place");
  assert.ok(await exists(pda), "order state created at place");
  assert.equal(parseOrder((await conn.getAccountInfo(PK(pda))).data).status, 0, "order Open before cancel");

  // Cancel — the FRESH key (owner) signs; escrow + state closed, input + rent refunded.
  const before = await conn.getBalance(user.publicKey);
  const srcBefore = await bal(userSrc);
  const r = await execSolana({
    programId: ORDERS_PROGRAM, signer: user,
    accounts: [acc(pda, 0, 1), acc(user.publicKey, 1, 1), acc(inEscrow, 0, 1), acc(userSrc, 0, 1), acc(TOKEN, 0, 0)],
    data: cancelData(), // tag 2 (orders-close.test.mjs 58-59 / app cancelData)
  });
  assert.ok(r.ok, "cancel landed");
  assert.equal(await exists(inEscrow), false, "escrow ATA closed (rent reclaimed)");
  assert.equal(await exists(pda), false, "order state account closed (rent reclaimed)");
  assert.equal((await bal(userSrc)) - srcBefore, AMOUNT, "escrowed input refunded to the owner");
  const after = await conn.getBalance(user.publicKey);
  // owner regained escrow+state rent (~0.0036 SOL) minus the cancel tx fee (~5000 lamports).
  assert.ok(after > before + 3_000_000, `owner reclaimed rent (Δ=${after - before} lamports)`);
  console.log(`  Solana new-user: place (fresh key) + cancel · input refunded ${AMOUNT} · rent Δ=${after - before} lamports`);
});

// ── EVM lane: a BRAND-NEW EVM key places via CPI (owner = its external_auth PDA)
// then cancels via CPI — Rome auto-signs the off-curve owner PDA, the same
// authority-agnostic seam Place uses (orders/src/processor.rs `cancel`). Mirrors
// the fresh-EVM Place in orders-newuser.test.mjs 135-179; the cancel reuses the
// verified Cancel account layout (orders-close.test.mjs 58 / instruction.rs 44).
test("ORDERS CANCEL (EVM lane) — fresh EVM key, off-curve owner, escrow+state closed", { skip: !KEY }, async () => {
  const wallet = ethers.Wallet.createRandom().connect(provider);
  const owner = evmPdaFor(wallet.address); // external_auth PDA — OFF-CURVE
  const dep = new ethers.Wallet(KEY.trim(), provider);
  // 0.5 ETH: this flow calls swap_gas_to_lamports(10M) to bootstrap PDA rent
  // (converts gas→SOL, which burns real ETH value) on top of place+cancel — so it
  // needs more than the 0.05 the rent-free EVM gap tests use. Still 10× under the
  // original 5. Unspent stays in the throwaway wallet (deployer gas is non-scarce).
  await (await dep.sendTransaction({ to: wallet.address, value: ethers.parseEther("0.5") })).wait(1);
  const ownerSrc = (await getOrCreateAssociatedTokenAccount(conn, payer, SRC, PK(owner), true)).address;
  await transfer(conn, payer, ataFor(payer.publicKey, SRC), ownerSrc, payer, AMOUNT);

  const nonce = BigInt(Date.now() + 1);
  const [pda, bump] = orderPda(owner, nonce);
  const inEscrow = escrowFor(SRC, pda);
  const ownerDst = ownerAta(DST, owner); // must NOT throw for the off-curve owner

  const send = async (to, data) => {
    const g = await resolveGas({ from: wallet.address, to, data });
    const nn = await provider.getTransactionCount(wallet.address, "pending");
    const signed = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce: nn, ...g, to, value: 0n, data });
    const s = await evmRpc("eth_sendRawTransaction", [signed]);
    if (s.error) throw new Error(JSON.stringify(s.error).slice(0, 200));
    await provider.waitForTransaction(s.result, 1, 120000);
  };

  // Cold PDA: bootstrap rent from gas, create the input escrow, then Place
  // (mirrors placeOrderEvm's cold-PDA path, orders-newuser.test.mjs 164-179).
  await send(HELPER, HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [10_000_000n]));
  await send(HELPER, HELPER_IFACE.encodeFunctionData("create_ata_for_key", [b32(pda), b32(SRC)]));
  const data = placeData({
    nonce, bump, aToB: true, amountInTotal: AMOUNT, trancheIn: AMOUNT,
    minOutPerTranche: 1n, intervalSecs: 0n,
    expiryTs: BigInt(Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECS), keeperFeeBps: KEEPER_FEE_BPS,
  });
  const placeAccts = [
    [b32(pda), false, true], [b32(owner), true, false], [b32(inEscrow), false, true], [b32(ownerSrc), false, true],
    [b32(ownerDst), false, false], [b32(SRC), false, false], [b32(DST), false, false], [b32(PK(P.swapState)), false, false],
    [b32(owner), true, true], [b32(TOKEN), false, false], [b32(SYSTEM), false, false],
  ];
  await send(CPI, CPI_IFACE.encodeFunctionData("invoke", [b32(ORDERS_PROGRAM), placeAccts, "0x" + data.toString("hex")]));
  assert.ok(await exists(inEscrow), "input escrow created (EVM place)");
  assert.equal(parseOrder((await conn.getAccountInfo(PK(pda))).data).status, 0, "order Open before cancel");

  // Cancel via CPI — owner PDA is a signer (auto-signed by Rome), owner_src is the
  // PDA's USDC ATA (refund target), rent returns to the owner PDA. Accounts mirror
  // orders-close.test.mjs 58 (order(w), owner(s,w), input_escrow(w), owner_src(w), token).
  const cancelAccts = [
    [b32(pda), false, true], [b32(owner), true, true], [b32(inEscrow), false, true], [b32(ownerSrc), false, true], [b32(TOKEN), false, false],
  ];
  await send(CPI, CPI_IFACE.encodeFunctionData("invoke", [b32(ORDERS_PROGRAM), cancelAccts, "0x" + cancelData().toString("hex")]));
  assert.equal(await exists(inEscrow), false, "escrow ATA closed (EVM cancel)");
  assert.equal(await exists(pda), false, "order state account closed (EVM cancel)");
  assert.equal(await bal(ownerSrc), AMOUNT, "escrowed input refunded to the owner PDA's ATA");
  console.log("  EVM brand-new-user: place + cancel via CPI · escrow + order state closed · rent+input refunded to the owner PDA");
});
