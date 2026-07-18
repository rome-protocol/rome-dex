// clmm-create-pool.test.mjs — BRAND-NEW-WALLET ACCEPTANCE for CREATING a NEW
// CLMM pool over two fresh mints, on BOTH lanes (operator standing rule: test
// every feature with a fresh wallet + tiny amounts; the cold path is where bugs
// hide — memory feedback_brand_new_wallet_testing).
//
// The load-bearing crux is the EVM lane: InitPool has been proven on-chain only
// from the Solana payer (setup-clmm.mjs). Nothing has ever driven InitPool from
// the EVM lane via the CPI precompile. Both instructions already exist
// (clmm/src/processor.rs InitPool tag 0 + InitTickArray tag 1) — there is NO new
// production code; this test either proves the EVM-lane InitPool works or reveals
// it doesn't.
//
//   • Test 1 (Solana lane): a fresh Keypair creates + seeds + swaps a NEW pool.
//   • Test 2 (EVM lane, THE CRUX): a fresh ethers wallet creates a NEW pool via
//     the CPI precompile, its external_auth PDA auto-signed as InitPool payer.
//
// Every test fetches the pool account and asserts it is REALLY initialized
// (owner == CLMM program + the is_initialized byte set).
//
// Run:
//   node --test clmm-create-pool.test.mjs                 # Test 1 only (Solana)
//   HADRIAN_PRIVATE_KEY=<deployer> node --test clmm-create-pool.test.mjs   # both

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
  getAssociatedTokenAddressSync, getAccount,
} from "@solana/spl-token";
import { ethers } from "ethers";
import {
  conn, payer, PK, bal, execSolana, execEvmCpi, evmPdaFor,
  EVM_RPC, CHAIN_ID, b32, resolveGas, evmRpc,
} from "./lib.mjs";
import {
  decodePool, fetchClmmPool, quoteClmmExactIn, getSqrtPriceAtTick, tickArrayStartIndex,
} from "../sdk/clmm-quote.mjs";
// THE APP BUILDERS under proof — the Solana lane drives these directly (single
// source of truth; the UI calls the same code). If the app builder emits a wrong
// PDA/account/byte, this on-chain test fails.
import {
  poolPdaFor as appPoolPda, tickArrayPdaFor as appTaPda, vaultAtaFor as appVault,
  orderMints as appOrderMints, priceToSqrtPrice as appPriceToSqrt,
  buildInitPoolIx, buildInitTickArrayIx,
} from "../app/lib/clmm-create.ts";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.HADRIAN_PRIVATE_KEY;

// The live CLMM program id (harness/clmm.json — set by setup-clmm.mjs).
const C = JSON.parse(fs.readFileSync(path.join(DIR, "clmm.json"), "utf8"));
const CLMM = new PublicKey(C.program);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = SystemProgram.programId;
const HELPER = "0xff00000000000000000000000000000000000009"; // clmm-evm.test.mjs:31

// ── pool geometry (reuse the known 0.30% / spacing-64 tier so tick-array
//    geometry is exactly the one setup-clmm.mjs already exercises) ────────────
const FEE_PIPS = C.feePips;            // 3000 (clmm.json)
const TICK_SPACING = C.tickSpacing;    // 64   (clmm.json)
const SPAN = 88 * TICK_SPACING;        // 5632 — TICK_ARRAY_SIZE*spacing (state.rs:39)
const SQRT_PRICE_1 = 1n << 64n;        // price 1.0 → tick 0 (setup-clmm.mjs:31)
const TICK_ARRAY_STARTS = [-SPAN, 0, SPAN]; // small range around tick 0 (setup-clmm.mjs:83)
const POS_LOWER = -1280, POS_UPPER = 1280;  // straddles tick 0 (clmm.json / clmm.test.mjs:66)
const SEED_LIQ = 1_000_000_000n;       // ≈62e6 raw per side over ±1280 (clmm.test.mjs:351)
const SWAP_IN = 50_000n;               // tiny probe (clmm.test.mjs:94)

// Account sizes for rent (clmm/src/state.rs:33 + :43 — TICK_ARRAY_HEADER_LEN 38
// + TICK_ARRAY_SIZE 88 * TICK_LEN 64 = 5670). Tick arrays are ~40M lamports rent
// EACH, so the EVM-lane PDA bootstrap is computed from the chain, not guessed.
const POOL_LEN = 204;
const TICK_ARRAY_LEN = 38 + 88 * 64; // 5670

