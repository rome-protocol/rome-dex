// Pure chain-selection helpers — NO registry/node import, so the client bundle
// (store.tsx) can use them without pulling in the server-only @rome-protocol/registry
// package (which reads from disk via node:url/node:fs and cannot be bundled for the
// browser). Registry-driven chain metadata is resolved server-side (server.mjs →
// /api/chains) and handed to the client as plain data; these operate on that array.

/** Find a chain config by id in an already-resolved chains array. */
export function getChainConfig(chains, chainId) {
  return chains.find((c) => c.chainId === String(chainId));
}

/** Pick the initial chainId: the persisted one if still valid, else the first chain. */
export function pickInitialChainId(chains, persisted) {
  if (persisted && chains.some((c) => c.chainId === persisted)) return persisted;
  return chains[0]?.chainId ?? "";
}
