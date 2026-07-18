"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { shortAddr, type WalletKind } from "@/lib/mode";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { ensureEvmNetwork } from "@/lib/walletActions";
import { getActiveEvmProvider } from "@/lib/evmWallet";
import ChainSwitcher from "./ChainSwitcher";

const TABS: { href: string; label: string }[] = [
  { href: "/", label: "Swap" },
  { href: "/pools", label: "Pools" },
  { href: "/clmm", label: "CLMM" },
  { href: "/positions", label: "Positions" },
  { href: "/farms", label: "Farms" },
  { href: "/analytics", label: "Analytics" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

function WalletPill({ kind, tag, glyph }: { kind: WalletKind; tag: string; glyph: string }) {
  const w = useWallet();
  const addr = w[kind];
  const on = Boolean(addr);
  const laneClass = kind === "evm" ? "evm" : "sol";
  return (
    <button
      className={`wpill ${laneClass}${on ? " on" : ""}`}
      data-testid={`wallet-pill-${kind}`}
      onClick={() => (on ? w.disconnect(kind) : w.connect(kind))}
      title={on ? `${tag} connected — click to disconnect` : `Connect ${tag}`}
    >
      <span className="d" />
      <span className="k">{glyph} {tag}</span>
      {on ? (
        <>
          <span className="mono">{shortAddr(addr!)}</span>
          <span className="x" aria-hidden="true">✕</span>
        </>
      ) : "Connect"}
    </button>
  );
}

export default function TopNav() {
  const pathname = usePathname() ?? "/";
  const { chain, chainId } = useActiveChain();
  const w = useWallet();

  // Keep the EVM wallet's network aligned with the active chain: whenever the
  // selected chain (or EVM connection) changes and MetaMask is connected,
  // switch/add the network so EVM-lane writes land on the right chain.
  useEffect(() => {
    if (w.evm && chain && typeof window !== "undefined" && getActiveEvmProvider()) {
      ensureEvmNetwork(chain).catch((e) => console.warn("EVM network switch declined", e));
    }
  }, [chainId, w.evm, chain]);

  return (
    <div className="top">
      <div className="thread" />
      <div className="wrap">
        <div className="nav">
          <Link className="mark" href="/">
            <span className="logo">ROME</span>
            <span className="dex">dex</span>
          </Link>
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                role="tab"
                aria-current={isActive(pathname, t.href) ? "true" : undefined}
                aria-selected={isActive(pathname, t.href)}
                data-testid={`tab-${t.label.toLowerCase()}`}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="rightnav">
            <ChainSwitcher />
            <WalletPill kind="evm" tag="EVM" glyph="◆" />
            <WalletPill kind="solana" tag="SOL" glyph="◎" />
          </div>
        </div>
      </div>
    </div>
  );
}
