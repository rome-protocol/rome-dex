"use client";

import SwapCard from "@/components/SwapCard";
import LegStrip from "@/components/LegStrip";
import { SwapFlowProvider } from "@/components/SwapFlow";
import { useActiveChain } from "@/lib/chains/store";
import { poolSymbols } from "@/lib/walletActions";

export default function SwapScreen() {
  const { chain } = useActiveChain();
  const syms = chain ? poolSymbols(chain) : { A: "A", B: "B" };
  const symIn = syms.A;
  const symOut = syms.B;
  return (
    <div className="wrap page">
      <SwapFlowProvider>
      <div className="swap-stage">
        <div className="swap-stage-head">
          <div className="eyebrow">One pool · two worlds</div>
          <h1 className="swap-stage-title">
            Trade from <span className="e">EVM</span> or <span className="s">Solana</span> — one transaction.
          </h1>
        </div>
        <div className="swap-cols">
          <SwapCard />
          <div className="leg-strip">
            <LegStrip tokenIn={symIn} tokenOut={symOut} tier="0.30%" />
          </div>
        </div>
      </div>
      </SwapFlowProvider>
    </div>
  );
}
