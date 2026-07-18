// Token display metadata — glyphs + brand gradients for the pair icons used
// across the tables, swap card and position cards. Mirrors the mockup palette.

export interface TokenMeta {
  glyph: string;
  grad: string;
}

export const TOKEN_META: Record<string, TokenMeta> = {
  USDC: { glyph: "$", grad: "linear-gradient(135deg,#2775CA,#2f8fff)" },
  USDT: { glyph: "₮", grad: "linear-gradient(135deg,#26A17B,#3fd1a0)" },
  SOL:  { glyph: "◎", grad: "linear-gradient(135deg,#9945FF,#14F195)" },
  WSOL: { glyph: "◎", grad: "linear-gradient(135deg,#9945FF,#14F195)" },
  ETH:  { glyph: "◈", grad: "linear-gradient(135deg,#627EEA,#8aa0ff)" },
  WETH: { glyph: "◈", grad: "linear-gradient(135deg,#627EEA,#8aa0ff)" },
  BTC:  { glyph: "₿", grad: "linear-gradient(135deg,#F7931A,#ffb84d)" },
  WBTC: { glyph: "₿", grad: "linear-gradient(135deg,#F7931A,#ffb84d)" },
};

const FALLBACK: TokenMeta = { glyph: "•", grad: "linear-gradient(135deg,#8A3FB0,#B45CE6)" };

export function tokenMeta(symbol: string): TokenMeta {
  return TOKEN_META[symbol?.toUpperCase()] ?? FALLBACK;
}
