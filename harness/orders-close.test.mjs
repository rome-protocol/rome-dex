// orders-close.test.mjs — HARDENING proof (audit finding #1: rent reclamation).
// Cancel now refunds the token balance AND closes the escrow ATA + order state
// account, returning ALL rent to the owner (nothing stranded). CloseFilled
// (tag 4, permissionless) reclaims a fully-filled order's rent. Verifies on the
// redeployed program that after these, the escrow + order accounts are GONE and
// the owner's lamports went up by ~the reclaimed rent.
//
// Run: node --test orders-close.test.mjs   (Solana lane, local payer.)

import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, transfer, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { conn, payer, PK, bal, ensureAta, execSolana, tiers } from "./lib.mjs";

const ORDERS = new PublicKey("ordWTztCBW7fpoq6eLHQBp2aeoB17CAbmAx6FjtfQ7C");
const TOKEN = TOKEN_PROGRAM_ID;
const SYSTEM = SystemProgram.programId;
const P = tiers.find((t) => t.tier === "0.30%");
const SRC = new PublicKey(P.mintA), DST = new PublicKey(P.mintB);
const AMOUNT = 100_000n, FEE_BPS = 10;

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const orderPda = (owner, nonce) => PublicKey.findProgramAddressSync([Buffer.from("order"), PK(owner).toBuffer(), u64(nonce)], ORDERS);
const escrowFor = (mint, pda) => getAssociatedTokenAddressSync(mint, PK(pda), true);
const exists = async (pk) => !!(await conn.getAccountInfo(PK(pk)));
const placeData = (o) => Buffer.concat([Buffer.from([0]), u64(o.nonce), Buffer.from([o.bump]), Buffer.from([1]), u64(o.amt), u64(o.tranche), u64(o.min), u64(o.interval), i64(o.expiry), u16(FEE_BPS)]);

async function placeOrder(nonce, minOut, interval) {
  const [pda, bump] = orderPda(payer.publicKey, nonce);
  const inEscrow = escrowFor(SRC, pda);
  const ownerSrc = (await getOrCreateAssociatedTokenAccount(conn, payer, SRC, payer.publicKey)).address;
  const ownerDst = await ensureAta(DST, payer.publicKey);
  await transfer(conn, payer, ownerSrc, ownerSrc, payer, 0n).catch(() => {}); // no-op ensure
  if ((await bal(ownerSrc)) < AMOUNT) await transfer(conn, payer, await ensureAta(SRC, payer.publicKey), ownerSrc, payer, AMOUNT);
  const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, PK(inEscrow), PK(pda), SRC))
    .add({ programId: ORDERS, keys: [
      acc(pda, 0, 1), acc(payer.publicKey, 1, 0), acc(inEscrow, 0, 1), acc(ownerSrc, 0, 1),
      acc(ownerDst, 0, 0), acc(SRC, 0, 0), acc(DST, 0, 0), acc(P.swapState, 0, 0),
      acc(payer.publicKey, 1, 1), acc(TOKEN, 0, 0), acc(SYSTEM, 0, 0),
    ], data: placeData({ nonce, bump, amt: AMOUNT, tranche: AMOUNT, min: minOut, interval, expiry: Math.floor(Date.now() / 1000) + 3600 }) });
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  return { pda: pda.toBase58(), inEscrow: inEscrow.toBase58(), ownerSrc };
}

test("Cancel closes escrow + state and returns rent (nothing stranded)", async () => {
  const nonce = BigInt(Date.now());
  const o = await placeOrder(nonce, 1n, 0n);
  assert.ok(await exists(o.inEscrow), "escrow exists after place");
  assert.ok(await exists(o.pda), "order state exists after place");
  const before = await conn.getBalance(payer.publicKey);
  await execSolana({
    programId: ORDERS,
    accounts: [acc(o.pda, 0, 1), acc(payer.publicKey, 1, 1), acc(o.inEscrow, 0, 1), acc(o.ownerSrc, 0, 1), acc(TOKEN, 0, 0)],
    data: Buffer.from([2]), // Cancel
  });
  assert.equal(await exists(o.inEscrow), false, "escrow ATA closed (rent reclaimed)");
  assert.equal(await exists(o.pda), false, "order state account closed (rent reclaimed)");
  const after = await conn.getBalance(payer.publicKey);
  // owner regained escrow+state rent (~0.0036 SOL) minus the cancel tx fee (~5000 lamports).
  assert.ok(after > before + 3_000_000, `owner reclaimed rent (Δ=${after - before} lamports)`);
});

test("CloseFilled reclaims a fully-filled order's rent (permissionless)", async () => {
  const nonce = BigInt(Date.now()) + 1n;
  const o = await placeOrder(nonce, 1n, 0n);
  // Fill it via Execute (keeper = payer): drains escrow, flips Filled.
  const keeperFee = await ensureAta(SRC, payer.publicKey);
  const ownerDst = await ensureAta(DST, payer.publicKey);
  const DEX = new PublicKey(P.program);
  await execSolana({
    programId: ORDERS,
    accounts: [
      acc(o.pda, 0, 1), acc(o.inEscrow, 0, 1), acc(ownerDst, 0, 1), acc(keeperFee, 0, 1),
      acc(DEX, 0, 0), acc(P.swapState, 0, 1), acc(P.authority, 0, 0), acc(P.vaultA, 0, 1), acc(P.vaultB, 0, 1),
      acc(P.poolMint, 0, 1), acc(P.feeAccount, 0, 1), acc(SRC, 0, 0), acc(DST, 0, 0), acc(TOKEN, 0, 0),
    ],
    data: Buffer.from([1]), // Execute
  });
  assert.ok(await exists(o.pda), "filled order state still exists (rent not yet reclaimed)");
  const before = await conn.getBalance(payer.publicKey);
  // CloseFilled (tag 4), permissionless — payer stands in for a keeper/cleaner.
  await execSolana({
    programId: ORDERS,
    accounts: [acc(o.pda, 0, 1), acc(payer.publicKey, 0, 1), acc(o.inEscrow, 0, 1), acc(TOKEN, 0, 0)],
    data: Buffer.from([4]),
  });
  assert.equal(await exists(o.inEscrow), false, "filled escrow closed");
  assert.equal(await exists(o.pda), false, "filled order state closed");
  const after = await conn.getBalance(payer.publicKey);
  assert.ok(after > before, `owner reclaimed filled-order rent (Δ=${after - before} lamports)`);
});
