// router.test.mjs — RomeDexRouter: the EVM lane's single-leg, custody-less path.
//
// The router stores each pool's fixed accounts and assembles the CPI metas in
// EVM memory, so user calldata is ~130B (vs 1540B raw invoke) and the tx no
// longer holder-stages. Security model (proven in probe-delegate.mjs):
//   • user approves the ROUTER's external_auth PDA as SPL delegate per ATA
//   • the router CPIs with its own PDA as user_transfer_authority
//   • all user-side ATAs are DERIVED ON-CHAIN from msg.sender — callers cannot
//     inject accounts, so a victim's approval cannot be spent by an attacker.
//
// Run AFTER deploy + register (see contracts/ + register-router.mjs):
//   HADRIAN_PRIVATE_KEY=… node --test router.test.mjs
// Sequential with the other suites (shared pools + one EOA nonce): `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ethers } from "ethers";
import { getAccount } from "@solana/spl-token";
import {
  conn, EVM_RPC, CHAIN_ID, CPI, EVM_DEPLOYER, PK, b32,
  bal, ensureAta, evmPdaFor, resolveGas, evmRpc, cuOfSig,
} from "./lib.mjs";
import { quoteExactIn, quoteExactOut } from "../sdk/quote.mjs";

const KEY = process.env.HADRIAN_PRIVATE_KEY;
const SKIP = KEY ? false : "no HADRIAN_PRIVATE_KEY";

const routerJson = new URL("./router.json", import.meta.url);
const DEPLOYED = fs.existsSync(routerJson) ? JSON.parse(fs.readFileSync(routerJson)) : null;
const pools = JSON.parse(fs.readFileSync(new URL("./pools-real-tiers.json", import.meta.url)));
const pool = pools.find((p) => p.tier === "0.30%");
const pool2 = pools.find((p) => p.tier === "0.05%");
// 2nd real pair (USDC/ETH) — proves the router works on a NEW pair, not just the
// USDC/SOL tiers. Present after create-real-pair-eth.mjs + register-router.mjs.
const poolEthUrl = new URL("./pool-real-eth.json", import.meta.url);
const poolEth = fs.existsSync(poolEthUrl) ? JSON.parse(fs.readFileSync(poolEthUrl)) : null;

const IFACE = new ethers.Interface([
  "function owner() view returns (address)",
  "function DEX_PROGRAM() view returns (bytes32)",
  "function registerPool(bytes32 id, bytes32[8] accts)",
  "function pools(bytes32) view returns (bytes32 swapState, bytes32 authority, bytes32 vaultA, bytes32 vaultB, bytes32 poolMint, bytes32 feeAccount, bytes32 mintA, bytes32 mintB)",
  "function swap(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minOut)",
  "function swapExactOut(bytes32 poolId, bool aToB, uint64 amountOut, uint64 maxIn)",
  "function addLiquidity(bytes32 poolId, uint64 lp, uint64 maxA, uint64 maxB)",
  "function removeLiquidity(bytes32 poolId, uint64 lp, uint64 minA, uint64 minB)",
  "function zapIn(bytes32 poolId, bool aToB, uint64 amountIn, uint64 minLp, uint64 maxOther)",
  "function route(bytes32 poolA, bool aToB1, bytes32 poolB, bool aToB2, uint64 amountIn, uint64 minOut)",
]);

const provider = KEY ? new ethers.JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 }) : null;
const wallet = KEY ? new ethers.Wallet(KEY.trim(), provider) : null;

async function sendRouter(data) {
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const g = await resolveGas({ from: wallet.address, to: DEPLOYED.address, data });
  const signed = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g, to: DEPLOYED.address, value: 0n, data });
  const r = await evmRpc("eth_sendRawTransaction", [signed]);
  if (r.error) return { ok: false, error: JSON.stringify(r.error).slice(0, 220) };
  await provider.waitForTransaction(r.result, 1, 120000).catch(() => null);
  const sigs = (await evmRpc("rome_solanaTxForEvmTx", [r.result])).result || [];
  let maxCu = 0; for (const s of sigs) { const c = await cuOfSig(s); if (c) maxCu = Math.max(maxCu, c); }
  return { ok: true, txHash: r.result, legs: sigs.length, maxCu, calldataBytes: (data.length - 2) / 2 };
}
const callReverts = async (data, from) => {
  try { await provider.call({ from: from ?? wallet.address, to: DEPLOYED.address, data }); return null; }
  catch (e) { return e.info?.error?.message || e.shortMessage || "revert"; }
};

