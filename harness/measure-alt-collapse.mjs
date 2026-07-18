// measure-alt-collapse.mjs — P3a acceptance: what does the EVM-lane swap cost in
// Solana legs, and is the proxy's persistent-ALT cover engaged?
//
// MEASURED FINDING (2026-07-02, tx 0x3a9ae471…): the swap's leg count is
// CALLDATA-BOUND, not account-list-bound. invoke()'s ABI encodes each account
// meta as a (bytes32,bool,bool) tuple ≈ 96B → 14 metas ≈ 1344B → 1540B calldata,
// larger than the entire 1232B Solana tx budget. The proxy must holder-stage the
// EVM tx regardless of ALT cover, so persistent ALTs CANNOT collapse this shape
// to one leg (floor: N holder-writes + 1 execute). A 1-leg EVM lane needs a
// compact meta encoding in the CPI precompile (~34B/meta → ~600B calldata) AND
// the rome-dex table covered — the two compose.
//
// Run a fresh measured swap (key never echoed):
//   HADRIAN_PRIVATE_KEY=<your-funded-devnet-key> \
//   EVM_RPC=https://hadrian.testnet.romeprotocol.xyz/ node measure-alt-collapse.mjs
// Analyze an existing tx (no funds spent, no key):
//   EVM_RPC=… node measure-alt-collapse.mjs --analyze 0x<hash>
import fs from "node:fs";
import {
  conn, EVM_RPC, EVM_DEPLOYER, bal, ensureAta, evmPdaFor,
  swapAccountsFor, swapData, execEvmCpi,
} from "./lib.mjs";

const ROME_DEX_ALT = "3Vp2h9LKTquVVXAfdNgF1h87uo1UdnamCre2ARTS213B";
const rpc = async (m, p) => (await (await fetch(EVM_RPC, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
})).json()).result;

async function analyze(hash) {
  const evmTx = await rpc("eth_getTransactionByHash", [hash]);
  const calldataBytes = evmTx ? (evmTx.input.length - 2) / 2 : null;
  const sigs = (await rpc("rome_solanaTxForEvmTx", [hash])) || [];
  const legs = [];
  for (const s of sigs) {
    const tx = await conn.getTransaction(typeof s === "string" ? s : s.signature ?? s.sig,
      { maxSupportedTransactionVersion: 0 });
    legs.push(tx ? {
      cu: tx.meta?.computeUnitsConsumed,
      version: tx.version,
      lookups: (tx.transaction.message.addressTableLookups ?? []).map((l) => l.accountKey.toBase58()),
    } : { cu: null, version: "?", lookups: [] });
  }
  const allLookups = new Set(legs.flatMap((l) => l.lookups));
  const usesRomeDex = allLookups.has(ROME_DEX_ALT);
  const maxCu = Math.max(...legs.map((l) => l.cu ?? 0));

  console.log("── analysis ────────────────────────────");
  console.log(`tx:          ${hash}`);
  console.log(`calldata:    ${calldataBytes}B ${calldataBytes > 1100 ? "(> Solana tx budget → holder-staged regardless of ALT)" : "(could fit inline with ALT cover)"}`);
  console.log(`legs:        ${legs.length}`);
  for (const l of legs) console.log(`  cu=${l.cu} v=${l.version} lookups=[${l.lookups.map((x) => x.slice(0, 8)).join(",")}]`);
  console.log(`exec CU:     ${maxCu}`);
  console.log(`ALT cover:   ${allLookups.size ? [...allLookups].map((x) => x.slice(0, 8)).join(", ") : "none"}${usesRomeDex ? " — includes rome-dex ✓" : " — rome-dex table NOT consulted (proxy config predates its cover entry)"}`);
  if (legs.length === 1) console.log("✅ single atomic leg");
  else if (calldataBytes > 1100) console.log(`ℹ️ ${legs.length}-leg floor is calldata-bound (${calldataBytes}B ABI metas) — compact-meta CPI encoding is the lever, not more ALT cover.`);
  else console.log(`⚠️ ${legs.length} legs despite inline-able calldata — check proxy cover set.`);
}

const argIdx = process.argv.indexOf("--analyze");
if (argIdx !== -1) {
  await analyze(process.argv[argIdx + 1]);
} else {
  const KEY = process.env.HADRIAN_PRIVATE_KEY;
  if (!KEY) { console.error("HADRIAN_PRIVATE_KEY required (or use --analyze 0x<hash>)"); process.exit(1); }
  const pools = JSON.parse(fs.readFileSync(new URL("./pools-real-tiers.json", import.meta.url)));
  const pool = pools.find((p) => p.tier === "0.30%") ?? pools[0];
  console.log(`proxy: ${EVM_RPC}\npool:  ${pool.tier} USDC/SOL  swapState=${pool.swapState}`);
  const pda = evmPdaFor(EVM_DEPLOYER);
  const ataA = await ensureAta(pool.mintA, pda, true);
  const ataB = await ensureAta(pool.mintB, pda, true);
  const [a, b] = [await bal(ataA), await bal(ataB)];
  let dir, src, dst, amt;
  if (a >= 50_000n) { dir = "AtoB"; src = ataA; dst = ataB; amt = 50_000n; }
  else if (b >= 500_000n) { dir = "BtoA"; src = ataB; dst = ataA; amt = 500_000n; }
  else { console.error("PDA holds neither 0.05 USDC nor 0.0005 SOL — fund it first"); process.exit(1); }
  console.log(`swapping ${amt} (${dir})…`);
  const before = await bal(dst);
  const r = await execEvmCpi({ accounts: swapAccountsFor(pool, dir, pda, src, dst), data: swapData(amt, 0n), key: KEY });
  if (!r.ok) { console.error(`swap failed: ${r.error}`); process.exit(1); }
  console.log(`out delta: ${(await bal(dst)) - before}`);
  await analyze(r.txHash);
}