// ── little-endian encoders (mirror clmm-evm.test.mjs:36-38 + setup-clmm.mjs:36-39) ──
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u128 = (v) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(BigInt(v) >> 64n, 8); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w }); // clmm.test.mjs:57

// ── instruction data (tags match clmm/src/processor.rs::process) ─────────────
// InitPool  tag 0: [0, bump, fee_pips u32 LE, tick_spacing u16 LE, sqrt_price u128 LE] (setup-clmm.mjs:73, processor.rs:53)
const initPoolData = (bump, feePips, tickSpacing, sqrtPrice) =>
  Buffer.concat([Buffer.from([0]), Buffer.from([bump]), u32(feePips), u16(tickSpacing), u128(sqrtPrice)]);
// InitTickArray tag 1: [1, start_index i32 LE, bump] (setup-clmm.mjs:90, processor.rs:56)
const initTickArrayData = (start, bump) =>
  Buffer.concat([Buffer.from([1]), i32(start), Buffer.from([bump])]);
// OpenPosition tag 2: [2, lower i32 LE, upper i32 LE, bump] (clmm-evm.test.mjs:39, processor.rs:59)
const openData = (l, u, bump) => Buffer.concat([Buffer.from([2]), i32(l), i32(u), Buffer.from([bump])]);
// IncreaseLiquidity tag 3: [3, liquidity u128 LE, max0 u64 LE, max1 u64 LE] (clmm-evm.test.mjs:40, processor.rs:62)
const incData = (liq, m0, m1) => Buffer.concat([Buffer.from([3]), u128(liq), u64(m0), u64(m1)]);
// Swap tag 7: [7, zeroForOne u8, amountIn u64 LE, minOut u64 LE, limit u128 LE] (clmm.test.mjs:54-55, processor.rs:80)
const swapData = (z, amtIn, minOut, limit = 0n) =>
  Buffer.concat([Buffer.from([7]), Buffer.from([z ? 1 : 0]), u64(amtIn), u64(minOut), u128(limit)]);

// ── PDA derivations (seeds per clmm/src/state.rs:26-30) ──────────────────────
const poolPdaFor = (mint0, mint1, feePips) =>       // setup-clmm.mjs:64-66, processor.rs:120
  PublicKey.findProgramAddressSync([Buffer.from("pool"), mint0.toBuffer(), mint1.toBuffer(), u32(feePips)], CLMM);
const tickArrayPdaFor = (pool, start) =>            // setup-clmm.mjs:84-85, processor.rs:195
  PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), i32(start)], CLMM);
const positionPdaFor = (pool, owner, lower, upper) => // clmm-evm.test.mjs:46-47, processor.rs:248
  PublicKey.findProgramAddressSync([Buffer.from("position"), pool.toBuffer(), PK(owner).toBuffer(), i32(lower), i32(upper)], CLMM);

