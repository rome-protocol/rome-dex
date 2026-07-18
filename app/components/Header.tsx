"use client";

import { shortAddr, type WalletKind } from "@/lib/mode";
import { useWallet } from "./WalletContext";

function ConnectPill({ kind, label }: { kind: WalletKind; label: string }) {
  const w = useWallet();
  const addr = w[kind];
  const on = Boolean(addr);
  return (
    <button
      className={`pill${on ? " on" : ""}`}
      data-testid={`wallet-pill-${kind}`}
      onClick={() => (on ? w.disconnect(kind) : w.connect(kind))}
      title={on ? `${label} connected — click to disconnect` : `Connect ${label}`}
    >
      <span className="dot" />
      {on ? <span className="mono">{shortAddr(addr!)}</span> : `Connect ${label}`}
    </button>
  );
}

export default function Header() {
  return (
    <header className="nav">
      <div className="brand">
        <span className="mark">rome-dex</span>
        <span className="sub">one pool, two wallets</span>
      </div>
      <div className="pills">
        <ConnectPill kind="evm" label="EVM" />
        <ConnectPill kind="solana" label="Solana" />
      </div>
    </header>
  );
}
