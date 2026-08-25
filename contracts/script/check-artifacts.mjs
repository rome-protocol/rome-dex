#!/usr/bin/env node
// Bytecode integrity check for contracts/out.
//
// Compares the *bytecode* (bytecode.object + deployedBytecode.object) of
// every committed artifact under out/ (excluding out/build-info/, which is
// hash-named and regenerated on every build) against a freshly built copy
// on disk. This is deliberately NOT a raw file diff of out/: `forge build
// --force` legitimately rewrites out/build-info/<hash>.json and the
// one-line build-info reference embedded in each artifact, so a raw diff
// is red on day one even with zero source changes. Bytecode is the part
// that is actually stable across a forced rebuild when nothing changed,
// so it's what catches a stale committed artifact.
//
// Committed artifacts are read via `git show HEAD:...` rather than copying
// out/ aside before building, so this script needs no pre-build step and
// always compares against what's actually in the commit under test.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const OUT_DIR = "out";
const EXCLUDE_DIR = join(OUT_DIR, "build-info");

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full === EXCLUDE_DIR) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, files);
    } else if (entry.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

function gitShowCommitted(path) {
  try {
    // `git show <rev>:<path>` resolves <path> against the repo root, not
    // cwd (unlike `git ls-tree`, which is cwd-relative) - the `./` prefix
    // is what tells it "relative to here". Without it, a cwd-relative
    // path like `out/Foo.json` run from within `contracts/` 404s because
    // git looks for it at the repo root instead.
    return execFileSync("git", ["show", `HEAD:./${path}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch {
    return null; // not tracked at HEAD
  }
}

function bytecodeOf(json) {
  return {
    bytecode: json?.bytecode?.object ?? null,
    deployedBytecode: json?.deployedBytecode?.object ?? null,
  };
}

const freshFiles = walk(OUT_DIR);
let compared = 0;
const mismatches = [];
const missingFromFresh = [];

// Committed artifacts = every out/**/*.json tracked at HEAD (excluding
// build-info), read via git show so this doesn't depend on what happens
// to be on disk right now.
const trackedOutFiles = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", "HEAD", "--", OUT_DIR],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((p) => p.endsWith(".json") && !p.startsWith(EXCLUDE_DIR + "/") && p !== EXCLUDE_DIR);

for (const committedPath of trackedOutFiles) {
  const committedRaw = gitShowCommitted(committedPath);
  if (committedRaw === null) continue; // shouldn't happen, ls-tree just listed it
  let committedJson;
  try {
    committedJson = JSON.parse(committedRaw);
  } catch (e) {
    mismatches.push(`${committedPath}: committed artifact is not valid JSON (${e.message})`);
    continue;
  }

  if (!freshFiles.includes(committedPath)) {
    missingFromFresh.push(committedPath);
    continue;
  }

  let freshJson;
  try {
    freshJson = JSON.parse(readFileSync(committedPath, "utf8"));
  } catch (e) {
    mismatches.push(`${committedPath}: freshly built artifact is not valid JSON (${e.message})`);
    continue;
  }

  const committedBc = bytecodeOf(committedJson);
  const freshBc = bytecodeOf(freshJson);
  compared++;

  if (committedBc.bytecode !== freshBc.bytecode) {
    mismatches.push(`${committedPath}: bytecode.object differs from a fresh build`);
  }
  if (committedBc.deployedBytecode !== freshBc.deployedBytecode) {
    mismatches.push(`${committedPath}: deployedBytecode.object differs from a fresh build`);
  }
}

if (missingFromFresh.length > 0) {
  console.error("FATAL: committed artifacts missing from a fresh build:");
  for (const p of missingFromFresh) console.error(`  - ${p}`);
}

if (mismatches.length > 0) {
  console.error("FATAL: bytecode mismatches between committed artifacts and a fresh build:");
  for (const m of mismatches) console.error(`  - ${m}`);
}

if (compared === 0) {
  console.error("FATAL: compared 0 artifacts — vacuous pass (path or exclusion bug?)");
  process.exit(1);
}

if (missingFromFresh.length > 0 || mismatches.length > 0) {
  process.exit(1);
}

console.log(`OK: ${compared} artifact(s) compared, 0 mismatches, 0 missing.`);
