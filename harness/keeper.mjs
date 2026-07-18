// keeper.mjs — permissionless rome-dex order keeper (roadmap #3, PR ③).
//
// Polls every order account, and for each OPEN order either fills the next
// fillable tranche (limit reached / DCA interval elapsed) or refunds an expired
// one — earning `keeper_fee_bps` of the output. Runs on its own funded key; no
// app backend, no Rome capital, anyone can run one. Fillability is decided
// off-chain with the exact curve mirror (sdk/quote.mjs) so we don't burn a tx on
// an unfillable order; the on-chain swap's own slippage guard is the backstop.
//
//   node keeper.mjs            # one pass
//   node keeper.mjs --watch    # poll forever (KEEPER_INTERVAL_MS, default 15s)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { conn, payer, PK, bal, ensureAta, execSolana } from "./lib.mjs";
import { quoteExactIn } from "../sdk/quote.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ORDERS_PROGRAM = new PublicKey("ordWTztCBW7fpoq6eLHQBp2aeoB17CAbmAx6FjtfQ7C");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ORDER_LEN = 230;

// Merge every known pool file (they carry different pool sets — real-pairs,
// real-tiers, and the app/tiers set), deduped by swapState, so the keeper can
// resolve whatever pool an order references. Later files don't clobber earlier.
const poolBySwapState = new Map();
for (const f of ["pools-real-pairs.json", "pools-real-tiers.json", "pools-tiers.json"]) {
  const fp = path.join(DIR, f);
  if (!fs.existsSync(fp)) continue;
  for (const p of JSON.parse(fs.readFileSync(fp, "utf8"))) {
    if (p.swapState && p.feeTradeNum != null && !poolBySwapState.has(p.swapState)) {
      poolBySwapState.set(p.swapState, p);
    }
  }
}

const executeData = () => Buffer.from([1]);
const crankData = () => Buffer.from([3]);
const acc = (k, s, w) => ({ pubkey: PK(k), isSigner: !!s, isWritable: !!w });

