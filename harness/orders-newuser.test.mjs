// orders-newuser.test.mjs — BRAND-NEW-WALLET ACCEPTANCE for limit orders, BOTH
// lanes (operator standing rule: test every feature with a fresh wallet + tiny
// amount; the first-time/cold path is where bugs hide — see memory
// feedback_brand_new_wallet_testing).
//
// The distinguishing feature of this test: it drives placement through the
// **app's REAL derivation/encoding helpers** imported from ../app/lib/orders.ts
// (orderPda, escrowFor, ownerAta, placeData, parseOrder) — NOT a harness mirror.
// That's the whole point: the TokenOwnerOffCurveError bug (fix #33) slipped past
// the mirror-based harness precisely because the mirror passed allowOwnerOffCurve
// while the app helper didn't. Here, if ownerAta / escrowFor / placeData / the
// PDA derivation regress, a fresh-wallet place breaks on-chain.
//
// Run (tsx loader — app helpers are TypeScript):
//   HADRIAN_PRIVATE_KEY=$(…) node --import tsx --test orders-newuser.test.mjs
// Solana-lane test runs without the key; the EVM-lane test skips without it.

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

// Pure ATA-address derivation (no create). allowOwnerOffCurve for the EVM-lane
// external_auth PDA / order-PDA owners; on-curve wallets derive identically.
const ataFor = (owner, mint) => getAssociatedTokenAddressSync(PK(mint), PK(owner), true, TOKEN_PROGRAM_ID);
// THE REAL APP CODE under test — derivation + encoding, imported directly:
import {
  orderPda, escrowFor, ownerAta, placeData, parseOrder,
  ORDERS_PROGRAM, KEEPER_FEE_BPS, DEFAULT_EXPIRY_SECS,
} from "../app/lib/orders.ts";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const HELPER = "0xff00000000000000000000000000000000000009";
const CPI = "0xFF00000000000000000000000000000000000008";
const TOKEN = TOKEN_PROGRAM_ID;
const SYSTEM = SystemProgram.programId;
const P = tiers.find((t) => t.tier === "0.30%");
const SRC = new PublicKey(P.mintA), DST = new PublicKey(P.mintB); // USDC → SOL
const DEX = new PublicKey(P.program);
const AMOUNT = 100_000n; // 0.1 USDC — tiny

const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const exists = async (pk) => !!(await conn.getAccountInfo(PK(pk)));
const bal = async (a) => { try { return (await getAccount(conn, PK(a))).amount; } catch { return 0n; } };
const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const HELPER_IFACE = new ethers.Interface([
  "function create_ata(address user, bytes32 mint)",
  "function create_ata_for_key(bytes32 wallet, bytes32 mint)",
  "function swap_gas_to_lamports(uint64 lamports)",
]);
const CPI_IFACE = new ethers.Interface([
  "function invoke(bytes32 program, (bytes32 pubkey, bool is_signer, bool is_writable)[] accounts, bytes data)",
]);

// Execute (14 accts, fee-from-input) — the keeper leg, run by the local payer.
// Provisions the owner's dst ATA IN-FLOW first (deferred to fill in this model).
async function keeperFill(order, ownerPk) {
  const dstAta = ataFor(ownerPk, DST);
  await getOrCreateAssociatedTokenAccount(conn, payer, DST, PK(ownerPk), true); // in-flow, keeper-paid
  const keeperFee = ataFor(payer.publicKey, SRC); // fee paid in INPUT token
  await getOrCreateAssociatedTokenAccount(conn, payer, SRC, payer.publicKey);
  const before = await bal(dstAta);
  const r = await execSolana({
    programId: ORDERS_PROGRAM,
    accounts: [
      acc(order.pda, 0, 1), acc(order.inputEscrow, 0, 1), acc(dstAta, 0, 1), acc(keeperFee, 0, 1),
      acc(DEX, 0, 0), acc(P.swapState, 0, 1), acc(P.authority, 0, 0), acc(P.vaultA, 0, 1), acc(P.vaultB, 0, 1),
      acc(P.poolMint, 0, 1), acc(P.feeAccount, 0, 1), acc(SRC, 0, 0), acc(DST, 0, 0), acc(TOKEN, 0, 0),
    ],
    data: Buffer.from([1]),
  });
  return { r, dstAta, gained: (await bal(dstAta)) - before };
}

