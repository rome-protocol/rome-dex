"use client";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ChainConfig } from "./types";
import { getChainConfig, pickInitialChainId } from "./core.mjs";
import { CHAIN_STORAGE_KEY } from "./store-constants.mjs";

interface Ctx {
  chains: ChainConfig[];
  chainId: string;
  setChainId(id: string): void;
  chain: ChainConfig | null;
}
const ChainCtx = createContext<Ctx | null>(null);

export async function loadChains(): Promise<ChainConfig[]> {
  const r = await fetch("/api/chains", { cache: "no-store" });
  if (!r.ok) throw new Error(`/api/chains ${r.status}`);
  return (await r.json()) as ChainConfig[];
}

export function ChainProvider({ children }: { children: React.ReactNode }) {
  const [chains, setChains] = useState<ChainConfig[]>([]);
  const [chainId, setChainIdState] = useState<string>("");
  useEffect(() => {
    loadChains()
      .then((cs) => {
        setChains(cs);
        const persisted =
          typeof window !== "undefined" ? window.localStorage.getItem(CHAIN_STORAGE_KEY) : null;
        setChainIdState(pickInitialChainId(cs, persisted));
      })
      .catch((e) => console.error("loadChains failed", e));
  }, []);
  const setChainId = (id: string) => {
    setChainIdState(id);
    if (typeof window !== "undefined") window.localStorage.setItem(CHAIN_STORAGE_KEY, id);
  };
  const chain = useMemo(() => getChainConfig(chains, chainId) ?? null, [chains, chainId]);
  return <ChainCtx.Provider value={{ chains, chainId, setChainId, chain }}>{children}</ChainCtx.Provider>;
}

export function useActiveChain(): Ctx {
  const c = useContext(ChainCtx);
  if (!c) throw new Error("useActiveChain outside ChainProvider");
  return c;
}
