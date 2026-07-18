// rome-dex ORDERS — on-chain limit-order proof (roadmap #3, PR ②).
//
// Proves the crux on the Solana lane against the deployed orders program:
//   Place → Execute where the order PDA signs the DEX swap via invoke_signed
//   (orders → DEX → spl_token), output lands in the owner's ATA, keeper is
//   paid, and the order flips to Filled. Plus two adversarial cases: a
//   substituted DEX program is rejected, and an impossible limit reverts on the
//   DEX's own slippage guard (the keeper cannot fill below the limit).
//
// Run: node --test orders.test.mjs   (Solana lane uses the local payer.)

import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ethers } from "ethers";
import { conn, payer, PK, bal, ensureAta, execSolana, execEvmCpi, evmPdaFor, EVM_DEPLOYER, EVM_RPC, CHAIN_ID, b32, resolveGas, evmRpc, tiers } from "./lib.mjs";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const HELPER = "0xFF00000000000000000000000000000000000009";
const HELPER_IFACE = new ethers.Interface([
  "function create_ata_for_key(bytes32 wallet, bytes32 mint)",
  "function create_ata(address user, bytes32 mint)",
]);

// Direct HELPER (0xff..09) call on the EVM lane — how a wallet-only MetaMask user
// creates the order-PDA-owned escrows (create_ata_for_key, operator pays rent)
// and their own output ATA (create_ata). This is what makes EVM-lane order
// placement work without any Solana keypair pre-creation.
async function evmHelper(fn, args, key) {
  const data = HELPER_IFACE.encodeFunctionData(fn, args);
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const w = new ethers.Wallet(key.trim(), provider);
  const nonce = await provider.getTransactionCount(w.address, "pending");
  const g = await resolveGas({ from: w.address, to: HELPER, data });
  const signed = await w.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g, to: HELPER, value: 0n, data });
  const send = await evmRpc("eth_sendRawTransaction", [signed]);
  if (send.error) throw new Error(JSON.stringify(send.error).slice(0, 200));
  await provider.waitForTransaction(send.result, 1, 120000).catch(() => null);
}

const ORDERS_PROGRAM = new PublicKey("ordWTztCBW7fpoq6eLHQBp2aeoB17CAbmAx6FjtfQ7C");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = SystemProgram.programId;
const P = tiers.find((t) => t.tier === "0.30%"); // USDC/SOL 0.30%
const DEX = new PublicKey(P.program);

// ---- encoders (mirror orders/src/instruction.rs) ----
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const placeData = (o) => Buffer.concat([
  Buffer.from([0]), u64(o.nonce), Buffer.from([o.bump]), Buffer.from([o.aToB ? 1 : 0]),
  u64(o.amountInTotal), u64(o.trancheIn), u64(o.minOut), u64(o.interval), i64(o.expiry), u16(o.keeperFeeBps),
]);
const executeData = () => Buffer.from([1]);

const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });
const orderPda = (owner, nonce) =>
  PublicKey.findProgramAddressSync([Buffer.from("order"), PK(owner).toBuffer(), u64(nonce)], ORDERS_PROGRAM);

// a_to_b = true → sell USDC (mintA) for SOL (mintB).
const SRC_MINT = new PublicKey(P.mintA), DST_MINT = new PublicKey(P.mintB);
const AMOUNT_IN = 100_000n; // 0.1 USDC (6 dp)
const KEEPER_FEE_BPS = 10;

const keeper = Keypair.generate();
const S = {};

test("setup: order PDA + input escrow + owner/keeper ATAs", async () => {
  S.nonce = BigInt(Math.floor(Date.now())); // fresh order each run
  const [pda, bump] = orderPda(payer.publicKey, S.nonce);
  S.pda = pda; S.bump = bump;
  // Single escrow (fee-from-input model): the INPUT escrow, an ATA OWNED BY the
  // order PDA (off-curve owner). No output escrow any more.
  S.inEscrow = await ensureAta(SRC_MINT, pda, true);
  // Owner's source (USDC) + destination (SOL); the keeper's fee ATA is now the
  // INPUT mint (USDC) — the keeper is paid in the input token, not the output.
  S.ownerSrc = await ensureAta(SRC_MINT, payer.publicKey);
  S.ownerDst = await ensureAta(DST_MINT, payer.publicKey);
  S.keeperFee = await ensureAta(SRC_MINT, keeper.publicKey);
  assert.ok((await bal(S.ownerSrc)) >= AMOUNT_IN, "owner funded with input USDC");
});

