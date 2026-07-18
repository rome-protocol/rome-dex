// explorer.ts — the ONE lane-aware tx-link helper, shared by every panel
// (swap / liquidity / farms). EVM-lane tx hash (0x…) → the active chain's Via
// explorer; Solana-lane signature (base58) → Solana explorer pinned to the
// chain's substrate cluster RPC (never a wallet-default public cluster). Both
// endpoints come from the active ChainConfig, no longer hardcoded.

const EXPLORER_BASE = "https://explorer.solana.com/tx";

export function explorerUrl(id: string, chain: { explorerBase: string; solanaRpc: string }): string {
  return id.startsWith("0x")
    ? `${chain.explorerBase}/${id}`
    : `${EXPLORER_BASE}/${id}?cluster=custom&customUrl=${encodeURIComponent(chain.solanaRpc)}`;
}
