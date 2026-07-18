// lib/mode.ts — UI utilities and lane-state seam.
// Real pool data comes from the key-less read routes (/api/state, /api/tiers).
//
// Chain, not wallet: the two lanes are identified by CHAIN (evm / solana), never
// by a wallet brand — the product bridges chains and accepts any wallet. Brand
// names survive only in genuine provider detection (lib/solWallet.ts's
// window.phantom / window.solflare) and the picker that lists a user's own
// installed Solana wallets.

export type WalletKind = "evm" | "solana";

export interface WalletState {
  evm: string | null; // 0x… EVM address, or null if disconnected
  solana: string | null; // base58 Solana address, or null if disconnected
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
