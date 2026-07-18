"use client";

// evmWallet.ts — EVM wallet-provider detection + selection (EIP-6963).
// The EVM lane must not be first-injector-wins: with several extensions
// installed (MetaMask, Coinbase), `window.ethereum` is whichever won the
// injection race, so the user gets no choice. EIP-6963 enumerates every
// injected provider; the user picks; the chosen provider is what every
// EVM-lane tx builder uses (getActiveEvmProvider) — never a bare
// window.ethereum grab. Mirrors lib/solWallet.ts for the Solana lane.

import type { Eip1193Provider } from "ethers";

export type EvmProvider = Eip1193Provider & {
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  on?: (...args: unknown[]) => void;
  removeListener?: (...args: unknown[]) => void;
};

interface Eip6963Info { uuid: string; name: string; icon: string; rdns: string }
interface Eip6963Detail { info: Eip6963Info; provider: EvmProvider }

export interface DetectedEvmWallet {
  id: string;      // EIP-6963 rdns (stable), or "injected" for the legacy fallback
  label: string;
  icon?: string;   // data-URI from the wallet's EIP-6963 announcement
  provider: EvmProvider;
}

// Providers announce in response to eip6963:requestProvider. We keep a running
// store keyed by rdns (dedup) that starts listening at import time.
const store = new Map<string, DetectedEvmWallet>();

function onAnnounce(ev: Event): void {
  const d = (ev as CustomEvent<Eip6963Detail>).detail;
  if (!d?.info?.rdns || !d.provider) return;
  store.set(d.info.rdns, { id: d.info.rdns, label: d.info.name, icon: d.info.icon, provider: d.provider });
}

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener);
  // Prompt any already-loaded wallets to announce.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/**
 * Every injected EVM wallet we can see via EIP-6963, in announcement order.
 * Falls back to a single window.ethereum entry for legacy wallets that don't
 * implement EIP-6963 (so behavior is unchanged when only one is installed).
 */
export async function detectEvmWallets(): Promise<DetectedEvmWallet[]> {
  if (typeof window === "undefined") return [];
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Announcements are dispatched synchronously by most wallets; a short wait
  // covers the stragglers.
  await new Promise((r) => setTimeout(r, 120));
  const list = Array.from(store.values());
  if (list.length > 0) return list;

  const eth = window.ethereum as EvmProvider | undefined;
  if (eth) {
    const label = eth.isMetaMask ? "MetaMask" : eth.isCoinbaseWallet ? "Coinbase Wallet" : "Injected wallet";
    return [{ id: "injected", label, provider: eth }];
  }
  return [];
}

// The provider the user connected with — the ONE source for all EVM-lane txs.
let active: EvmProvider | null = null;

export function setActiveEvmProvider(p: EvmProvider | null): void {
  active = p;
}

/** Selected provider, falling back to window.ethereum for safety. */
export function getActiveEvmProvider(): EvmProvider | null {
  if (active) return active;
  return typeof window === "undefined" ? null : ((window.ethereum as EvmProvider | undefined) ?? null);
}

/** The active provider or throw — for EVM-lane tx builders. */
export function requireEvmProvider(): EvmProvider {
  const p = getActiveEvmProvider();
  if (!p) throw new Error("EVM wallet not available");
  return p;
}

/** Connect a specific detected wallet; returns the EOA (null = rejected). */
export async function connectEvmWallet(wallet: DetectedEvmWallet): Promise<string | null> {
  const accounts = (await wallet.provider.request({ method: "eth_requestAccounts" })) as string[];
  const addr = accounts?.[0] ?? null;
  if (addr) setActiveEvmProvider(wallet.provider);
  return addr;
}

/** Silent session restore: eth_accounts returns the connected accounts WITHOUT
 *  a popup when the site is still authorized in the wallet; [] when revoked. */
export async function reconnectEvmWallet(wallet: DetectedEvmWallet): Promise<string | null> {
  const accounts = (await wallet.provider.request({ method: "eth_accounts" })) as string[];
  const addr = accounts?.[0] ?? null;
  if (addr) setActiveEvmProvider(wallet.provider);
  return addr;
}