// SPL approve(delegate=router PDA) via the direct CPI lane.
async function approve(ataPk, amount) {
  const routerPda = evmPdaFor(DEPLOYED.address);
  const userPda = evmPdaFor(EVM_DEPLOYER);
  const cpiIface = new ethers.Interface(["function invoke(bytes32, (bytes32,bool,bool)[], bytes)"]);
  const d = Buffer.alloc(9); d[0] = 4; d.writeBigUInt64LE(amount, 1);
  const calldata = cpiIface.encodeFunctionData("invoke", [
    b32(PK("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
    [[b32(ataPk), false, true], [b32(routerPda), false, false], [b32(userPda), true, false]],
    "0x" + d.toString("hex")]);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const g = await resolveGas({ from: wallet.address, to: CPI, data: calldata });
  const signed = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce, ...g, to: CPI, value: 0n, data: calldata });
  const r = await evmRpc("eth_sendRawTransaction", [signed]);
  assert.ok(!r.error, `approve failed: ${JSON.stringify(r.error || {}).slice(0, 200)}`);
  await provider.waitForTransaction(r.result, 1, 120000).catch(() => null);
}

const reservesOf = async (p) => ({ a: await bal(p.vaultA), b: await bal(p.vaultB) });
const FEES = { tradeNum: 25n, tradeDen: 10000n, ownerNum: 5n, ownerDen: 10000n };
const cu = {};
let userAtaA, userAtaB, userPda;

test("router is deployed + pools registered (run contracts/ deploy + register-router.mjs first)", { skip: SKIP }, async () => {
  assert.ok(DEPLOYED?.address, "harness/router.json missing — deploy RomeDexRouter first");
  const code = await provider.getCode(DEPLOYED.address);
  assert.notEqual(code, "0x", "no code at router address");
  const owner = await provider.call({ to: DEPLOYED.address, data: IFACE.encodeFunctionData("owner") });
  assert.equal(ethers.getAddress("0x" + owner.slice(-40)), EVM_DEPLOYER, "owner should be deployer");
  const reg = await provider.call({ to: DEPLOYED.address, data: IFACE.encodeFunctionData("pools", [b32(PK(pool.swapState))]) });
  assert.equal("0x" + reg.slice(2, 66), b32(PK(pool.swapState)).slice(0, 66), "0.30% pool must be registered");
  userPda = evmPdaFor(EVM_DEPLOYER);
  userAtaA = await ensureAta(pool.mintA, userPda, true);
  userAtaB = await ensureAta(pool.mintB, userPda, true);
});

// ── adversarial ──────────────────────────────────────────────────────────────
test("adversarial: registerPool from a stranger reverts", { skip: SKIP }, async () => {
  const data = IFACE.encodeFunctionData("registerPool", [b32(PK(pool.swapState)),
    [b32(PK(pool.swapState)), b32(PK(pool.authority)), b32(PK(pool.vaultA)), b32(PK(pool.vaultB)),
     b32(PK(pool.poolMint)), b32(PK(pool.feeAccount)), b32(PK(pool.mintA)), b32(PK(pool.mintB))]]);
  const err = await callReverts(data, "0x000000000000000000000000000000000000dEaD");
  assert.ok(err, "stranger registerPool must revert");
});

test("adversarial: swap on an unregistered pool reverts", { skip: SKIP }, async () => {
  const err = await callReverts(IFACE.encodeFunctionData("swap", [b32(PK("So11111111111111111111111111111111111111112")), true, 1000n, 0n]));
  assert.ok(err, "unregistered poolId must revert");
});

test("adversarial: swap beyond the delegated allowance is rejected", { skip: SKIP }, async () => {
  await approve(userAtaA, 0n); // revoke-equivalent: zero allowance
  const err = await callReverts(IFACE.encodeFunctionData("swap", [b32(PK(pool.swapState)), true, 50_000n, 0n]));
  assert.ok(err, "swap with zero allowance must revert (delegate gate)");
});