test("Place: funds move owner → input escrow, order Open", async () => {
  const before = await bal(S.ownerSrc);
  const r = await execSolana({
    programId: ORDERS_PROGRAM,
    accounts: [
      acc(S.pda, 0, 1), acc(payer.publicKey, 1, 0), acc(S.inEscrow, 0, 1),
      acc(S.ownerSrc, 0, 1), acc(S.ownerDst, 0, 0), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0),
      acc(P.swapState, 0, 0), acc(payer.publicKey, 1, 1), acc(TOKEN, 0, 0), acc(SYSTEM, 0, 0),
    ],
    data: placeData({
      nonce: S.nonce, bump: S.bump, aToB: true, amountInTotal: AMOUNT_IN, trancheIn: AMOUNT_IN,
      minOut: 1n, interval: 0n, expiry: Math.floor(Date.now() / 1000) + 3600, keeperFeeBps: KEEPER_FEE_BPS,
    }),
  });
  assert.ok(r.ok, "place ok");
  assert.equal(await bal(S.inEscrow), AMOUNT_IN, "escrow holds the input");
  assert.equal(await bal(S.ownerSrc) + AMOUNT_IN, before, "owner debited");
});

test("Execute (THE CRUX): orders → DEX invoke_signed lands, output delivered", async () => {
  const dstBefore = await bal(S.ownerDst);
  const feeBefore = await bal(S.keeperFee);
  const r = await execSolana({
    programId: ORDERS_PROGRAM,
    accounts: [
      acc(S.pda, 0, 1), acc(S.inEscrow, 0, 1), acc(S.ownerDst, 0, 1), acc(S.keeperFee, 0, 1),
      acc(DEX, 0, 0), acc(P.swapState, 0, 1), acc(P.authority, 0, 0), acc(P.vaultA, 0, 1), acc(P.vaultB, 0, 1),
      acc(P.poolMint, 0, 1), acc(P.feeAccount, 0, 1), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0), acc(TOKEN, 0, 0),
    ],
    data: executeData(),
  });
  assert.ok(r.ok, "execute ok");
  const gained = (await bal(S.ownerDst)) - dstBefore;
  const fee = (await bal(S.keeperFee)) - feeBefore;
  // Fee-from-input: the keeper is paid in the INPUT token (USDC), skimmed from
  // the tranche = floor(tranche · bps / 1e4); the owner nets the FULL DST output.
  const expectedFee = (AMOUNT_IN * BigInt(KEEPER_FEE_BPS)) / 10_000n;
  assert.ok(gained > 0n, `owner received DST (SOL) output (got ${gained})`);
  assert.equal(fee, expectedFee, `keeper received input-token (USDC) fee (got ${fee}, want ${expectedFee})`);
  assert.equal(await bal(S.inEscrow), 0n, "input escrow drained (fee skimmed + remainder swapped)");
  console.log(`  Execute CU: ${r.cu} · owner +${gained} · keeper +${fee}`);
});

