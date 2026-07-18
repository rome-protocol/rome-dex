//! Token-amount deltas for a liquidity range, and signed-liquidity application.
//!
//! For a range `[sqrt_a, sqrt_b]` (Q64.64, `sqrt_a <= sqrt_b`) holding liquidity
//! `L` (`price = token1/token0`, so token0 is base, token1 is quote), the token1
//! amount is `L · (sqrt_b − sqrt_a) / 2^64` and the token0 amount is
//! `L · 2^64 · (sqrt_b − sqrt_a) / (sqrt_a · sqrt_b)`. `round_up` selects ceil
//! (amount the trader/LP must PAY IN — pool-favor) vs floor (amount the pool
//! pays OUT — pool-favor).

use {
    super::{mul_shift_q64, u512_div_ceil, u512_div_floor, Q64, U512},
    crate::error::ClmmError,
};

/// `amount0` for `[sqrt_a, sqrt_b]` at liquidity `L`. Order-insensitive in the
/// bounds. `round_up=true` → ceil (pay-in), else floor (pay-out).
pub fn get_amount_0_delta(
    sqrt_a: u128,
    sqrt_b: u128,
    liquidity: u128,
    round_up: bool,
) -> Result<u128, ClmmError> {
    let (lo, hi) = if sqrt_a <= sqrt_b { (sqrt_a, sqrt_b) } else { (sqrt_b, sqrt_a) };
    if lo == 0 {
        return Err(ClmmError::SqrtPriceOutOfBounds);
    }
    if liquidity == 0 || hi == lo {
        return Ok(0);
    }
    // num = (L << 64) · (hi − lo) ; denom = lo · hi   (up to ~320 / ~256 bits).
    let num = (U512::from(liquidity) << 64) * U512::from(hi - lo);
    let denom = U512::from(lo) * U512::from(hi);
    if round_up {
        u512_div_ceil(num, denom)
    } else {
        u512_div_floor(num, denom)
    }
}

/// `amount1` for `[sqrt_a, sqrt_b]` at liquidity `L`. Order-insensitive.
/// `round_up=true` → ceil (pay-in), else floor (pay-out).
pub fn get_amount_1_delta(
    sqrt_a: u128,
    sqrt_b: u128,
    liquidity: u128,
    round_up: bool,
) -> Result<u128, ClmmError> {
    let (lo, hi) = if sqrt_a <= sqrt_b { (sqrt_a, sqrt_b) } else { (sqrt_b, sqrt_a) };
    if liquidity == 0 || hi == lo {
        return Ok(0);
    }
    // L · (hi − lo) / 2^64
    if round_up {
        let num = U512::from(liquidity) * U512::from(hi - lo);
        let denom = U512::from(Q64);
        u512_div_ceil(num, denom)
    } else {
        mul_shift_q64(liquidity, hi - lo)
    }
}

/// Apply a signed liquidity delta to a `u128` liquidity total (checked).
pub fn add_liquidity_delta(liquidity: u128, delta: i128) -> Result<u128, ClmmError> {
    if delta >= 0 {
        liquidity.checked_add(delta as u128).ok_or(ClmmError::MathOverflow)
    } else {
        liquidity
            .checked_sub(delta.unsigned_abs())
            .ok_or(ClmmError::MathOverflow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::curve::tick_math::get_sqrt_price_at_tick;

    // At tick 0 (sqrt = 2^64), a full-width delta over exactly one Q64 unit of
    // sqrt-price with L = 2^64 yields amount1 = (2^64 · Δ)/2^64 = Δ.
    #[test]
    fn amount1_basic() {
        let l = Q64; // liquidity 2^64
        let a = Q64;
        let b = Q64 + 1000; // Δsqrt = 1000
        // amount1 = L·Δ/2^64 = 2^64·1000/2^64 = 1000.
        assert_eq!(get_amount_1_delta(a, b, l, false).unwrap(), 1000);
        assert_eq!(get_amount_1_delta(a, b, l, true).unwrap(), 1000);
    }

    #[test]
    fn amount1_rounding_is_pool_favor() {
        let l = 3; // tiny → forces a fractional result
        let a = Q64;
        let b = Q64 + 1; // Δ = 1; amount1 = 3·1/2^64 = 0.00…
        assert_eq!(get_amount_1_delta(a, b, l, false).unwrap(), 0, "floor pays out 0");
        assert_eq!(get_amount_1_delta(a, b, l, true).unwrap(), 1, "ceil charges 1");
    }

    #[test]
    fn amount0_symmetry_and_rounding() {
        // amount0 = L·2^64·Δ/(a·b). With a=2^64,b=2^64+X, L=2^64:
        // = 2^64·2^64·X / (2^64·(2^64+X)) = 2^64·X/(2^64+X) ≈ X for small X.
        let l = Q64;
        let a = Q64;
        let x = 1_000_000u128;
        let b = Q64 + x;
        let down = get_amount_0_delta(a, b, l, false).unwrap();
        let up = get_amount_0_delta(a, b, l, true).unwrap();
        assert!(up >= down, "ceil >= floor");
        assert!(up - down <= 1, "ceil and floor differ by <= 1");
        // ≈ 2^64·X/(2^64+X): slightly below X.
        assert!(down <= x && down > x - 2, "amount0 ≈ X for small X (got {down})");
    }

    #[test]
    fn zero_liquidity_and_equal_bounds() {
        assert_eq!(get_amount_0_delta(Q64, Q64 + 5, 0, true).unwrap(), 0);
        assert_eq!(get_amount_1_delta(Q64, Q64 + 5, 0, true).unwrap(), 0);
        assert_eq!(get_amount_0_delta(Q64, Q64, 100, true).unwrap(), 0);
        assert_eq!(get_amount_1_delta(Q64, Q64, 100, true).unwrap(), 0);
    }

    #[test]
    fn bounds_order_insensitive() {
        let (a, b, l) = (get_sqrt_price_at_tick(-500).unwrap(), get_sqrt_price_at_tick(500).unwrap(), 1_000_000_000u128);
        assert_eq!(get_amount_0_delta(a, b, l, true), get_amount_0_delta(b, a, l, true));
        assert_eq!(get_amount_1_delta(a, b, l, false), get_amount_1_delta(b, a, l, false));
    }

    #[test]
    fn add_delta_checked() {
        assert_eq!(add_liquidity_delta(100, 50).unwrap(), 150);
        assert_eq!(add_liquidity_delta(100, -40).unwrap(), 60);
        assert_eq!(add_liquidity_delta(100, -101), Err(ClmmError::MathOverflow));
        assert_eq!(add_liquidity_delta(u128::MAX, 1), Err(ClmmError::MathOverflow));
    }
}
