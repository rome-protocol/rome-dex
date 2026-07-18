// rome-dex CLMM off-chain quote — byte-faithful BigInt mirror of the on-chain
// math (clmm/src/curve/{tick_math,liquidity_math,swap_math}.rs + the
// engine::swap walk in clmm/src/engine.rs). Guarded by harness/clmm.test.mjs:
// the quote must equal the realized on-chain output EXACTLY.
//
// Only the exact-in swap path is mirrored (what the app quotes). All rounding
// is pool-favor, matching the program: pay-in ceils, pay-out floors.
//
// Pure BigInt, no dependencies (sdk convention — importable by the harness,
// the app, and any router). Account pubkeys decode as raw 32-byte Buffers.

// ── constants (tick_math.rs) ────────────────────────────────────────────────
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673515399013880257568879n;
const Q64 = 1n << 64n;
const FEE_DENOM = 1_000_000n;

// SQRT_RATIOS[i] = round(sqrt(1.0001)^(2^i) · 2^64) — exact copy of the
// audited constants.
const SQRT_RATIOS = [
  18447666387855959850n, 18448588748116922569n, 18450433606991734259n,
  18454123878217468671n, 18461506635090006683n, 18476281010653910107n,
  18505865242158249966n, 18565175891880433370n, 18684368066214940275n,
  18925053041275764047n, 19415764168677885645n, 20435687552633174797n,
  22639080592224297029n, 27784196929998385068n, 41848122137994941923n,
  94936283578220170147n, 488590176327620415397n, 12941056668319120408908n,
  9078618265828695359366874n, 4468068147272989105925714484762n,
];

