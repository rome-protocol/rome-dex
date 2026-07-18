// Server-side chain-config resolver. Reads the mounted chains.yaml (env
// CHAINS_CONFIG_FILE, default ./chains.yaml) once per TTL and resolves a chain by
// id for per-request routing (?chain=<chainId>). Server-only (uses node:fs).
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { normalizeChains, getChainConfig } from "./core.mjs";

let _cache = null;
let _at = 0;
const TTL_MS = 60_000;

export function readChains() {
  if (!_cache || Date.now() - _at > TTL_MS) {
    const path = process.env.CHAINS_CONFIG_FILE || "chains.yaml";
    _cache = normalizeChains(load(readFileSync(path, "utf8")));
    _at = Date.now();
  }
  return _cache;
}

// Resolve the active chain for a request. A falsy chainId → the first (default)
// chain; an unknown chainId → throw (route surfaces it as an error).
export function resolveChain(chainId) {
  const chains = readChains();
  const c = chainId ? getChainConfig(chains, chainId) : chains[0];
  if (!c) throw new Error(`unknown chain '${chainId}'`);
  return c;
}