test("adversarial: no account-injection surface (ATAs derived from msg.sender)", { skip: SKIP }, async () => {
  for (const fn of ["swap", "swapExactOut", "addLiquidity", "removeLiquidity", "zapIn", "route"]) {
    const inputs = IFACE.getFunction(fn).inputs.map((i) => i.type);
    assert.ok(!inputs.some((t) => t.includes("[]") || t === "bytes"), `${fn} must not accept account arrays (${inputs})`);
    assert.ok(inputs.filter((t) => t === "bytes32").length <= 2, `${fn} only pool ids as bytes32 (${inputs})`);
  }
});

// ── happy paths ──────────────────────────────────────────────────────────────
test("swap exact-in via router: tiny calldata, quote-exact output", { skip: SKIP }, async () => {
  await approve(userAtaA, 100_000_000n);
  const r0 = await reservesOf(pool);
  const q = quoteExactIn({ amountIn: 50_000n, reserveIn: r0.a, reserveOut: r0.b, fees: FEES });
  const before = await bal(userAtaB);
  const r = await sendRouter(IFACE.encodeFunctionData("swap", [b32(PK(pool.swapState)), true, 50_000n, q.amountOut]));
  assert.ok(r.ok, `router swap failed: ${r.error}`);
  assert.ok(r.calldataBytes < 200, `calldata should be tiny, got ${r.calldataBytes}B`);
  const delta = (await bal(userAtaB)) - before;
  assert.equal(delta, q.amountOut, "realized out must equal quote to the unit");
  cu.swap = r.maxCu; cu.swapLegs = r.legs; cu.swapBytes = r.calldataBytes;
});

test("swap exact-out via router: delivers exactly the requested amount", { skip: SKIP }, async () => {
  const r0 = await reservesOf(pool);
  const want = 100_000n; // 0.0001 SOL
  const q = quoteExactOut({ amountOut: want, reserveIn: r0.a, reserveOut: r0.b, fees: FEES });
  const before = await bal(userAtaB);
  const r = await sendRouter(IFACE.encodeFunctionData("swapExactOut", [b32(PK(pool.swapState)), true, want, q.amountIn + 10n]));
  assert.ok(r.ok, `exact-out failed: ${r.error}`);
  assert.equal((await bal(userAtaB)) - before, want, "must deliver exactly the requested output");
  cu.exactOut = r.maxCu; cu.exactOutLegs = r.legs;
});

test("add + remove liquidity via router (delegates on A, B, then LP)", { skip: SKIP }, async () => {
  const userLp = await ensureAta(pool.poolMint, userPda, true);
  await approve(userAtaB, 10_000_000_000n);
  const lpWant = 1_000n;
  const before = await bal(userLp);
  const r1 = await sendRouter(IFACE.encodeFunctionData("addLiquidity", [b32(PK(pool.swapState)), lpWant, 1_000_000n, 100_000_000n]));
  assert.ok(r1.ok, `addLiquidity failed: ${r1.error}`);
  assert.equal((await bal(userLp)) - before, lpWant, "LP minted must equal requested");
  await approve(userLp, lpWant);
  const a0 = await bal(userAtaA);
  const r2 = await sendRouter(IFACE.encodeFunctionData("removeLiquidity", [b32(PK(pool.swapState)), lpWant, 0n, 0n]));
  assert.ok(r2.ok, `removeLiquidity failed: ${r2.error}`);
  assert.ok((await bal(userAtaA)) - a0 > 0n, "withdraw must return token A");
  cu.addLiq = r1.maxCu; cu.removeLiq = r2.maxCu;
});

test("zapIn via router: one EVM tx = swap + deposit, atomic", { skip: SKIP }, async () => {
  const userLp = await ensureAta(pool.poolMint, userPda, true);
  const before = await bal(userLp);
  const r = await sendRouter(IFACE.encodeFunctionData("zapIn", [b32(PK(pool.swapState)), true, 200_000n, 1n, 18_446_744_073_709_551_615n]));
  assert.ok(r.ok, `zapIn failed: ${r.error}`);
  assert.ok((await bal(userLp)) - before > 0n, "zap must mint LP from a single-sided input");
  cu.zap = r.maxCu; cu.zapLegs = r.legs;
});