// ---- Order account parse (mirror orders/src/state.rs pack layout) ----
export function parseOrder(buf) {
  const pk = (o) => new PublicKey(buf.subarray(o, o + 32)).toBase58();
  return {
    isInitialized: buf[0] === 1,
    bump: buf[1],
    status: buf[2], // 0 Open, 1 Filled, 2 Cancelled, 3 Expired
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

// Mirror orders/src/state.rs (fee-from-input model): the keeper fee is skimmed
// from the input tranche, and the REMAINDER is swapped, with effective_min_out
// as the DEX floor. So the on-chain fill condition is
// quoteExactIn(tranche − fee) ≥ effective_min_out — no gross-up.
const ceilDiv = (a, b) => (a + b - 1n) / b;
function effectiveMinOut(o, tranche) {
  if (tranche >= o.trancheIn) return o.minOutPerTranche;
  return ceilDiv(o.minOutPerTranche * tranche, o.trancheIn);
}
function swapInOf(tranche, bps) {
  const fee = (tranche * BigInt(bps)) / 10_000n; // floor, input-side
  return tranche - fee;
}

function feesOf(p) {
  return { tradeNum: BigInt(p.feeTradeNum), tradeDen: BigInt(p.feeTradeDen), ownerNum: BigInt(p.feeOwnerNum), ownerDen: BigInt(p.feeOwnerDen) };
}

/**
 * Discover live order account pubkeys. `getProgramAccounts` is unreliable /
 * throttled on the Rome RPC, so the default path walks the program's recent
 * signatures (same mechanism as the analytics indexer) and collects the order
 * PDAs touched. Callers that already track order pubkeys (the app, or a test)
 * pass them via `runOnce({ orders })` and skip discovery entirely.
 */
export async function discoverOrders({ limit = 200 } = {}) {
  const sigs = await conn.getSignaturesForAddress(ORDERS_PROGRAM, { limit });
  const seen = new Set();
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    const keys = tx?.transaction?.message?.staticAccountKeys ?? tx?.transaction?.message?.accountKeys ?? [];
    for (const k of keys) seen.add(k.toBase58?.() ?? String(k));
  }
  const cand = [...seen].map((s) => new PublicKey(s));
  if (cand.length === 0) return [];
  const infos = await conn.getMultipleAccountsInfo(cand);
  // Keep only accounts actually owned by the orders program and order-sized.
  return cand.filter((_, i) => infos[i]?.owner?.equals(ORDERS_PROGRAM) && infos[i]?.data?.length === ORDER_LEN);
}

/** One keeper pass. Returns {filled, cranked, skipped, scanned}. */
export async function runOnce({ log = console.log, orders } = {}) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  // Resolve the order set: explicit list, else discover via signatures.
  const pubkeys = orders?.length
    ? orders.map((o) => PK(o))
    : await discoverOrders();
  const infos = await conn.getMultipleAccountsInfo(pubkeys);
  const accts = pubkeys
    .map((pubkey, i) => ({ pubkey, account: infos[i] }))
    .filter((a) => a.account && a.account.owner.equals(ORDERS_PROGRAM) && a.account.data.length === ORDER_LEN);
  let filled = 0, cranked = 0, skipped = 0;

  for (const { pubkey, account } of accts) {
    const o = parseOrder(account.data);
    if (o.status !== 0) continue; // only Open
    const p = poolBySwapState.get(o.pool);
    if (!p) { skipped++; log(`skip ${pubkey.toBase58().slice(0, 8)}: unknown pool`); continue; }

    // Expired → refund + fully close permissionlessly (funds+rent → owner only).
    if (now >= o.expiryTs) {
      const srcMint = o.aToB ? p.mintA : p.mintB;
      const ownerSrc = await ensureAta(srcMint, o.owner, true);
      await execSolana({
        programId: ORDERS_PROGRAM,
        accounts: [acc(pubkey, 0, 1), acc(o.owner, 0, 1), acc(o.inputEscrow, 0, 1), acc(ownerSrc, 0, 1), acc(TOKEN, 0, 0)],
        data: crankData(),
      }).then(() => { cranked++; log(`cranked expired ${pubkey.toBase58().slice(0, 8)}`); })
        .catch((e) => { skipped++; log(`crank fail ${pubkey.toBase58().slice(0, 8)}: ${String(e.message).slice(0, 80)}`); });
      continue;
    }

    // DCA interval gate.
    if (now < o.lastExecTs + BigInt(o.intervalSecs)) { skipped++; continue; }

    // Fillability: off-chain quote of the next tranche vs the grossed-up min.
    const tranche = o.remainingIn < o.trancheIn ? o.remainingIn : o.trancheIn;
    const [reserveIn, reserveOut] = o.aToB
      ? [await bal(p.vaultA), await bal(p.vaultB)]
      : [await bal(p.vaultB), await bal(p.vaultA)];
    // Fee-from-input: only (tranche − fee) is swapped; it must clear the floor.
    const swapIn = swapInOf(tranche, o.keeperFeeBps);
    const { amountOut } = quoteExactIn({ amountIn: swapIn, reserveIn, reserveOut, fees: feesOf(p) });
    if (amountOut < effectiveMinOut(o, tranche)) { skipped++; continue; } // not fillable yet

    const dstMint = o.aToB ? p.mintB : p.mintA;
    const srcMint = o.aToB ? p.mintA : p.mintB;
    // Fee-from-input model: the keeper is paid in the INPUT token, so its fee ATA
    // is the src mint (not dst). Idempotent create in case this keeper is fresh.
    const keeperFee = await ensureAta(srcMint, payer.publicKey);
    // The swap now writes output straight into the owner's dst ATA (no output
    // escrow). Place no longer requires it to exist, so provision it here before
    // Execute — allowOwnerOffCurve because EVM-lane owners are external_auth PDAs.
    await ensureAta(dstMint, o.owner, true);
    const [srcVault, dstVault] = o.aToB ? [p.vaultA, p.vaultB] : [p.vaultB, p.vaultA];
    await execSolana({
      programId: ORDERS_PROGRAM,
      accounts: [
        acc(pubkey, 0, 1), acc(o.inputEscrow, 0, 1), acc(o.dstAta, 0, 1), acc(keeperFee, 0, 1),
        acc(p.program, 0, 0), acc(p.swapState, 0, 1), acc(p.authority, 0, 0), acc(srcVault, 0, 1), acc(dstVault, 0, 1),
        acc(p.poolMint, 0, 1), acc(p.feeAccount, 0, 1), acc(srcMint, 0, 0), acc(dstMint, 0, 0), acc(TOKEN, 0, 0),
      ],
      data: executeData(),
    }).then((r) => { filled++; log(`filled ${pubkey.toBase58().slice(0, 8)} tranche ${tranche} (cu ${r.cu})`); })
      .catch((e) => { skipped++; log(`fill fail ${pubkey.toBase58().slice(0, 8)}: ${String(e.message).slice(0, 80)}`); });
  }
  return { filled, cranked, skipped, scanned: accts.length };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const watch = process.argv.includes("--watch");
  const interval = Number(process.env.KEEPER_INTERVAL_MS || 15_000);
  do {
    const r = await runOnce();
    console.log(`pass: scanned ${r.scanned} · filled ${r.filled} · cranked ${r.cranked} · skipped ${r.skipped}`);
    if (watch) await new Promise((res) => setTimeout(res, interval));
  } while (watch);
}