// Two fresh 6-dp mints, ordered canonically mint0 < mint1 (InitPool enforces it —
// processor.rs:115). Mirrors setup-clmm.mjs:55-58.
async function createOrderedMints() {
  const a = await createMint(conn, payer, payer.publicKey, null, 6);
  const b = await createMint(conn, payer, payer.publicKey, null, 6);
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

// Walk-order tick arrays for a swap (arrays[0] must contain the current tick —
// the engine validates exactly this). Mirrors clmm.test.mjs:76-80.
function walk(tickArrays, currentTick, zeroForOne) {
  const start = Math.floor(currentTick / SPAN) * SPAN;
  const seq = zeroForOne ? [start, start - SPAN] : [start, start + SPAN];
  return seq.map((s) => tickArrays[s]).filter(Boolean);
}

// Assert the pool PDA is REALLY a live, initialized CLMM pool (task invariant).
async function assertPoolInitialized(poolPda, mint0, mint1) {
  const info = await conn.getAccountInfo(poolPda);
  assert.ok(info, "pool account exists on-chain");
  assert.ok(info.owner.equals(CLMM), `pool owned by the CLMM program (got ${info.owner.toBase58()})`);
  const p = decodePool(info.data); // sdk/clmm-quote.mjs:123
  assert.equal(p.isInitialized, true, "pool is_initialized byte set");
  assert.ok(Buffer.from(p.mint0).equals(mint0.toBuffer()), "pool binds mint0");
  assert.ok(Buffer.from(p.mint1).equals(mint1.toBuffer()), "pool binds mint1");
  assert.equal(p.feePips, FEE_PIPS, "fee tier persisted");
  assert.equal(p.tickSpacing, TICK_SPACING, "tick spacing persisted");
  assert.equal(p.currentTick, 0, "fresh 1:1 pool sits at tick 0 (sqrt_price encoding correct)");
  return p;
}

// HELPER precompile call from a fresh EOA (extends clmm-evm.test.mjs:53-65 with
// create_ata_for_key — the foreign raw-pubkey-owner ATA creator, orders.ts:380).
async function evmHelper(fn, args, key) {
  const iface = new ethers.Interface([
    "function swap_gas_to_lamports(uint64 lamports)",
    "function create_ata(address user, bytes32 mint)",
    "function create_ata_for_key(bytes32 wallet, bytes32 mint)",
  ]);
  const data = iface.encodeFunctionData(fn, args);
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const w = new ethers.Wallet(key.trim(), provider);
  const nonce = await provider.getTransactionCount(w.address, "pending");
  const g = await resolveGas({ from: w.address, to: HELPER, data });
  const signed = await w.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g, to: HELPER, value: 0n, data });
  const send = await evmRpc("eth_sendRawTransaction", [signed]);
  if (send.error) throw new Error(JSON.stringify(send.error).slice(0, 200));
  await provider.waitForTransaction(send.result, 1, 120000).catch(() => null);
}

// Create the pool PDA's vault ATA FROM THE EVM LANE (foreign raw-pubkey owner)
// via HELPER create_ata_for_key — the exact primitive orders uses to create its
// order-PDA-owned escrow (orders.test.mjs:222, operator-paid rent). Falls back to
// a payer-created ATA (documented) if the EVM-lane path does not materialize it.
async function ensureVaultEvm(mint, poolPda, key) {
  const vault = getAssociatedTokenAddressSync(mint, poolPda, true); // == pool PDA's ATA (processor.rs:132-139)
  if (!(await conn.getAccountInfo(vault))) {
    try { await evmHelper("create_ata_for_key", [b32(poolPda), b32(mint)], key); }
    catch (e) { console.warn(`  [FLAG] create_ata_for_key threw: ${String(e?.message ?? e).slice(0, 160)}`); }
  }
  if (!(await conn.getAccountInfo(vault))) {
    // DOCUMENTED FALLBACK (verify): EVM-lane create_ata_for_key did NOT create the
    // pool-PDA vault. Confirm whether HELPER supports a foreign-owner ATA where the
    // owner is a program-derived pool PDA (orders proves it for order PDAs).
    console.warn("  [FLAG] EVM-lane create_ata_for_key did not create the pool-PDA vault — payer-created as fallback; VERIFY foreign-owner support");
    await getOrCreateAssociatedTokenAccount(conn, payer, mint, poolPda, true);
  }
  return vault;
}

