#!/usr/bin/env node
// gen-chain-entry.mjs — emit a chains.yaml entry for a rome-dex chain from its
// harness outputs + a small metadata file, so pool accounts / swap-states /
// clmm accounts are never hand-transcribed.
//
// Inputs:
//   --meta <file.json>   chain metadata (required). Shape:
//     {
//       "chainId": "200010", "name": "Hadrian",
//       "evmRpc": "...", "solanaRpc": "...", "solanaCluster": "devnet",
//       "explorerBase": "https://.../tx", "romeEvmProgramId": "...",
//       "oracle": { "feeds": { "SOL/USD": "0x..", "USDC/USD": "0x..", "ETH/USD": "0x.." } },
//       "clmm": { "symbol0": "tRDA", "symbol1": "tRDB", "decimals0": 6, "decimals1": 6 }
//     }
//   --harness <dir>      harness output dir (default: <repo>/harness). Reads
//     pools-tiers.json (required), router.json (required),
//     farm.json (optional), clmm.json + clmm-router.json (optional).
//
// Output: a YAML block { chains: [ <entry> ] } printed to stdout — paste the
// list item into app/chains.yaml or your chain inventory.
//
// Usage:
//   node scripts/gen-chain-entry.mjs --meta ./my-chain.json [--harness ./harness]

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, "..");
// js-yaml lives in the app workspace; resolve it from there.
const requireFromApp = createRequire(join(REPO, "app", "package.json"));
const yaml = requireFromApp("js-yaml");

function usage(code = 0) {
  console.log(`gen-chain-entry.mjs — emit a chains.yaml entry from harness outputs.

Usage:
  node scripts/gen-chain-entry.mjs --meta <metadata.json> [--harness <dir>]

  --meta     chain metadata JSON (chainId, name, evmRpc, solanaRpc,
             solanaCluster, explorerBase, romeEvmProgramId, oracle.feeds,
             clmm.{symbol0,symbol1,decimals0,decimals1}). Required.
  --harness  harness output dir (default: <repo>/harness). Reads
             pools-tiers.json + router.json (required), farm.json + clmm.json
             + clmm-router.json (optional).
  -h, --help this message.

Output: YAML for { chains: [entry] } on stdout — paste the list item into
app/chains.yaml or your chain inventory.`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { harness: join(REPO, "harness") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--meta") out.meta = argv[++i];
    else if (a === "--harness") out.harness = argv[++i];
    else { console.error(`unknown arg: ${a}`); usage(1); }
  }
  if (!out.meta) { console.error("error: --meta <file.json> is required\n"); usage(1); }
  return out;
}

function readJson(path, { required } = { required: true }) {
  if (!existsSync(path)) {
    if (required) { console.error(`error: missing required file ${path}`); process.exit(1); }
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const args = parseArgs(process.argv.slice(2));
const meta = readJson(resolve(args.meta));
const H = args.harness;

const tiers = readJson(join(H, "pools-tiers.json"));       // required
const router = readJson(join(H, "router.json"));            // required
const farm = readJson(join(H, "farm.json"), { required: false });
const clmm = readJson(join(H, "clmm.json"), { required: false });
const clmmRouter = readJson(join(H, "clmm-router.json"), { required: false });

for (const [k] of Object.entries({
  chainId: 1, name: 1, evmRpc: 1, solanaRpc: 1, explorerBase: 1, romeEvmProgramId: 1,
})) {
  if (meta[k] == null || meta[k] === "") { console.error(`error: --meta missing '${k}'`); process.exit(1); }
}

const entry = {
  chainId: String(meta.chainId),
  name: meta.name,
  evmRpc: meta.evmRpc,
  solanaRpc: meta.solanaRpc,
  solanaCluster: meta.solanaCluster ?? "devnet",
  explorerBase: meta.explorerBase,
  romeEvmProgramId: meta.romeEvmProgramId,
  oracle: { feeds: meta.oracle?.feeds ?? {} },
  dex: {
    dexProgram: router.dexProgram,
    router: router.address,
    tiers,
  },
};
if (farm) entry.dex.farm = farm;

if (clmm && clmmRouter) {
  const md = meta.clmm ?? {};
  entry.clmm = {
    program: clmm.program,
    router: clmmRouter.address,
    pools: [{
      pool: clmm.pool,
      mint0: clmm.mint0,
      mint1: clmm.mint1,
      vault0: clmm.vault0,
      vault1: clmm.vault1,
      feePips: clmm.feePips,
      tickSpacing: clmm.tickSpacing,
      symbol0: md.symbol0 ?? "T0",
      symbol1: md.symbol1 ?? "T1",
      decimals0: md.decimals0 ?? 6,
      decimals1: md.decimals1 ?? 6,
      tickArrays: clmm.tickArrays,
    }],
  };
} else if (clmm || clmmRouter) {
  console.error("warning: clmm needs BOTH clmm.json and clmm-router.json — clmm block omitted");
}

process.stdout.write(yaml.dump({ chains: [entry] }, { lineWidth: 200, quotingType: '"' }));
