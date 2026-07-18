import { tokenMeta } from "@/lib/tokens";

export function Glyph({ symbol, size = 26 }: { symbol: string; size?: number }) {
  const m = tokenMeta(symbol);
  return (
    <span className="tglyph" style={{ background: m.grad, width: size, height: size, fontSize: size * 0.46 }}>
      {m.glyph}
    </span>
  );
}

export function PairGlyphs({ a, b }: { a: string; b: string }) {
  return (
    <span className="pairglyphs">
      <Glyph symbol={a} />
      <Glyph symbol={b} />
    </span>
  );
}