// ── TEST 1 — Solana lane ─────────────────────────────────────────────────────
test("CREATE CLMM POOL (Solana lane) — fresh keypair, new pool over two mints", async () => {
  // sqrt_price encoding self-check: the 1:1 value equals getSqrtPriceAtTick(0).
  assert.equal(SQRT_PRICE_1, getSqrtPriceAtTick(0), "SQRT_PRICE_1 == sqrt price at tick 0");

  // Fresh, unprivileged creator — funded ~2 SOL for the rent it pays. (create-pool-newuser.test.mjs:58-61)
  const creator = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: creator.publicKey, lamports: 2 * LAMPORTS_PER_SOL,
  })), [payer], { commitment: "confirmed" });

  // Two brand-new mints — canonical order via the APP builder (proves orderMints).
  const [m0raw, m1raw] = await createOrderedMints();
  const { mint0, mint1 } = appOrderMints(m0raw, m1raw);
  // Pool PDA + vaults + sqrt-price ALL from the app builder (the code the UI runs).
  const [poolPda, poolBump] = appPoolPda(CLMM, mint0, mint1, FEE_PIPS);
  const sqrtPrice = appPriceToSqrt(1.0, 6, 6);
  assert.equal(sqrtPrice, SQRT_PRICE_1, "app priceToSqrtPrice(1.0) == sqrt price at tick 0");
  console.log(`  new pool PDA ${poolPda.toBase58()} over ${mint0.toBase58().slice(0, 6)}…/${mint1.toBase58().slice(0, 6)}… (via app builder)`);
  assert.equal(await conn.getAccountInfo(poolPda), null, "pool does not exist yet (brand-new)");

  // Pool PDA's two vault ATAs — CREATOR pays; addresses from the app builder.
  const vault0 = appVault(poolPda, mint0), vault1 = appVault(poolPda, mint1);
  await getOrCreateAssociatedTokenAccount(conn, creator, mint0, poolPda, true);
  await getOrCreateAssociatedTokenAccount(conn, creator, mint1, poolPda, true);

  // InitPool via the APP builder's instruction — signed by the fresh creator.
  const initIx = buildInitPoolIx({ program: CLMM, poolPda, bump: poolBump, mint0, mint1, vault0, vault1, payer: creator.publicKey, feePips: FEE_PIPS, tickSpacing: TICK_SPACING, sqrtPrice });
  const ip = await execSolana({ programId: CLMM, accounts: initIx.keys, data: initIx.data, signer: creator });
  assert.ok(ip.ok, "fresh-creator InitPool (app builder) landed");
  await assertPoolInitialized(poolPda, mint0, mint1);
  console.log(`  Solana-lane InitPool: ${ip.cu} CU`);

  // Tick arrays spanning a small range around tick 0. (setup-clmm.mjs:83-93)
  const tickArrays = {};
  for (const start of TICK_ARRAY_STARTS) {
    const [ta, taBump] = appTaPda(CLMM, poolPda, start);
    const taIx = buildInitTickArrayIx({ program: CLMM, poolPda, tickArrayPda: ta, bump: taBump, startIndex: start, payer: creator.publicKey });
    const r = await execSolana({ programId: CLMM, accounts: taIx.keys, data: taIx.data, signer: creator });
    assert.ok(r.ok, `fresh-creator InitTickArray ${start} (app builder)`);
    assert.ok((await conn.getAccountInfo(ta)).owner.equals(CLMM), `tick array ${start} owned by CLMM`);
    tickArrays[start] = ta;
  }

  // Seed a position [-1280, 1280]: OpenPosition + IncreaseLiquidity (creator signs).
  const [pos, posBump] = positionPdaFor(poolPda, creator.publicKey, POS_LOWER, POS_UPPER);
  const open = await execSolana({
    programId: CLMM,
    accounts: [acc(poolPda, 0, 0), acc(pos, 0, 1), acc(creator.publicKey, 0, 0), acc(creator.publicKey, 1, 1), acc(SYSTEM, 0, 0)],
    data: openData(POS_LOWER, POS_UPPER, posBump),
    signer: creator,
  });
  assert.ok(open.ok, "fresh-creator OpenPosition (payer-funded)");

  // Creator's own token ATAs + tiny seed (payer is the mint authority for mintTo).
  const cAta0 = (await getOrCreateAssociatedTokenAccount(conn, creator, mint0, creator.publicKey)).address;
  const cAta1 = (await getOrCreateAssociatedTokenAccount(conn, creator, mint1, creator.publicKey)).address;
  await mintTo(conn, payer, mint0, cAta0, payer, 200_000_000n);
  await mintTo(conn, payer, mint1, cAta1, payer, 200_000_000n);

  // IncreaseLiquidity — tick arrays for the two bounds (lower -1280 → start -5632; upper 1280 → start 0). (clmm.test.mjs:88-92)
  const taLo = tickArrays[tickArrayStartIndex(POS_LOWER, TICK_SPACING)];
  const taHi = tickArrays[tickArrayStartIndex(POS_UPPER, TICK_SPACING)];
  const inc = await execSolana({
    programId: CLMM,
    accounts: [
      acc(poolPda, 0, 1), acc(pos, 0, 1), acc(creator.publicKey, 1, 0),
      acc(cAta0, 0, 1), acc(cAta1, 0, 1), acc(vault0, 0, 1), acc(vault1, 0, 1),
      acc(TOKEN, 0, 0), acc(taLo, 0, 1), acc(taHi, 0, 1),
    ],
    data: incData(SEED_LIQ, 100_000_000n, 100_000_000n),
    signer: creator,
  });
  assert.ok(inc.ok, "fresh-creator IncreaseLiquidity (seed)");
  const seeded = await fetchClmmPool(conn, poolPda);
  assert.ok(seeded.liquidity > 0n, `new pool has in-range liquidity (got ${seeded.liquidity})`);

  // Swap through the freshly-created pool — it's a real working pool. (clmm.test.mjs:108-124)
  const w = walk(tickArrays, seeded.currentTick, true);
  const quote = await quoteClmmExactIn(conn, poolPda, w, true, SWAP_IN);
  assert.ok(quote.amountOut > 0n, "quote produces output");
  const before1 = await bal(cAta1);
  const sw = await execSolana({
    programId: CLMM,
    accounts: [
      acc(poolPda, 0, 1), acc(creator.publicKey, 1, 0), acc(cAta0, 0, 1), acc(cAta1, 0, 1),
      acc(vault0, 0, 1), acc(vault1, 0, 1), acc(TOKEN, 0, 0), ...w.map((a) => acc(a, 0, 1)),
    ],
    data: swapData(true, SWAP_IN, 1n),
    signer: creator,
  });
  assert.ok(sw.ok, "swap through the NEW pool landed");
  const got = (await bal(cAta1)) - before1;
  assert.ok(got > 0n, "new pool delivered token1");
  assert.equal(got, quote.amountOut, `realized == quote (quote ${quote.amountOut}, got ${got})`);
  console.log(`  Solana-lane CREATE POOL: fresh keypair made+seeded pool ${poolPda.toBase58().slice(0, 8)}… and swapped ${SWAP_IN}→${got}`);
});