test("adversarial: Execute with a substituted DEX program is rejected", async () => {
  // Fresh order so it's still Open.
  const nonce = BigInt(Math.floor(Date.now()) + 1);
  const [pda, bump] = orderPda(payer.publicKey, nonce);
  const inEsc = await ensureAta(SRC_MINT, pda, true);
  await execSolana({
    programId: ORDERS_PROGRAM,
    accounts: [
      acc(pda, 0, 1), acc(payer.publicKey, 1, 0), acc(inEsc, 0, 1),
      acc(S.ownerSrc, 0, 1), acc(S.ownerDst, 0, 0), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0),
      acc(P.swapState, 0, 0), acc(payer.publicKey, 1, 1), acc(TOKEN, 0, 0), acc(SYSTEM, 0, 0),
    ],
    data: placeData({ nonce, bump, aToB: true, amountInTotal: AMOUNT_IN, trancheIn: AMOUNT_IN, minOut: 1n, interval: 0n, expiry: Math.floor(Date.now() / 1000) + 3600, keeperFeeBps: KEEPER_FEE_BPS }),
  });
  // Execute but pass the System program as the "DEX" → check_dex_program rejects.
  let failed = null;
  try {
    await execSolana({
      programId: ORDERS_PROGRAM,
      accounts: [
        acc(pda, 0, 1), acc(inEsc, 0, 1), acc(S.ownerDst, 0, 1), acc(S.keeperFee, 0, 1),
        acc(SYSTEM, 0, 0), acc(P.swapState, 0, 1), acc(P.authority, 0, 0), acc(P.vaultA, 0, 1), acc(P.vaultB, 0, 1),
        acc(P.poolMint, 0, 1), acc(P.feeAccount, 0, 1), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0), acc(TOKEN, 0, 0),
      ],
      data: executeData(),
    });
  } catch (e) { failed = String(e?.message ?? e); }
  assert.ok(failed, "substituted DEX program must be rejected");
  assert.match(failed, /0x5\b|custom program error: 0x5|IncorrectDexProgram/i, `expected IncorrectDexProgram, got: ${failed}`);
  // Clean up: cancel the leftover order so escrow is refunded.
  await execSolana({
    programId: ORDERS_PROGRAM,
    accounts: [acc(pda, 0, 1), acc(payer.publicKey, 1, 1), acc(inEsc, 0, 1), acc(S.ownerSrc, 0, 1), acc(TOKEN, 0, 0)],
    data: Buffer.from([2]), // Cancel
  }).catch(() => {});
});

test("adversarial: an impossible limit reverts on the DEX slippage guard", async () => {
  const nonce = BigInt(Math.floor(Date.now()) + 2);
  const [pda, bump] = orderPda(payer.publicKey, nonce);
  const inEsc = await ensureAta(SRC_MINT, pda, true);
  await execSolana({
    programId: ORDERS_PROGRAM,
    accounts: [
      acc(pda, 0, 1), acc(payer.publicKey, 1, 0), acc(inEsc, 0, 1),
      acc(S.ownerSrc, 0, 1), acc(S.ownerDst, 0, 0), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0),
      acc(P.swapState, 0, 0), acc(payer.publicKey, 1, 1), acc(TOKEN, 0, 0), acc(SYSTEM, 0, 0),
    ],
    // min_out absurdly high → per-tranche swap min unreachable → DEX slippage guard reverts.
    data: placeData({ nonce, bump, aToB: true, amountInTotal: AMOUNT_IN, trancheIn: AMOUNT_IN, minOut: 1_000_000_000_000n, interval: 0n, expiry: Math.floor(Date.now() / 1000) + 3600, keeperFeeBps: KEEPER_FEE_BPS }),
  });
  let failed = null;
  try {
    await execSolana({
      programId: ORDERS_PROGRAM,
      accounts: [
        acc(pda, 0, 1), acc(inEsc, 0, 1), acc(S.ownerDst, 0, 1), acc(S.keeperFee, 0, 1),
        acc(DEX, 0, 0), acc(P.swapState, 0, 1), acc(P.authority, 0, 0), acc(P.vaultA, 0, 1), acc(P.vaultB, 0, 1),
        acc(P.poolMint, 0, 1), acc(P.feeAccount, 0, 1), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0), acc(TOKEN, 0, 0),
      ],
      data: executeData(),
    });
  } catch (e) { failed = String(e?.message ?? e); }
  assert.ok(failed, "underpriced fill must revert (keeper cannot fill below the limit)");
  // Cancel to refund.
  await execSolana({
    programId: ORDERS_PROGRAM,
    accounts: [acc(pda, 0, 1), acc(payer.publicKey, 1, 1), acc(inEsc, 0, 1), acc(S.ownerSrc, 0, 1), acc(TOKEN, 0, 0)],
    data: Buffer.from([2]),
  }).catch(() => {});
});

