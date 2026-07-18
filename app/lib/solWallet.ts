"use client";

// solWallet.ts — Solana wallet-provider detection + selection.
// The SOL lane must not be Phantom-only: with several wallet extensions
// installed (Phantom, Solflare), the user chooses; with exactly one, it
// connects directly. The chosen provider is what every Solana-lane tx
// builder signs with (getActiveSolWallet) — never a bare window.solana
// grab, which is whichever extension won the injection race.

import type { Transaction } from "@solana/web3.js";

export interface SolProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  /** Solflare keeps the key on the provider; Phantom returns it from connect(). */
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<unknown>;
  disconnect?: () => Promise<void>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

export type SolWalletId = "phantom" | "solflare";

export interface DetectedSolWallet {
  id: SolWalletId;
  label: string;
  provider: SolProvider;
}

type SolWindow = Window & {
  phantom?: { solana?: SolProvider };
  solflare?: SolProvider;
  solana?: SolProvider;
};

/** Every injected Solana wallet we recognize, in stable display order. */
export function detectSolWallets(): DetectedSolWallet[] {
  if (typeof window === "undefined") return [];
  const w = window as SolWindow;
  const out: DetectedSolWallet[] = [];
  const phantom = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : undefined);
  if (phantom) out.push({ id: "phantom", label: "Phantom", provider: phantom });
  if (w.solflare) out.push({ id: "solflare", label: "Solflare", provider: w.solflare });
  // Unrecognized generic injector — treat as the sole option rather than failing.
  if (out.length === 0 && w.solana) out.push({ id: "phantom", label: "Solana wallet", provider: w.solana });
  return out;
}

// The provider the user connected with — the ONE signer for all Solana-lane txs.
let active: SolProvider | null = null;

export function setActiveSolWallet(p: SolProvider | null): void {
  active = p;
}

/** Selected provider, falling back to window.solana for safety. */
export function getActiveSolWallet(): SolProvider | null {
  if (active) return active;
  return typeof window === "undefined" ? null : ((window as SolWindow).solana ?? null);
}

/** Connect a specific detected wallet; returns the base58 pubkey (null = rejected). */
export async function connectSolWallet(wallet: DetectedSolWallet): Promise<string | null> {
  const res = (await wallet.provider.connect()) as { publicKey?: { toString(): string } } | boolean | undefined;
  const pk = (typeof res === "object" && res?.publicKey ? res.publicKey : wallet.provider.publicKey)?.toString() ?? null;
  if (pk) setActiveSolWallet(wallet.provider);
  return pk;
}

/** Silent session restore: connect({ onlyIfTrusted: true }) resolves without a
 *  popup when the site is already trusted, and rejects when it isn't. */
export async function reconnectSolWallet(wallet: DetectedSolWallet): Promise<string | null> {
  const res = (await wallet.provider.connect({ onlyIfTrusted: true })) as { publicKey?: { toString(): string } } | boolean | undefined;
  const pk = (typeof res === "object" && res?.publicKey ? res.publicKey : wallet.provider.publicKey)?.toString() ?? null;
  if (pk) setActiveSolWallet(wallet.provider);
  return pk;
}
