// TypeScript port of sdk/quote.mjs — byte-faithful mirror of the on-chain curve
// (program/src/curve/{constant_product,fees}.rs). Pure BigInt, no deps.
// Both this file and the .mjs original must stay in sync with the program.

export const POOL_FEES = {
  tradeNum: 25n,
  tradeDen: 10_000n,
  ownerNum: 5n,
  ownerDen: 10_000n,
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

function calcFee(amount: bigint, num: bigint, den: bigint): bigint {
  if (num === 0n || amount === 0n) return 0n;
  const fee = (amount * num) / den;
  return fee === 0n ? 1n : fee;
}

function preFeeAmount(post: bigint, num: bigint, den: bigint): bigint {
  if (num === 0n || den === 0n) return post;
  if (num === den || post === 0n) return 0n;
  return ceilDiv(post * den, den - num);
}

function preTradingFeeAmount(
  post: bigint,
  f: typeof POOL_FEES,
): bigint {
  const { tradeNum, tradeDen, ownerNum, ownerDen } = f;
  if (tradeNum === 0n || tradeDen === 0n) return preFeeAmount(post, ownerNum, ownerDen);
  if (ownerNum === 0n || ownerDen === 0n) return preFeeAmount(post, tradeNum, tradeDen);
  return preFeeAmount(
    post,
    tradeNum * ownerDen + ownerNum * tradeDen,
    tradeDen * ownerDen,
  );
}

export interface ExactInResult {
  amountOut: bigint;
  amountIn: bigint;
  tradeFee: bigint;
  ownerFee: bigint;
  feePaid: bigint;
  price: number;
}

export interface ExactOutResult {
  amountIn: bigint;
  amountOut: bigint;
  tradeFee: bigint;
  ownerFee: bigint;
  feePaid: bigint;
  price: number;
}

export function quoteExactIn({
  amountIn,
  reserveIn,
  reserveOut,
  fees = POOL_FEES,
}: {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  fees?: typeof POOL_FEES;
}): ExactInResult {
  const tradeFee = calcFee(amountIn, fees.tradeNum, fees.tradeDen);
  const ownerFee = calcFee(amountIn, fees.ownerNum, fees.ownerDen);
  const inLessFees = amountIn - tradeFee - ownerFee;
  const invariant = reserveIn * reserveOut;
  const newSrc = reserveIn + inLessFees;
  const newDst = ceilDiv(invariant, newSrc);
  const amountOut = reserveOut - newDst;
  const price = amountIn === 0n ? 0 : Number(amountOut) / Number(amountIn);
  return { amountOut, amountIn, tradeFee, ownerFee, feePaid: tradeFee + ownerFee, price };
}

export function quoteExactOut({
  amountOut,
  reserveIn,
  reserveOut,
  fees = POOL_FEES,
}: {
  amountOut: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  fees?: typeof POOL_FEES;
}): ExactOutResult | null {
  if (amountOut >= reserveOut) return null;
  const invariant = reserveIn * reserveOut;
  const newDst = reserveOut - amountOut;
  const newSrc = ceilDiv(invariant, newDst);
  const poolIn = newSrc - reserveIn;
  const amountIn = preTradingFeeAmount(poolIn, fees);
  const tradeFee = calcFee(amountIn, fees.tradeNum, fees.tradeDen);
  const ownerFee = calcFee(amountIn, fees.ownerNum, fees.ownerDen);
  const price = amountOut === 0n ? 0 : Number(amountIn) / Number(amountOut);
  return { amountIn, amountOut, tradeFee, ownerFee, feePaid: tradeFee + ownerFee, price };
}

export function spotPrice({
  reserveIn,
  reserveOut,
}: {
  reserveIn: bigint;
  reserveOut: bigint;
}): number {
  return Number(reserveOut) / Number(reserveIn);
}

// ---- fee-tier-aware best-price selection (Phase 3) — mirrors sdk/quote.mjs ----

export type Fees = typeof POOL_FEES;

export const FEE_TIERS: { tier: string; bps: number; fees: Fees }[] = [
  { tier: "0.05%", bps: 5, fees: { tradeNum: 5n, tradeDen: 10_000n, ownerNum: 0n, ownerDen: 10_000n } },
  { tier: "0.30%", bps: 30, fees: { tradeNum: 25n, tradeDen: 10_000n, ownerNum: 5n, ownerDen: 10_000n } },
  { tier: "1.00%", bps: 100, fees: { tradeNum: 100n, tradeDen: 10_000n, ownerNum: 0n, ownerDen: 10_000n } },
];

export interface TierState {
  tier: string;
  swapState?: string;
  reserveIn: bigint;
  reserveOut: bigint;
  fees?: Fees;
}

export interface TierQuote {
  tier: string;
  swapState?: string;
  quote: ExactInResult | ExactOutResult | null;
}

/**
 * Fee-tier-aware best-price selector — pure over pool states. For exact-in
 * (amountIn set) returns the tier with the greatest amountOut; for exact-out
 * (amountOut set) the tier with the least amountIn. Ties → earlier tier.
 */
export function bestTier({
  amountIn,
  amountOut,
  tiers,
}: {
  amountIn?: bigint;
  amountOut?: bigint;
  tiers: TierState[];
}): { best: TierQuote | null; quotes: TierQuote[] } {
  if (!Array.isArray(tiers) || tiers.length === 0) return { best: null, quotes: [] };
  const exactIn = amountIn != null;
  const quotes: TierQuote[] = tiers.map((t) => {
    const fees = t.fees ?? POOL_FEES;
    const quote = exactIn
      ? quoteExactIn({ amountIn: amountIn!, reserveIn: t.reserveIn, reserveOut: t.reserveOut, fees })
      : quoteExactOut({ amountOut: amountOut!, reserveIn: t.reserveIn, reserveOut: t.reserveOut, fees });
    return { tier: t.tier, swapState: t.swapState, quote };
  });
  let best: TierQuote | null = null;
  for (const c of quotes) {
    if (!c.quote) continue;
    if (best === null) { best = c; continue; }
    if (exactIn) {
      if ((c.quote as ExactInResult).amountOut > (best.quote as ExactInResult).amountOut) best = c;
    } else {
      if ((c.quote as ExactOutResult).amountIn < (best.quote as ExactOutResult).amountIn) best = c;
    }
  }
  return { best, quotes };
}
