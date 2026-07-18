import type { Metadata } from "next";
import "./globals.css";
import Providers from "@/components/Providers";

export const metadata: Metadata = {
  title: "rome-dex — one pool, two wallets",
  description:
    "A dual-lane DEX on Rome Protocol: swap and provide liquidity from the EVM or Solana lane into one shared native Solana pool.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
