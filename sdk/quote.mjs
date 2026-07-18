// rome-dex off-chain quote SDK — a byte-faithful mirror of the on-chain
// constant-product + fee math (program/src/curve/{constant_product,fees}.rs).
// Every quote returned here equals what the pool actually delivers on-chain,
// to the unit. Pure BigInt, no dependencies — importable by the harness, the
// app, and any router.

/// Default fee config of the live pool: trade 0.25% + owner 0.05%.
export const POOL_FEES = { tradeNum: 25n, tradeDen: 10_000n, ownerNum: 5n, ownerDen: 10_000n };

const B = (v) => BigInt(v);
const ceilDiv = (a, b) => (a + b - 1n) / b; // matches spl-math CheckedCeilDiv quotient

// fees.rs::calculate_fee — floor, with a minimum fee of 1 when a rate applies.
function calcFee(amount, num, den) {
  if (num === 0n || amount === 0n) return 0n;
  const fee = (amount * num) / den;
  return fee === 0n ? 1n : fee;
}

// fees.rs::pre_fee_amount — invert a single fee fraction (ceil).
function preFeeAmount(post, num, den) {
  if (num === 0n || den === 0n) return post;
  if (num === den || post === 0n) return 0n;
  return ceilDiv(post * den, den - num);
}

// fees.rs::pre_trading_fee_amount — invert the combined trade + owner fee.
function preTradingFeeAmount(post, f) {
  const { tradeNum, tradeDen, ownerNum, ownerDen } = f;
  if (tradeNum === 0n || tradeDen === 0n) return preFeeAmount(post, ownerNum, ownerDen);
  if (ownerNum === 0n || ownerDen === 0n) return preFeeAmount(post, tradeNum, tradeDen);
  return preFeeAmount(post, tradeNum * ownerDen + ownerNum * tradeDen, tradeDen * ownerDen);
}

