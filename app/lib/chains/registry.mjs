// Registry-sourced chain-level config. The public @rome-protocol/registry is the
// single source of truth for chain METADATA — RPCs (incl. the public Solana RPC),
// explorer, rome-evm program id, and oracle feeds. rome-dex's dex/clmm POOL data
// (swapState / vaults / mints — public on-chain addresses the registry doesn't
// track) stays local and is merged on top in core.mjs.
//
// This is what makes rome-dex registry-driven and removes every hardcoded
// internal Solana RPC: the solanaRpc now comes from chain.json's `solana.rpc`,
// which the public registry publishes as the public endpoint.
import { getChain, getOracle, listChains } from "@rome-protocol/registry";

/**
 * Chain-level ChainConfig fields for `chainId`, sourced from the public registry.
 * Throws (fail-closed) for a chain that isn't published — the app only serves the
 * registry's allowlist (Hadrian + Martius today).
 */
export function registryChainFields(chainId) {
  const c = getChain(Number(chainId));
  if (!c) throw new Error(`registry: no published chain '${chainId}'`);

  const explorer = String(c.explorerUrl || "").replace(/\/+$/, "");
  const feeds = {};
  try {
    for (const [sym, v] of Object.entries(getOracle(Number(chainId))?.feeds ?? {})) {
      const addr = typeof v === "string" ? v : v?.address;
      if (addr) feeds[sym] = addr;
    }
  } catch { /* oracle projection optional per chain */ }

  return {
    chainId: String(c.chainId),
    name: c.name,
    evmRpc: c.rpcUrl,
    solanaRpc: c.solana.rpc,
    solanaCluster: c.solana.cluster,
    explorerBase: explorer ? `${explorer}/tx` : "",
    romeEvmProgramId: c.romeEvmProgramId,
    oracle: { feeds },
  };
}

/** The chainIds published in the registry — rome-dex's public chain allowlist. */
export function publishedChainIds() {
  return listChains().map((c) => String(c.chainId));
}