// ── Solana lane: a BRAND-NEW keypair places + gets filled, zero pre-creation ──
test("ORDERS (Solana lane) — fresh keypair, real app helpers, in-flow accounts", async () => {
  const user = Keypair.generate();
  // Fund ONLY what a real new user has: a little SOL (gas/rent) + received USDC.
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 50_000_000 })),
    [payer], { commitment: "confirmed" });
  const userSrc = (await getOrCreateAssociatedTokenAccount(conn, payer, SRC, user.publicKey)).address;
  await transfer(conn, payer, ataFor(payer.publicKey, SRC), userSrc, payer, AMOUNT);

  // Derive via the REAL app helpers (ownerAta on the fresh on-curve owner, etc.).
  const nonce = BigInt(Date.now());
  const [pda, bump] = orderPda(user.publicKey, nonce);
  const inEscrow = escrowFor(SRC, pda);
  const ownerDst = ownerAta(DST, user.publicKey);
  assert.equal(await exists(inEscrow), false, "input escrow must NOT be pre-created");
  assert.equal(await exists(ownerDst), false, "owner dst ATA must NOT be pre-created (deferred to fill)");

  // Place: create the input escrow in-flow + place, all signed by the FRESH key.
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
  const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(user.publicKey, PK(inEscrow), PK(pda), SRC))
    .add({ programId: PK(ORDERS_PROGRAM), keys: placeAccts.map((a) => ({ ...a })), data });
  await sendAndConfirmTransaction(conn, tx, [user], { commitment: "confirmed" });

  assert.equal(await exists(inEscrow), true, "input escrow created in-flow at place");
  const parsed = parseOrder((await conn.getAccountInfo(PK(pda))).data); // real app parser
  assert.equal(parsed.status, 0, "order Open");
  assert.equal(parsed.owner, user.publicKey.toBase58(), "owner = fresh key");
  assert.equal(parsed.remainingIn, AMOUNT, "full amount escrowed");

  // Keeper fills → the fresh owner's dst ATA is created in-flow + receives output.
  const { r, dstAta, gained } = await keeperFill({ pda: pda.toBase58(), inputEscrow: inEscrow.toBase58() }, user.publicKey);
  assert.ok(r.ok, "keeper execute landed");
  assert.equal(await exists(dstAta), true, "fresh owner dst ATA created in-flow at fill");
  assert.ok(gained > 0n, `fresh owner received output (got ${gained})`);
  const filled = parseOrder((await conn.getAccountInfo(PK(pda))).data);
  assert.equal(filled.status, 1, "order Filled");
  assert.equal(filled.remainingIn, 0n, "fully executed");
  console.log(`  Solana new-user: place 1 tx (fresh key) + keeper fill · owner +${gained} SOL · zero pre-creation`);
});