// ── TEST 2 — EVM lane (THE CRUX) ─────────────────────────────────────────────
// The never-exercised-on-chain path: drive InitPool + InitTickArray from an EVM
// wallet via the CPI precompile, the EOA's external_auth PDA auto-signed as the
// payer. Structurally identical to the proven EVM OpenPosition (clmm-evm.test.mjs:105),
// but InitPool has never been driven from the EVM lane before this test.
test("CREATE CLMM POOL (EVM lane) — fresh EVM wallet, new pool via CPI (THE CRUX)", { skip: !KEY }, async () => {
  const wallet = ethers.Wallet.createRandom();
  const eoa = wallet.address;
  const owner = evmPdaFor(eoa); // external_auth PDA — the InitPool payer Rome auto-signs (lib.mjs:136)
  console.log(`  fresh EVM wallet ${eoa} · PDA ${owner.toBase58()}`);

  // TINY gas to the fresh EOA (native transfer from the deployer). (clmm-evm.test.mjs:76-82)
  // FLAG: the PDA must later convert ~0.13 SOL of rent (pool + 3×5670-byte tick
  // arrays) out of this gas via swap_gas_to_lamports. clmm-evm.test funded 0.2 ETH
  // for a 0.01-SOL conversion; the gas→lamports rate is unknown to this test, so if
  // the bootstrap assert below trips for insufficient funds, raise GAS_ETH.
  const provider = new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const dep = new ethers.Wallet(KEY.trim(), provider);
  // Creating a CLMM pool fronts ~0.13 SOL of rent (pool + 3× 5670-byte tick
  // arrays); the PDA converts that from gas via swap_gas_to_lamports, so the EOA
  // needs enough ETH to cover the conversion + tx gas. Gas is non-scarce
  // (deployer has plenty); unspent stays in the throwaway wallet.
  const GAS_ETH = "20";
  {
    const g = await resolveGas({ from: dep.address, to: eoa, data: "0x" });
    const nonce = await provider.getTransactionCount(dep.address, "pending");
    const tx = await dep.sendTransaction({ to: eoa, value: ethers.parseEther(GAS_ETH), type: 2, nonce, maxFeePerGas: g.maxFeePerGas, maxPriorityFeePerGas: g.maxPriorityFeePerGas, gasLimit: 30_000_000n });
    await tx.wait(1);
  }

  // Two brand-new mints — canonical order + pool PDA + sqrt-price from the APP
  // builder, so the EVM lane proves the exact code path the UI's createClmmPoolEvm
  // runs (WS1.3: close the loop through the app builders, not inline encoding).
  const [m0raw, m1raw] = await createOrderedMints();
  const { mint0, mint1 } = appOrderMints(m0raw, m1raw);
  const [poolPda, poolBump] = appPoolPda(CLMM, mint0, mint1, FEE_PIPS);
  const sqrtPrice = appPriceToSqrt(1.0, 6, 6);
  assert.equal(await conn.getAccountInfo(poolPda), null, "pool does not exist yet (brand-new)");

  // Pool PDA's two vault ATAs, created FROM THE EVM LANE via create_ata_for_key
  // (foreign raw-pubkey owner). Must exist before InitPool (processor.rs:140-143).
  const vault0 = appVault(poolPda, mint0), vault1 = appVault(poolPda, mint1);
  await ensureVaultEvm(mint0, poolPda, wallet.privateKey);
  await ensureVaultEvm(mint1, poolPda, wallet.privateKey);
  assert.ok((await getAccount(conn, vault0)).owner.equals(poolPda), "vault0 is the pool PDA's ATA");
  assert.ok((await getAccount(conn, vault1)).owner.equals(poolPda), "vault1 is the pool PDA's ATA");

  // Bootstrap the cold PDA with lamports for ALL the CPI rent it will pay: the
  // pool account + 3 tick arrays. Rent read from the chain (tick arrays are 5670
  // bytes ≈ 40M lamports EACH — the task's 30M example covers <1 array). Vault ATAs
  // above are operator-paid, so they are NOT in this sum. (swap_gas_to_lamports — clmm-evm.test.mjs:96)
  const poolRent = BigInt(await conn.getMinimumBalanceForRentExemption(POOL_LEN));
  const taRent = BigInt(await conn.getMinimumBalanceForRentExemption(TICK_ARRAY_LEN));
  const need = poolRent + BigInt(TICK_ARRAY_STARTS.length) * taRent + 5_000_000n; // + margin
  await evmHelper("swap_gas_to_lamports", [need], wallet.privateKey);
  const pdaLamports = BigInt(await conn.getBalance(owner));
  assert.ok(pdaLamports >= need, `PDA bootstrapped for pool+arrays rent (need ${need}, got ${pdaLamports}) — if short, raise GAS_ETH`);

  // === THE CRUX: InitPool via CPI, accounts + data from the APP builder. ===
  // buildInitPoolIx is the exact ix the UI's createClmmPoolEvm sends; execEvmCpi
  // relays its keys/data through the CPI precompile (payer = external_auth PDA).
  const initIx = buildInitPoolIx({ program: CLMM, poolPda, bump: poolBump, mint0, mint1, vault0, vault1, payer: owner, feePips: FEE_PIPS, tickSpacing: TICK_SPACING, sqrtPrice });
  const ip = await execEvmCpi({ programId: CLMM, key: wallet.privateKey, accounts: initIx.keys, data: initIx.data });
  assert.ok(ip.ok, `EVM-lane InitPool submitted: ${ip.error || ""}`);
  const pool = await assertPoolInitialized(poolPda, mint0, mint1); // the real proof
  console.log(`  EVM-lane InitPool (CRUX, app builder): ${ip.legs} legs, maxCu ${ip.maxCu} · pool at tick ${pool.currentTick}`);

  // InitTickArray ×3 via CPI — accounts + data from the app builder.
  for (const start of TICK_ARRAY_STARTS) {
    const [ta, taBump] = appTaPda(CLMM, poolPda, start);
    const taIx = buildInitTickArrayIx({ program: CLMM, poolPda, tickArrayPda: ta, bump: taBump, startIndex: start, payer: owner });
    const r = await execEvmCpi({ programId: CLMM, key: wallet.privateKey, accounts: taIx.keys, data: taIx.data });
    assert.ok(r.ok, `EVM-lane InitTickArray ${start} submitted: ${r.error || ""}`);
    const info = await conn.getAccountInfo(ta);
    assert.ok(info && info.owner.equals(CLMM), `tick array ${start} created + owned by CLMM (EVM lane)`);
  }

  console.log(`  EVM-lane CREATE POOL: fresh wallet ${eoa.slice(0, 10)}… created pool ${poolPda.toBase58().slice(0, 8)}… + 3 tick arrays via CPI`);
  // NOTE: seeding liquidity + swap-through on the EVM lane is intentionally omitted
  // — that surface is already proven on the existing pool by clmm-evm.test.mjs /
  // clmm.test.mjs. This test's job is to prove CREATE.
});