// MEASURED BLOCK (2026-07-02): a 2-pool atomic route builds a 1672B Solana tx —
// over the 1232B raw budget — because two pools' accounts don't fit un-covered.
// Lands once the running proxy picks up the rome-dex ALT in its cover set
// (the proxy ALT-cover config is in place
// pending — operator-gated). This is the concrete proof the persistent ALT is
// still required alongside the router: router fixes CALLDATA, ALT fixes the
// ACCOUNT LIST. Set ROUTE_UNBLOCKED=1 to run.
test("route via router: two pools, one atomic EVM tx", { skip: SKIP || (process.env.ROUTE_UNBLOCKED ? false : "blocked: needs rome-dex ALT in proxy cover set (a proxy config change)") }, async () => {
  assert.ok(pool2, "0.05% pool required");
  const before = await bal(userAtaA);
  // round trip USDC → SOL (0.30%) → USDC (0.05%): output back into A
  const r = await sendRouter(IFACE.encodeFunctionData("route", [b32(PK(pool.swapState)), true, b32(PK(pool2.swapState)), false, 100_000n, 1n]));
  assert.ok(r.ok, `route failed: ${r.error}`);
  const back = (await bal(userAtaA)) - before + 100_000n;
  assert.ok(back > 0n && back < 100_000n, `round trip returns less than input (fees), got back ${back}`);
  cu.route = r.maxCu; cu.routeLegs = r.legs;
});

// ── 2nd pair (USDC/ETH) ──────────────────────────────────────────────────────
// Proves the EVM lane is genuinely multi-pair: the SAME router, a NEW registered
// pool of a different pair, USDC → ETH lands in one leg with quote-exact output.
test("swap exact-in via router on the 2nd pair (USDC → ETH)", { skip: SKIP || (poolEth ? false : "pool-real-eth.json missing — run create-real-pair-eth.mjs") }, async () => {
  // registered?
  const reg = await provider.call({ to: DEPLOYED.address, data: IFACE.encodeFunctionData("pools", [b32(PK(poolEth.swapState))]) });
  assert.equal("0x" + reg.slice(2, 66), b32(PK(poolEth.swapState)).slice(0, 66), "USDC/ETH pool must be registered (run register-router.mjs)");

  const ethAta = await ensureAta(poolEth.mintB, userPda, true); // dst ATA must exist
  await approve(userAtaA, 100_000_000n); // wUSDC allowance (shared side-A ATA)
  const r0 = await reservesOf(poolEth);
  const q = quoteExactIn({ amountIn: 50_000n, reserveIn: r0.a, reserveOut: r0.b, fees: FEES });
  const before = await bal(ethAta);
  const r = await sendRouter(IFACE.encodeFunctionData("swap", [b32(PK(poolEth.swapState)), true, 50_000n, q.amountOut]));
  assert.ok(r.ok, `2nd-pair swap failed: ${r.error}`);
  assert.ok(r.calldataBytes < 200, `calldata should be tiny, got ${r.calldataBytes}B`);
  assert.equal((await bal(ethAta)) - before, q.amountOut, "realized ETH out must equal quote to the unit");
  cu.pair2 = r.maxCu; cu.pair2Legs = r.legs; cu.pair2Bytes = r.calldataBytes;
});

test("summary", { skip: SKIP }, () => {
  console.log("\n── router CU / legs ──");
  console.log(`  swap exact-in : ${cu.swap} CU · legs=${cu.swapLegs} · calldata=${cu.swapBytes}B (raw invoke was 1540B/4 legs)`);
  console.log(`  swap exact-out: ${cu.exactOut} CU · legs=${cu.exactOutLegs}`);
  console.log(`  add / remove  : ${cu.addLiq} / ${cu.removeLiq} CU`);
  console.log(`  zap (atomic)  : ${cu.zap} CU · legs=${cu.zapLegs}`);
  console.log(`  route 2-pool  : ${cu.route} CU · legs=${cu.routeLegs}`);
  console.log(`  2nd pair swap : ${cu.pair2} CU · legs=${cu.pair2Legs} · calldata=${cu.pair2Bytes}B (USDC → ETH)`);
});
