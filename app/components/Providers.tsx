"use client";

// App-wide client shell: chain registry + wallet + USD-price context, the sticky
// top nav, and a footer. Kept in one client boundary so wallet + chain selection
// survive route changes.

import { WalletProvider } from "@/components/WalletContext";
import { PriceProvider } from "@/components/UsdValue";
import TopNav from "@/components/TopNav";
import { ChainProvider, useActiveChain } from "@/lib/chains/store";

// Symbols the app prices in USD (oracle-backed via /api/price). USDC/SOL are the
// live pool pair; ETH is here for the wETH glyphs used in illustrative rows.
const PRICED_SYMBOLS = ["USDC", "SOL", "ETH"];

function Footer() {
  const { chain } = useActiveChain();
  const where = chain ? `${chain.name} (Solana ${chain.solanaCluster})` : "…";
  return (
    <footer className="foot">
      <div className="wrap">
        <span>rome-dex · live on {where} · every figure on-chain</span>
      </div>
    </footer>
  );
}

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ChainProvider>
      <WalletProvider>
        <PriceProvider symbols={PRICED_SYMBOLS}>
          <TopNav />
          <main>{children}</main>
          <Footer />
        </PriceProvider>
      </WalletProvider>
    </ChainProvider>
  );
}