// ── EVM lane (dual-lane parity) ──────────────────────────────────────────────
// Execute is permissionless (a native keeper tx, lane-agnostic — already proven
// above), so orders' EVM-lane parity = an EVM user can PLACE (owner is their
// external_auth PDA, submitted via the CPI precompile) and then have the order
// filled, delivering output to their EVM-side ATA. Skips without the deployer key.
const E = {};
test("EVM lane: Place an order via the CPI precompile", { skip: !KEY }, async () => {
  E.owner = evmPdaFor(EVM_DEPLOYER); // the EVM user's Rome external_auth PDA
  E.nonce = BigInt(Math.floor(Date.now()) + 100);
  const [pda, bump] = orderPda(E.owner, E.nonce);
  E.pda = pda;
  E.inEscrow = getAssociatedTokenAddressSync(SRC_MINT, pda, true);
  E.ownerSrc = getAssociatedTokenAddressSync(SRC_MINT, E.owner, true); // PDA's USDC (funded)
  E.ownerDst = getAssociatedTokenAddressSync(DST_MINT, E.owner, true); // PDA's SOL
  assert.ok((await bal(E.ownerSrc)) >= AMOUNT_IN, "EVM user's PDA holds input USDC");

  // TRUE wallet-only: create the sole (INPUT) order-PDA-owned escrow + the user's
  // output ATA entirely from the EVM lane via HELPER (no Solana keypair).
  // create_ata_for_key targets an arbitrary raw pubkey owner (the order PDA);
  // create_ata targets the caller's own external_auth PDA. Both idempotent. The
  // dst ATA is created here so the later fill can deliver into it (fee-from-input
  // model — no output escrow).
  await evmHelper("create_ata_for_key", [b32(pda), b32(SRC_MINT)], KEY);
  await evmHelper("create_ata", [EVM_DEPLOYER, b32(DST_MINT)], KEY);
  assert.ok(await conn.getAccountInfo(PK(E.inEscrow)), "input escrow created via create_ata_for_key (EVM lane)");
  assert.ok(await conn.getAccountInfo(PK(E.ownerDst)), "owner dst ATA created via create_ata (EVM lane)");

  // owner AND payer are the same external_auth PDA (Rome auto-signs it; it holds
  // SOL from the user's gas balance to fund the order-account rent).
  const r = await execEvmCpi({
    programId: ORDERS_PROGRAM,
    key: KEY,
    accounts: [
      acc(pda, 0, 1), acc(E.owner, 1, 0), acc(E.inEscrow, 0, 1),
      acc(E.ownerSrc, 0, 1), acc(E.ownerDst, 0, 0), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0),
      acc(P.swapState, 0, 0), acc(E.owner, 1, 1), acc(TOKEN, 0, 0), acc(SYSTEM, 0, 0),
    ],
    data: placeData({
      nonce: E.nonce, bump, aToB: true, amountInTotal: AMOUNT_IN, trancheIn: AMOUNT_IN,
      minOut: 1n, interval: 0n, expiry: Math.floor(Date.now() / 1000) + 3600, keeperFeeBps: KEEPER_FEE_BPS,
    }),
  });
  assert.ok(r.ok, `evm place ok: ${r.error || ""}`);
  assert.equal(await bal(E.inEscrow), AMOUNT_IN, "escrow funded from the EVM user's PDA");
  console.log(`  EVM-lane Place: ${r.legs} legs, maxCu ${r.maxCu}`);
});

test("EVM-placed order fills via permissionless Execute → EVM user paid", { skip: !KEY }, async () => {
  const dstBefore = await bal(E.ownerDst);
  const keeperFee = await ensureAta(SRC_MINT, keeper.publicKey); // keeper paid in the INPUT token (USDC)
  const r = await execSolana({ // permissionless, run by the local keeper key
    programId: ORDERS_PROGRAM,
    accounts: [
      acc(E.pda, 0, 1), acc(E.inEscrow, 0, 1), acc(E.ownerDst, 0, 1), acc(keeperFee, 0, 1),
      acc(DEX, 0, 0), acc(P.swapState, 0, 1), acc(P.authority, 0, 0), acc(P.vaultA, 0, 1), acc(P.vaultB, 0, 1),
      acc(P.poolMint, 0, 1), acc(P.feeAccount, 0, 1), acc(SRC_MINT, 0, 0), acc(DST_MINT, 0, 0), acc(TOKEN, 0, 0),
    ],
    data: executeData(),
  });
  assert.ok(r.ok, "execute ok");
  assert.ok((await bal(E.ownerDst)) > dstBefore, "EVM user's ATA received the output");
  assert.equal(await bal(E.inEscrow), 0n, "EVM-placed order filled");
});