/// Exact-in: given an input amount, how much output the pool delivers.
/// Mirrors SwapCurve::swap → ConstantProductCurve::swap.
export function quoteExactIn({ amountIn, reserveIn, reserveOut, fees = POOL_FEES }) {
  amountIn = B(amountIn); reserveIn = B(reserveIn); reserveOut = B(reserveOut);
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

/// Exact-out: given a desired output amount, how much input the pool requires
/// (curve input grossed up for fees). Mirrors SwapCurve::swap_for_exact_out →
/// ConstantProductCurve::swap_to_exact_out. Returns null if the output would
/// drain the reserve.
export function quoteExactOut({ amountOut, reserveIn, reserveOut, fees = POOL_FEES }) {
  amountOut = B(amountOut); reserveIn = B(reserveIn); reserveOut = B(reserveOut);
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

/// Multi-hop exact-in route quote. `hops` is an ordered list of
/// `{ reserveIn, reserveOut, fees }` (one per pool leg); the output of each leg
/// feeds the next. Mirrors executing N exact-in swaps in sequence, so it equals
/// the realized end-to-end output on-chain.
export function quoteRoute({ amountIn, hops }) {
  let amt = B(amountIn);
  const legs = [];
  for (const h of hops) {
    const q = quoteExactIn({ amountIn: amt, reserveIn: h.reserveIn, reserveOut: h.reserveOut, fees: h.fees ?? POOL_FEES });
    legs.push(q);
    amt = q.amountOut;
  }
  return { amountIn: B(amountIn), amountOut: amt, legs };
}

/// Zap-in quote: provide a single token (A) and receive LP in one atomic tx by
/// swapping a portion A→B, then depositing the freshly-swapped B (plus matching
/// A) as balanced liquidity. Returns the swap amount and the LP tokens mintable,
/// bound by the swapped B side (the scarce leg). Because the deposit rounds
/// trading-tokens UP, we shave a 2-unit safety margin so the on-chain deposit
/// never needs more B than the swap produced. LP minted on-chain == lpTokens
/// exactly (DepositAllTokenTypes mints exactly the requested pool amount).
export function quoteZap({ amountIn, reserveA, reserveB, lpSupply, fees = POOL_FEES }) {
  amountIn = B(amountIn); reserveA = B(reserveA); reserveB = B(reserveB); lpSupply = B(lpSupply);
  const swapAmount = amountIn / 2n; // swap half of A into B
  const sw = quoteExactIn({ amountIn: swapAmount, reserveIn: reserveA, reserveOut: reserveB, fees });
  const bOut = sw.amountOut;
  const resAfterB = reserveB - bOut; // pool B reserve after the swap leg
  let lpTokens = (bOut * lpSupply) / resAfterB; // B-bound LP amount
  lpTokens = lpTokens > 2n ? lpTokens - 2n : lpTokens;
  return {
    swapAmount, expectedB: bOut, lpTokens,
    maxA: amountIn,   // generous cap; deposit takes only the proportional A it needs
    maxB: bOut,       // never more B than the swap produced
    resAfterA: reserveA + swapAmount, resAfterB,
  };
}

/// Spot price of the pool (output units per 1 input unit, ignoring fees/slippage).
export function spotPrice({ reserveIn, reserveOut }) {
  return Number(B(reserveOut)) / Number(B(reserveIn));
}

// ---- fee-tier-aware best-price selection (Phase 3) ----

/// Standard fee-tier convention (Orca/Raydium-class). Each entry is the `fees`
/// struct passed to the on-chain Initialize. `tradeNum/tradeDen` is the LP trade
/// fee; `ownerNum/ownerDen` the owner (protocol) cut. The `bps` field is the
/// human label (total = trade + owner, in basis points). Denominators are
/// always 10_000 so the on-chain `validate` (nonzero denom) passes.
export const FEE_TIERS = [
  { tier: "0.05%", bps: 5, fees: { tradeNum: 5n, tradeDen: 10_000n, ownerNum: 0n, ownerDen: 10_000n } },
  { tier: "0.30%", bps: 30, fees: { tradeNum: 25n, tradeDen: 10_000n, ownerNum: 5n, ownerDen: 10_000n } },
  { tier: "1.00%", bps: 100, fees: { tradeNum: 100n, tradeDen: 10_000n, ownerNum: 0n, ownerDen: 10_000n } },
];

/// Fee-tier-aware best-price selector — a PURE function over pool states.
///
/// `tiers` is an array of `{ tier, reserveIn, reserveOut, fees }` (one per pool
/// of the SAME pair at different fee tiers). For exact-in (`amountIn` set), it
/// quotes each tier and returns the one giving the greatest `amountOut`. For
/// exact-out (`amountOut` set), it returns the one requiring the least
/// `amountIn`. Reserves are per-tier and the caller supplies them already
/// oriented for `dir` (reserveIn = the token being sold).
///
/// Returns `{ best, quotes }` where `quotes` is every tier's quote (with the
/// tier label carried through) and `best` is the winning entry, or `null` if no
/// tier can fill the request. Ties break toward the earlier tier in the array.
export function bestTier({ amountIn, amountOut, tiers }) {
  if (!Array.isArray(tiers) || tiers.length === 0) return { best: null, quotes: [] };
  const exactIn = amountIn != null;
  const quotes = [];
  for (const t of tiers) {
    const fees = t.fees ?? POOL_FEES;
    const q = exactIn
      ? quoteExactIn({ amountIn, reserveIn: t.reserveIn, reserveOut: t.reserveOut, fees })
      : quoteExactOut({ amountOut, reserveIn: t.reserveIn, reserveOut: t.reserveOut, fees });
    // quoteExactOut returns null when the output would drain the reserve.
    quotes.push({ tier: t.tier, swapState: t.swapState, quote: q });
  }
  let best = null;
  for (const c of quotes) {
    if (!c.quote) continue;
    if (best === null) { best = c; continue; }
    if (exactIn) {
      if (c.quote.amountOut > best.quote.amountOut) best = c; // more out wins
    } else {
      if (c.quote.amountIn < best.quote.amountIn) best = c;   // less in wins
    }
  }
  return { best, quotes };
}