export function getSqrtPriceAtTick(tick) {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of bounds: ${tick}`);
  const abs = tick < 0 ? -tick : tick;
  let r = Q64;
  for (let bit = 0; bit < 20; bit++) {
    if ((abs >> bit) & 1) r = (r * SQRT_RATIOS[bit]) >> 64n;
  }
  if (tick < 0) r = (1n << 128n) / r;
  return r;
}

export function getTickAtSqrtPrice(sqrtPrice) {
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
const divFloor = (num, den) => num / den;
const divCeil = (num, den) => (num + den - 1n) / den;

export function getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp) {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (lo === 0n) throw new Error("sqrt price zero");
  if (liquidity === 0n || hi === lo) return 0n;
  const num = (liquidity << 64n) * (hi - lo);
  const den = lo * hi;
  return roundUp ? divCeil(num, den) : divFloor(num, den);
}

export function getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp) {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (liquidity === 0n || hi === lo) return 0n;
  const num = liquidity * (hi - lo);
  return roundUp ? divCeil(num, Q64) : num >> 64n;
}

// ── swap_math.rs ────────────────────────────────────────────────────────────
function nextSqrtPriceFromAmount0In(sqrtPrice, liquidity, amount) {
  if (amount === 0n) return sqrtPrice;
  const num1 = liquidity << 64n;
  const den = num1 + amount * sqrtPrice;
  return divCeil(num1 * sqrtPrice, den);
}

function nextSqrtPriceFromAmount1In(sqrtPrice, liquidity, amount) {
  if (amount === 0n) return sqrtPrice;
  return sqrtPrice + divFloor(amount << 64n, liquidity);
}

function computeSwapStep(sqrtCurrent, sqrtTarget, liquidity, amountRemaining, feePips) {
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

  let amountIn, amountOut;
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

const rdU128 = (b, o) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
const rdI128 = (b, o) => BigInt.asIntN(128, rdU128(b, o));

export function decodePool(data) {
  const b = Buffer.from(data);
  let o = 0;
  const isInitialized = b[o] === 1; o += 1;
  const bump = b[o]; o += 1;
  const mint0 = Buffer.from(b.subarray(o, o + 32)); o += 32;
  const mint1 = Buffer.from(b.subarray(o, o + 32)); o += 32;
  const vault0 = Buffer.from(b.subarray(o, o + 32)); o += 32;
  const vault1 = Buffer.from(b.subarray(o, o + 32)); o += 32;
  const feePips = b.readUInt32LE(o); o += 4;
  const tickSpacing = b.readUInt16LE(o); o += 2;
  const currentTick = b.readInt32LE(o); o += 4;
  const sqrtPrice = rdU128(b, o); o += 16;
  const liquidity = rdU128(b, o); o += 16;
  const feeGrowthGlobal0 = rdU128(b, o); o += 16;
  const feeGrowthGlobal1 = rdU128(b, o); o += 16;
  return {
    isInitialized, bump, mint0, mint1, vault0, vault1,
    feePips, tickSpacing, currentTick, sqrtPrice, liquidity,
    feeGrowthGlobal0, feeGrowthGlobal1,
  };
}

export function decodeTickArray(data) {
  const b = Buffer.from(data);
  const startTickIndex = b.readInt32LE(34); // after is_init(1)+bump(1)+pool(32)
  const ticks = [];
  for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
    const o = TICK_ARRAY_HEADER_LEN + i * TICK_LEN;
    ticks.push({
      liquidityGross: rdU128(b, o),
      liquidityNet: rdI128(b, o + 16),
    });
  }
  return { startTickIndex, ticks };
}

export async function fetchClmmPool(conn, poolPk) {
  const info = await conn.getAccountInfo(poolPk);
  if (!info) throw new Error(`pool ${poolPk} not found`);
  return decodePool(info.data);
}

// ── the swap walk (engine.rs::swap, quote-only — no mutation) ───────────────
const floorDivInt = (a, b) => Math.floor(a / b);

export function tickArrayStartIndex(tick, spacing) {
  const span = TICK_ARRAY_SIZE * spacing;
  return floorDivInt(tick, span) * span;
}

function tickAt(arrays, spacing, tick) {
  const want = tickArrayStartIndex(tick, spacing);
  const arr = arrays.find((a) => a.startTickIndex === want);
  if (!arr) throw new Error(`tick array ${want} not in window`);
  const slot = (tick - want) / spacing;
  return arr.ticks[slot];
}

function nextTarget(arrays, span, spacing, tick, zeroForOne, firstStart) {
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

const clampTick = (t) => Math.max(MIN_TICK, Math.min(MAX_TICK, t));

/**
 * Exact-in quote over a decoded pool + tick-array window (walk order — the
 * array containing the current tick first). Mirrors engine::swap exactly;
 * throws "window exhausted" where the program errors.
 */
export function quoteClmmExactInSync(pool, arrays, zeroForOne, amountIn, sqrtPriceLimit = 0n) {
  const limit = sqrtPriceLimit !== 0n ? sqrtPriceLimit : zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
  if (amountIn <= 0n) throw new Error("zero amount");
  const validLimit = zeroForOne
    ? limit >= MIN_SQRT_PRICE && limit < pool.sqrtPrice
    : limit > pool.sqrtPrice && limit <= MAX_SQRT_PRICE;
  if (!validLimit) throw new Error("bad sqrt price limit");

  const spacing = pool.tickSpacing;
  const span = TICK_ARRAY_SIZE * spacing;
  const firstStart = arrays[0].startTickIndex;
  if (firstStart !== tickArrayStartIndex(pool.currentTick, spacing))
    throw new Error("arrays[0] must contain the current tick");

  let sqrtPrice = pool.sqrtPrice;
  let tick = pool.currentTick;
  let liquidity = pool.liquidity;
  let remaining = amountIn;
  let totalIn = 0n, totalOut = 0n, totalFee = 0n;

  while (remaining > 0n && sqrtPrice !== limit) {
    const [nextTick, initialized] = nextTarget(arrays, span, spacing, tick, zeroForOne, firstStart);
    const targetSqrt = getSqrtPriceAtTick(clampTick(nextTick));
    const clamped = zeroForOne
      ? (targetSqrt > limit ? targetSqrt : limit)
      : (targetSqrt < limit ? targetSqrt : limit);

    if (liquidity === 0n) {
      sqrtPrice = clamped;
    } else {
      const step = computeSwapStep(sqrtPrice, clamped, liquidity, remaining, pool.feePips);
      remaining -= step.amountIn + step.feeAmount;
      totalIn += step.amountIn;
      totalOut += step.amountOut;
      totalFee += step.feeAmount;
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

/** Convenience: fetch pool + arrays from chain, then quote. */
export async function quoteClmmExactIn(conn, poolPk, tickArrayPks, zeroForOne, amountIn, sqrtPriceLimit = 0n) {
  const pool = await fetchClmmPool(conn, poolPk);
  const infos = await conn.getMultipleAccountsInfo(tickArrayPks);
  const arrays = infos.map((info, i) => {
    if (!info) throw new Error(`tick array ${tickArrayPks[i]} not found`);
    return decodeTickArray(info.data);
  });
  return quoteClmmExactInSync(pool, arrays, zeroForOne, amountIn, sqrtPriceLimit);
}
