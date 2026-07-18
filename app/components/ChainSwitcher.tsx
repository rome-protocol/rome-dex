"use client";

// Header chain selector. Hidden when only one chain is configured (single-chain
// deployments look exactly as before). Switching updates the persisted store;
// TopNav's effect then re-points the EVM wallet's network to match.
import { useActiveChain } from "@/lib/chains/store";

export default function ChainSwitcher() {
  const { chains, chainId, setChainId } = useActiveChain();
  if (chains.length <= 1) return null;
  return (
    <select
      className="chainsel"
      aria-label="Chain"
      data-testid="chain-switcher"
      value={chainId}
      onChange={(e) => setChainId(e.target.value)}
    >
      {chains.map((c) => (
        <option key={c.chainId} value={c.chainId}>{c.name}</option>
      ))}
    </select>
  );
}
