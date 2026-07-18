// keeper.test.mjs — proves the permissionless keeper fills a live order end to
// end: place a fillable limit order, run one keeper pass, assert it executed
// (order → Filled, owner received output). Roadmap #3, PR ③.
//
// Run: node --test keeper.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { conn, payer, PK, bal, ensureAta, execSolana, tiers } from "./lib.mjs";
import { runOnce, ORDERS_PROGRAM, parseOrder } from "./keeper.mjs";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = SystemProgram.programId;
const P = tiers.find((t) => t.tier === "0.30%");
const SRC_MINT = new PublicKey(P.mintA), DST_MINT = new PublicKey(P.mintB);
const AMOUNT_IN = 100_000n;

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const orderPda = (owner, nonce) =>
  PublicKey.findProgramAddressSync([Buffer.from("order"), PK(owner).toBuffer(), u64(nonce)], ORDERS_PROGRAM);

test("keeper fills a fresh fillable limit order", async () => {
  const nonce = BigInt(Math.floor(Date.now()));
  const [pda, bump] = orderPda(payer.publicKey, nonce);
  const inEsc = await ensureAta(SRC_MINT, pda, true);
  const ownerSrc = await ensureAta(SRC_MINT, payer.publicKey);
  const ownerDst = await ensureAta(DST_MINT, payer.publicKey);
  assert.ok((await bal(ownerSrc)) >= AMOUNT_IN, "owner funded");

  // Place a one-shot limit order that's immediately fillable (min_out = 1).
  const placeData = Buffer.concat([
    Buffer.from([0]), u64(nonce), Buffer.from([bump]), Buffer.from([1]),
    u64(AMOUNT_IN), u64(AMOUNT_IN), u64(1n), u64(0n),
    i64(Math.floor(Date.now() / 1000) + 3600), u16(10),
  ]);
  await execSolana({
    programId: ORDERS_PROGRAM,
    accounts: [
      acc(pda, 0, 1), acc(payer.publicKey, 1, 0), acc(inEsc, 0, 1),
      acc(ownerSrc, 0, 1), acc(ownerDst, 0, 0), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0),
      acc(P.swapState, 0, 0), acc(payer.publicKey, 1, 1), acc(TOKEN, 0, 0), acc(SYSTEM, 0, 0),
    ],
    data: placeData,
  });
  assert.equal(await bal(inEsc), AMOUNT_IN, "order placed + escrow funded");

  const dstBefore = await bal(ownerDst);
  const logs = [];
  // Targeted mode (pass the known order pubkey); discovery via signatures is
  // exercised separately and isn't what this proof is about.
  const r = await runOnce({ orders: [pda.toBase58()], log: (m) => logs.push(m) });

  assert.ok(r.filled >= 1, `keeper filled ≥1 order (filled=${r.filled}, scanned=${r.scanned})`);
  const after = parseOrder((await conn.getAccountInfo(pda)).data);
  assert.equal(after.status, 1, "our order is now Filled");
  assert.equal(after.remainingIn, 0n, "fully executed");
  assert.ok((await bal(ownerDst)) > dstBefore, "owner received output from the keeper fill");
});
