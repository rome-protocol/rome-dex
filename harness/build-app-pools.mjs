// build-app-pools.mjs — assemble the multi-pair pool list the app consumes.
//
// The app reads ONE JSON (app/lib/pools-tiers.json) as its whole pool universe.
// This merges the per-pair harness files into that shape, adding the fields the
// multi-pair app needs on every entry:
//   • pairId   — stable pair key ("USDC-SOL", "USDC-ETH")
//   • pairName — display label ("USDC / SOL")
//   • poolId   — GLOBALLY-UNIQUE numeric id used in /pools/<id> routes.
//                pairIndex 0 → poolId = bps (keeps /pools/30 = USDC/SOL 0.30%);
//                pairIndex N → poolId = N*1000 + bps.
//
// Sources (in pair order):
//   pools-real-tiers.json  → USDC/SOL, 3 tiers  (pairIndex 0)
//   pool-real-eth.json     → USDC/ETH, 0.30%    (pairIndex 1)   [array or single obj]
//
// Writes harness/pools-real-pairs.json and (unless NO_APP_COPY) copies it to
// app/lib/pools-tiers.json.  Run: node build-app-pools.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_POOLS = path.resolve(DIR, "../app/lib/pools-tiers.json");
const OUT = path.join(DIR, "pools-real-pairs.json");

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Each source = { file, pairId, pairName }. Pair order defines pairIndex → poolId.
const SOURCES = [
  { file: "pools-real-tiers.json", pairId: "USDC-SOL", pairName: "USDC / SOL" },
  { file: "pool-real-eth.json", pairId: "USDC-ETH", pairName: "USDC / ETH" },
];

const out = [];
SOURCES.forEach((src, pairIndex) => {
  const entries = asArray(readJson(path.join(DIR, src.file)));
  if (!entries.length) { console.warn(`(skip) ${src.file} — not found or empty`); return; }
  for (const e of entries) {
    out.push({
      pairId: src.pairId,
      pairName: src.pairName,
      poolId: pairIndex * 1000 + e.bps,
      ...e,
    });
  }
  console.log(`${src.pairId}: ${entries.length} pool(s) (poolIds ${entries.map((e) => pairIndex * 1000 + e.bps).join(", ")})`);
});

if (!out.length) { console.error("no pools assembled — create the pools first"); process.exit(1); }

const body = JSON.stringify(out, null, 2) + "\n";
fs.writeFileSync(OUT, body);
console.log(`\nwrote ${path.relative(process.cwd(), OUT)} (${out.length} pools across ${SOURCES.length} pairs)`);
if (!process.env.NO_APP_COPY) {
  fs.writeFileSync(APP_POOLS, body);
  console.log(`copied → ${path.relative(process.cwd(), APP_POOLS)}`);
}