// ── EVM lane: a BRAND-NEW EVM key places via the CPI precompile (owner = its
// external_auth PDA — OFF-CURVE, the exact ownerAta case that broke in #33) ──
test("ORDERS (EVM lane) — fresh EVM key, off-curve owner via real helpers", { skip: !KEY }, async () => {
  const wallet = ethers.Wallet.createRandom().connect(provider);
  const owner = evmPdaFor(wallet.address); // external_auth PDA — OFF-CURVE
  const dep = new ethers.Wallet(KEY.trim(), provider);
  await (await dep.sendTransaction({ to: wallet.address, value: ethers.parseEther("5") })).wait(1);
  // Receive USDC into the PDA's input ATA (the one legit pre-provision).
  const ownerSrc = (await getOrCreateAssociatedTokenAccount(conn, payer, SRC, PK(owner), true)).address;
  await transfer(conn, payer, ataFor(payer.publicKey, SRC), ownerSrc, payer, AMOUNT);

  // REAL app helpers on the OFF-CURVE owner — this is where #33 threw.
  const nonce = BigInt(Date.now() + 1);
  const [pda, bump] = orderPda(owner, nonce);
  const inEscrow = escrowFor(SRC, pda);
  const ownerDst = ownerAta(DST, owner); // must NOT throw for off-curve owner
  assert.equal(await exists(inEscrow), false, "input escrow not pre-created");

  const send = async (to, data) => {
    const g = await resolveGas({ from: wallet.address, to, data });
    const nn = await provider.getTransactionCount(wallet.address, "pending");
    const signed = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce: nn, ...g, to, value: 0n, data });
    const s = await evmRpc("eth_sendRawTransaction", [signed]);
    if (s.error) throw new Error(JSON.stringify(s.error).slice(0, 200));
    await provider.waitForTransaction(s.result, 1, 120000);
  };

  // Brand-new EVM user: the external_auth PDA has ZERO SOL, but Place pays the
  // order-account rent from it. Bootstrap the PDA's rent from gas first
  // (self-paid, one-time) — mirrors placeOrderEvm's cold-PDA path. This is the
  // first-time gap this acceptance test exists to catch.
  assert.equal(await conn.getBalance(PK(owner)), 0, "brand-new EVM PDA starts with 0 SOL");
  await send(HELPER, HELPER_IFACE.encodeFunctionData("swap_gas_to_lamports", [10_000_000n]));
  assert.ok((await conn.getBalance(PK(owner))) >= 10_000_000, "PDA rent bootstrapped from gas");
  // Then create input escrow (create_ata_for_key) + place.
  await send(HELPER, HELPER_IFACE.encodeFunctionData("create_ata_for_key", [b32(pda), b32(SRC)]));
  const data = placeData({
    nonce, bump, aToB: true, amountInTotal: AMOUNT, trancheIn: AMOUNT,
    minOutPerTranche: 1n, intervalSecs: 0n,
    expiryTs: BigInt(Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECS), keeperFeeBps: KEEPER_FEE_BPS,
  });
  const placeAccts = [
    [b32(pda), false, true], [b32(owner), true, false], [b32(inEscrow), false, true], [b32(ownerSrc), false, true],
    [b32(ownerDst), false, false], [b32(SRC), false, false], [b32(DST), false, false], [b32(new PublicKey(P.swapState)), false, false],
    [b32(owner), true, true], [b32(TOKEN), false, false], [b32(SYSTEM), false, false],
  ];
  await send(CPI, CPI_IFACE.encodeFunctionData("invoke", [b32(ORDERS_PROGRAM), placeAccts, "0x" + data.toString("hex")]));

  assert.equal(await exists(inEscrow), true, "input escrow created (EVM lane) — off-curve helpers worked");
  const parsed = parseOrder((await conn.getAccountInfo(PK(pda))).data);
  assert.equal(parsed.status, 0, "order Open");
  assert.equal(parsed.owner, owner.toBase58(), "owner = fresh EVM key's external_auth PDA");

  // Keeper fills → the fresh EVM user's dst ATA is created in-flow + paid.
  const { r, dstAta, gained } = await keeperFill({ pda: pda.toBase58(), inputEscrow: inEscrow.toBase58() }, owner);
  assert.ok(r.ok, "keeper execute landed");
  assert.equal(await exists(dstAta), true, "fresh EVM user dst ATA created in-flow at fill");
  assert.ok(gained > 0n, `fresh EVM user received output (got ${gained})`);
  console.log(`  EVM brand-new-user: 3 prompts (gas→lamports + create input escrow + place); warm PDA = 2 · keeper fill · owner +${gained} SOL`);
});
