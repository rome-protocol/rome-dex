// TypeScript mirror of sdk/clmm-quote.mjs — byte-faithful to the on-chain CLMM
// math (clmm/src/curve/{tick_math,liquidity_math,swap_math}.rs + engine::swap).
// Both this file and the .mjs original MUST stay in sync with the program.
// Pure BigInt, no deps. Adds price↔tick UI helpers (the range picker shows
// PRICES, never ticks — experience-not-engineering).

// ── constants (tick_math.rs) ────────────────────────────────────────────────
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673515399013880257568879n;
const Q64 = 1n << 64n;
const FEE_DENOM = 1_000_000n;

const SQRT_RATIOS: bigint[] = [
  18447666387855959850n, 18448588748116922569n, 18450433606991734259n,
  18454123878217468671n, 18461506635090006683n, 18476281010653910107n,
  18505865242158249966n, 18565175891880433370n, 18684368066214940275n,
  18925053041275764047n, 19415764168677885645n, 20435687552633174797n,
  22639080592224297029n, 27784196929998385068n, 41848122137994941923n,
  94936283578220170147n, 488590176327620415397n, 12941056668319120408908n,
  9078618265828695359366874n, 4468068147272989105925714484762n,
];

export function getSqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of bounds: ${tick}`);
  const abs = tick < 0 ? -tick : tick;
  let r = Q64;
  for (let bit = 0; bit < 20; bit++) {
    if ((abs >> bit) & 1) r = (r * SQRT_RATIOS[bit]) >> 64n;
  }
  if (tick < 0) r = (1n << 128n) / r;
  return r;
}

export function getTickAtSqrtPrice(sqrtPrice: bigint): number {
  if (sqrtPrice < MIN_SQRT_PRICE || sqrtPrice > MAX_SQRT_PRICE)
    throw new Error("sqrt price out of bounds");
  let lo = MIN_TICK, hi = MAX_TICK;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo + 1) / 2);
    if (getSqrtPriceAtTick(mid) <= sqrtPrice) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ── liquidity_math.rs ───────────────────────────────────────────────────────
const divFloor = (num: bigint, den: bigint): bigint => num / den;
const divCeil = (num: bigint, den: bigint): bigint => (num + den - 1n) / den;

export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (lo === 0n) throw new Error("sqrt price zero");
  if (liquidity === 0n || hi === lo) return 0n;
  const num = (liquidity << 64n) * (hi - lo);
  const den = lo * hi;
  return roundUp ? divCeil(num, den) : divFloor(num, den);
}

export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (liquidity === 0n || hi === lo) return 0n;
  const num = liquidity * (hi - lo);
  return roundUp ? divCeil(num, Q64) : num >> 64n;
}

// ── swap_math.rs ────────────────────────────────────────────────────────────
function nextSqrtPriceFromAmount0In(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtPrice;
  const num1 = liquidity << 64n;
  const den = num1 + amount * sqrtPrice;
  return divCeil(num1 * sqrtPrice, den);
}

function nextSqrtPriceFromAmount1In(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtPrice;
  return sqrtPrice + divFloor(amount << 64n, liquidity);
}

interface SwapStep { sqrtNext: bigint; amountIn: bigint; amountOut: bigint; feeAmount: bigint; }

function computeSwapStep(sqrtCurrent: bigint, sqrtTarget: bigint, liquidity: bigint, amountRemaining: bigint, feePips: number): SwapStep {
  const zeroForOne = sqrtCurrent >= sqrtTarget;
  const fee = BigInt(feePips);
  const amountLessFee = divFloor(amountRemaining * (FEE_DENOM - fee), FEE_DENOM);
  const amountInToTarget = zeroForOne
    ? getAmount0Delta(sqrtTarget, sqrtCurrent, liquidity, true)
    : getAmount1Delta(sqrtCurrent, sqrtTarget, liquidity, true);
  const reached = amountLessFee >= amountInToTarget;
  const sqrtNext = reached
    ? sqrtTarget
    : zeroForOne
      ? nextSqrtPriceFromAmount0In(sqrtCurrent, liquidity, amountLessFee)
      : nextSqrtPriceFromAmount1In(sqrtCurrent, liquidity, amountLessFee);
  let amountIn: bigint, amountOut: bigint;
  if (zeroForOne) {
    amountIn = reached ? amountInToTarget : getAmount0Delta(sqrtNext, sqrtCurrent, liquidity, true);
    amountOut = getAmount1Delta(sqrtNext, sqrtCurrent, liquidity, false);
  } else {
    amountIn = reached ? amountInToTarget : getAmount1Delta(sqrtCurrent, sqrtNext, liquidity, true);
    amountOut = getAmount0Delta(sqrtCurrent, sqrtNext, liquidity, false);
  }
  const feeAmount = !reached ? amountRemaining - amountIn : divCeil(amountIn * fee, FEE_DENOM - fee);
  return { sqrtNext, amountIn, amountOut, feeAmount };
}

// ── account decoding (state.rs layouts) ─────────────────────────────────────
export const TICK_ARRAY_SIZE = 88;
const TICK_LEN = 64;
const TICK_ARRAY_HEADER_LEN = 38;

const rdU128 = (b: Buffer, o: number): bigint => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
const rdI128 = (b: Buffer, o: number): bigint => BigInt.asIntN(128, rdU128(b, o));

export interface ClmmPool {
  isInitialized: boolean;
  bump: number;
  feePips: number;
  tickSpacing: number;
  currentTick: number;
  sqrtPrice: bigint;
  liquidity: bigint;
  feeGrowthGlobal0: bigint;
  feeGrowthGlobal1: bigint;
}

export function decodePool(data: Buffer | Uint8Array): ClmmPool {
  const b = Buffer.from(data);
  let o = 0;
  const isInitialized = b[o] === 1; o += 1;
  const bump = b[o]; o += 1;
  o += 32 * 4; // mint0, mint1, vault0, vault1 (not needed for quoting)
  const feePips = b.readUInt32LE(o); o += 4;
  const tickSpacing = b.readUInt16LE(o); o += 2;
  const currentTick = b.readInt32LE(o); o += 4;
  const sqrtPrice = rdU128(b, o); o += 16;
  const liquidity = rdU128(b, o); o += 16;
  const feeGrowthGlobal0 = rdU128(b, o); o += 16;
  const feeGrowthGlobal1 = rdU128(b, o); o += 16;
  return { isInitialized, bump, feePips, tickSpacing, currentTick, sqrtPrice, liquidity, feeGrowthGlobal0, feeGrowthGlobal1 };
}

export interface ClmmPosition {
  isInitialized: boolean;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

/** Decode a Position account (state.rs POSITION_LEN=138 layout). */
export function decodePosition(data: Buffer | Uint8Array): ClmmPosition {
  const b = Buffer.from(data);
  let o = 0;
  const isInitialized = b[o] === 1; o += 1;
  o += 1;          // bump
  o += 32 + 32;    // pool, owner
  const tickLower = b.readInt32LE(o); o += 4;
  const tickUpper = b.readInt32LE(o); o += 4;
  const liquidity = rdU128(b, o); o += 16;
  o += 16 + 16;    // fee_growth_inside_{0,1}_last
  const tokensOwed0 = b.readBigUInt64LE(o); o += 8;
  const tokensOwed1 = b.readBigUInt64LE(o); o += 8;
  return { isInitialized, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1 };
}

export interface TickArrayView { startTickIndex: number; ticks: { liquidityGross: bigint; liquidityNet: bigint }[]; }

export function decodeTickArray(data: Buffer | Uint8Array): TickArrayView {
  const b = Buffer.from(data);
  const startTickIndex = b.readInt32LE(34);
  const ticks = [];
  for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
    const o = TICK_ARRAY_HEADER_LEN + i * TICK_LEN;
    ticks.push({ liquidityGross: rdU128(b, o), liquidityNet: rdI128(b, o + 16) });
  }
  return { startTickIndex, ticks };
}

// ── the swap walk (engine.rs::swap, quote-only) ─────────────────────────────
const floorDivInt = (a: number, b: number): number => Math.floor(a / b);

export function tickArrayStartIndex(tick: number, spacing: number): number {
  const span = TICK_ARRAY_SIZE * spacing;
  return floorDivInt(tick, span) * span;
}

function tickAt(arrays: TickArrayView[], spacing: number, tick: number) {
  const want = tickArrayStartIndex(tick, spacing);
  const arr = arrays.find((a) => a.startTickIndex === want);
  if (!arr) throw new Error(`tick array ${want} not in window`);
  return arr.ticks[(tick - want) / spacing];
}

function nextTarget(arrays: TickArrayView[], span: number, spacing: number, tick: number, zeroForOne: boolean, firstStart: number): [number, boolean] {
  if (zeroForOne) {
    let cand = floorDivInt(tick, spacing) * spacing;
    const windowLo = firstStart - (arrays.length - 1) * span;
    if (cand < windowLo) throw new Error("window exhausted");
    while (cand >= windowLo) {
      if (tickAt(arrays, spacing, cand).liquidityGross !== 0n) return [cand, true];
      if (cand === windowLo) return [cand, false];
      cand -= spacing;
    }
    throw new Error("unreachable");
  }
  let cand = floorDivInt(tick, spacing) * spacing + spacing;
  const last = arrays[arrays.length - 1].startTickIndex;
  const windowHi = last + span;
  if (cand > windowHi) throw new Error("window exhausted");
  while (cand < windowHi) {
    if (tickAt(arrays, spacing, cand).liquidityGross !== 0n) return [cand, true];
    cand += spacing;
  }
  return [windowHi, false];
}

const clampTick = (t: number): number => Math.max(MIN_TICK, Math.min(MAX_TICK, t));

export interface ClmmQuote { amountIn: bigint; fee: bigint; amountOut: bigint; sqrtPriceAfter: bigint; tickAfter: number; }

export function quoteClmmExactInSync(pool: ClmmPool, arrays: TickArrayView[], zeroForOne: boolean, amountIn: bigint, sqrtPriceLimit = 0n): ClmmQuote {
  const limit = sqrtPriceLimit !== 0n ? sqrtPriceLimit : zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
  if (amountIn <= 0n) throw new Error("zero amount");
  const validLimit = zeroForOne
    ? limit >= MIN_SQRT_PRICE && limit < pool.sqrtPrice
    : limit > pool.sqrtPrice && limit <= MAX_SQRT_PRICE;
  if (!validLimit) throw new Error("bad sqrt price limit");

  const spacing = pool.tickSpacing;
  const span = TICK_ARRAY_SIZE * spacing;
  const firstStart = arrays[0].startTickIndex;
  if (firstStart !== tickArrayStartIndex(pool.currentTick, spacing)) throw new Error("arrays[0] must contain the current tick");

  let sqrtPrice = pool.sqrtPrice;
  let tick = pool.currentTick;
  let liquidity = pool.liquidity;
  let remaining = amountIn;
  let totalIn = 0n, totalOut = 0n, totalFee = 0n;

  while (remaining > 0n && sqrtPrice !== limit) {
    const [nextTick, initialized] = nextTarget(arrays, span, spacing, tick, zeroForOne, firstStart);
    const targetSqrt = getSqrtPriceAtTick(clampTick(nextTick));
    const clamped = zeroForOne ? (targetSqrt > limit ? targetSqrt : limit) : (targetSqrt < limit ? targetSqrt : limit);

    if (liquidity === 0n) {
      sqrtPrice = clamped;
    } else {
      const step = computeSwapStep(sqrtPrice, clamped, liquidity, remaining, pool.feePips);
      remaining -= step.amountIn + step.feeAmount;
      totalIn += step.amountIn; totalOut += step.amountOut; totalFee += step.feeAmount;
      sqrtPrice = step.sqrtNext;
    }
    if (sqrtPrice === targetSqrt) {
      if (initialized) {
        const net = tickAt(arrays, spacing, nextTick).liquidityNet;
        liquidity += zeroForOne ? -net : net;
        if (liquidity < 0n) throw new Error("negative liquidity");
      }
      tick = zeroForOne ? nextTick - 1 : nextTick;
    } else if (sqrtPrice !== pool.sqrtPrice) {
      tick = getTickAtSqrtPrice(sqrtPrice);
    }
  }
  return { amountIn: totalIn, fee: totalFee, amountOut: totalOut, sqrtPriceAfter: sqrtPrice, tickAfter: tick };
}

// ── price ↔ tick UI helpers (show PRICES, never ticks) ──────────────────────
// price = token1/token0 = (sqrtPrice / 2^64)^2. Both proof mints are 6dp, so
// the raw ratio is the human ratio; callers pass a decimal adjustment if not.

/** A Q64.64 sqrt-price → a float price (token1 per token0). */
export function sqrtPriceToPrice(sqrtPrice: bigint, decimals0 = 0, decimals1 = 0): number {
  const s = Number(sqrtPrice) / Number(Q64);
  return s * s * 10 ** (decimals0 - decimals1);
}

/** A tick → its float price. */
export function tickToPrice(tick: number, decimals0 = 0, decimals1 = 0): number {
  return sqrtPriceToPrice(getSqrtPriceAtTick(clampTick(tick)), decimals0, decimals1);
}

/** A float price → the nearest spacing-aligned tick (rounds to the grid). */
export function priceToTick(price: number, spacing: number, decimals0 = 0, decimals1 = 0): number {
  if (price <= 0) return MIN_TICK;
  const raw = Math.log(price * 10 ** (decimals1 - decimals0)) / Math.log(1.0001);
  const aligned = Math.round(raw / spacing) * spacing;
  return Math.max(MIN_TICK, Math.min(MAX_TICK, aligned));
}

// ── liquidity ↔ amounts (add-liquidity UI) ──────────────────────────────────
// getAmountsForLiquidity mirrors the program's `amounts_for_liquidity`
// (engine.rs) EXACTLY — built on the same guarded getAmount{0,1}Delta — so the
// deposit preview equals what the pool will pull. `roundUp=true` for pay-in.

/** Token (amount0, amount1) to provide `liquidity` over `[tickLower, tickUpper]`
 *  at the pool's `currentTick`/`sqrtPrice`. Pool-favor rounding when roundUp. */
export function getAmountsForLiquidity(
  sqrtPrice: bigint, currentTick: number, tickLower: number, tickUpper: number, liquidity: bigint, roundUp: boolean,
): [bigint, bigint] {
  const sqrtLower = getSqrtPriceAtTick(tickLower);
  const sqrtUpper = getSqrtPriceAtTick(tickUpper);
  if (currentTick < tickLower) {
    return [getAmount0Delta(sqrtLower, sqrtUpper, liquidity, roundUp), 0n];
  } else if (currentTick < tickUpper) {
    return [
      getAmount0Delta(sqrtPrice, sqrtUpper, liquidity, roundUp),
      getAmount1Delta(sqrtLower, sqrtPrice, liquidity, roundUp),
    ];
  }
  return [0n, getAmount1Delta(sqrtLower, sqrtUpper, liquidity, roundUp)];
}

/** Largest `liquidity` an (amount0, amount1) budget supports over the band at
 *  the current price — the UI turns a token budget into an L to request. The
 *  program re-derives exact amounts from L (bounded by the caller's max), so
 *  minor rounding here is always safe. */
export function getLiquidityForAmounts(
  sqrtPrice: bigint, currentTick: number, tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint,
): bigint {
  const sqrtLower = getSqrtPriceAtTick(tickLower);
  const sqrtUpper = getSqrtPriceAtTick(tickUpper);
  // L from amount0 over [a,b]: L = amount0 · a·b / ((b−a)·2^64) — full precision.
  const l0 = (sa: bigint, sb: bigint): bigint => (sa >= sb ? 0n : (amount0 * sa * sb) / ((sb - sa) << 64n));
  // L from amount1 over [a,b]: L = amount1 · 2^64 / (b−a)
  const l1 = (sa: bigint, sb: bigint): bigint => (sa >= sb ? 0n : (amount1 << 64n) / (sb - sa));
  if (currentTick < tickLower) return l0(sqrtLower, sqrtUpper);
  if (currentTick >= tickUpper) return l1(sqrtLower, sqrtUpper);
  const a = l0(sqrtPrice, sqrtUpper);
  const b = l1(sqrtLower, sqrtPrice);
  return a < b ? a : b;
}
