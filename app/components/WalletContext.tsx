"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type WalletKind, type WalletState } from "@/lib/mode";
import { connectSolWallet, detectSolWallets, reconnectSolWallet, setActiveSolWallet, type DetectedSolWallet } from "@/lib/solWallet";
import { connectEvmWallet, detectEvmWallets, reconnectEvmWallet, setActiveEvmProvider, type DetectedEvmWallet } from "@/lib/evmWallet";
import { rememberWallet, forgetWallet, rememberedWallets } from "@/lib/walletPersist";

// Per-lane error surface (e.g. no provider installed). null = no error.
type WalletErrors = { evm: string | null; solana: string | null };

interface WalletCtx extends WalletState {
  connect: (kind: WalletKind) => Promise<void>;
  disconnect: (kind: WalletKind) => void;
  anyConnected: boolean;
  errors: WalletErrors;
}

const Ctx = createContext<WalletCtx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({ evm: null, solana: null });
  const [errors, setErrors] = useState<WalletErrors>({ evm: null, solana: null });
  // >1 wallet extension detected → the user picks; null = picker closed.
  const [solChoices, setSolChoices] = useState<DetectedSolWallet[] | null>(null);
  const [evmChoices, setEvmChoices] = useState<DetectedEvmWallet[] | null>(null);

  const connectSol = useCallback(async (wallet: DetectedSolWallet) => {
    setSolChoices(null);
    try {
      const pk = await connectSolWallet(wallet);
      if (pk) {
        setState((s) => ({ ...s, solana: pk }));
        setErrors((e) => ({ ...e, solana: null }));
        rememberWallet("solana", wallet.id);
      }
    } catch {
      // User rejected
    }
  }, []);

  const connectEvm = useCallback(async (wallet: DetectedEvmWallet) => {
    setEvmChoices(null);
    try {
      const addr = await connectEvmWallet(wallet);
      if (addr) {
        setState((s) => ({ ...s, evm: addr }));
        setErrors((e) => ({ ...e, evm: null }));
        rememberWallet("evm", wallet.id);
      }
    } catch {
      // User rejected
    }
  }, []);

  // Silent session restore on load. The wallet keeps the site authorized
  // across refreshes — the app just has to ask the SAME provider again,
  // popup-free (eth_accounts / connect({ onlyIfTrusted })). A failed restore
  // (revoked / no longer trusted) clears the memory: no error, no popup —
  // the pill simply shows Connect again.
  useEffect(() => {
    let live = true;
    (async () => {
      const remembered = rememberedWallets();
      if (remembered.evm) {
        try {
          const wallets = await detectEvmWallets();
          const w = wallets.find((x) => x.id === remembered.evm);
          const addr = w ? await reconnectEvmWallet(w) : null;
          if (addr && live) {
            setState((s) => ({ ...s, evm: addr }));
          } else if (!addr) {
            forgetWallet("evm");
          }
        } catch { forgetWallet("evm"); }
      }
      if (remembered.solana) {
        try {
          const wallets = detectSolWallets();
          const w = wallets.find((x) => x.id === remembered.solana);
          const pk = w ? await reconnectSolWallet(w) : null;
          if (pk && live) {
            setState((s) => ({ ...s, solana: pk }));
          } else if (!pk) {
            forgetWallet("solana");
          }
        } catch { forgetWallet("solana"); }
      }
    })();
    return () => { live = false; };
  }, []);

  const connect = useCallback(async (kind: WalletKind) => {
    if (kind === "evm") {
      const wallets = await detectEvmWallets();
      if (wallets.length === 0) {
        // No injected provider — surface an error, never a fake address.
        setErrors((e) => ({ ...e, evm: "No EVM wallet detected" }));
        return;
      }
      if (wallets.length === 1) {
        await connectEvm(wallets[0]);
        return;
      }
      setEvmChoices(wallets); // several installed → user chooses
    } else {
      const wallets = detectSolWallets();
      if (wallets.length === 0) {
        // No injected provider — surface an error, never a fake address.
        setErrors((e) => ({ ...e, solana: "No Solana wallet detected" }));
        return;
      }
      if (wallets.length === 1) {
        await connectSol(wallets[0]);
        return;
      }
      setSolChoices(wallets); // several installed → user chooses
    }
  }, [connectEvm, connectSol]);

  const disconnect = useCallback((kind: WalletKind) => {
    setState((s) => ({ ...s, [kind]: null }));
    forgetWallet(kind); // explicit disconnect wins over the wallet's site authorization
    if (kind === "evm") {
      setActiveEvmProvider(null);
    } else {
      const sol = (window as Window & { solana?: { disconnect?: () => Promise<void> } }).solana;
      sol?.disconnect?.().catch(() => {});
      setActiveSolWallet(null);
    }
  }, []);

  const value = useMemo<WalletCtx>(
    () => ({
      ...state,
      anyConnected: Boolean(state.evm || state.solana),
      connect,
      disconnect,
      errors,
    }),
    [state, connect, disconnect, errors],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {evmChoices && (
        <div className="confirm-modal-overlay" onClick={() => setEvmChoices(null)}>
          <div className="confirm-modal" data-testid="evm-wallet-picker" onClick={(e) => e.stopPropagation()}>
            <h3>Connect an EVM wallet</h3>
            <div className="modal-actions" style={{ flexDirection: "column" }}>
              {evmChoices.map((w) => (
                <button key={w.id} className="btn" data-testid={`evm-wallet-option-${w.id}`} onClick={() => connectEvm(w)}>
                  {w.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={w.icon} alt="" width={18} height={18} style={{ verticalAlign: "middle", marginRight: 8 }} />
                  ) : (
                    "◆ "
                  )}
                  {w.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {solChoices && (
        <div className="confirm-modal-overlay" onClick={() => setSolChoices(null)}>
          <div className="confirm-modal" data-testid="sol-wallet-picker" onClick={(e) => e.stopPropagation()}>
            <h3>Connect a Solana wallet</h3>
            <div className="modal-actions" style={{ flexDirection: "column" }}>
              {solChoices.map((w) => (
                <button key={w.id} className="btn" data-testid={`sol-wallet-option-${w.id}`} onClick={() => connectSol(w)}>
                  ◎ {w.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useWallet(): WalletCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used within WalletProvider");
  return v;
}
