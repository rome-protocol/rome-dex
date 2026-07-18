"use client";

// walletPersist.ts — remembers WHICH wallet the user connected per lane, so a
// page load can restore the session silently (the wallet keeps the site
// authorized across refreshes; the app just has to ask the right provider).
// Stores only the wallet id (EIP-6963 rdns / "injected" / "phantom"…) — never
// addresses or anything sensitive. Cleared by explicit disconnect, and by a
// failed silent restore (revoked authorization), so state never goes stale.

import type { WalletKind } from "./mode";

const KEY = "rome-dex:wallets";

type Remembered = Partial<Record<WalletKind, string>>;

function read(): Remembered {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Remembered) : {};
  } catch {
    return {};
  }
}

function write(v: Remembered): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch { /* storage unavailable — persistence is best-effort */ }
}

export function rememberWallet(kind: WalletKind, id: string): void {
  write({ ...read(), [kind]: id });
}

export function forgetWallet(kind: WalletKind): void {
  const v = read();
  delete v[kind];
  write(v);
}

export function rememberedWallets(): Remembered {
  return typeof window === "undefined" ? {} : read();
}
