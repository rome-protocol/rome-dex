//! Fee-growth accounting (Uniswap-V3 style), Q64.64 per unit of liquidity.
//!
//! `fee_growth_global` accumulates fees-per-liquidity over all time. A tick
//! stores `fee_growth_outside` (the growth on the far side of that tick from the
//! current price); `fee_growth_inside` for a range is
//! `global − below − above`, computed with WRAPPING subtraction — the values are
//! deltas that legitimately wrap `u128`, so the wrapping cancels out and the
//! inside-growth is correct as long as it's read as a wrapped delta. A position
//! owes `liquidity · (inside_now − inside_last) / 2^64`.

use {super::mul_div_floor, crate::error::ClmmError};

/// Fee-per-liquidity delta (Q64.64) from a collected `fee_amount` over
/// `liquidity`. Rounds DOWN — dust stays with the pool, never over-credits.
pub fn fee_growth_delta(fee_amount: u128, liquidity: u128) -> Result<u128, ClmmError> {
    if liquidity == 0 {
        return Err(ClmmError::ZeroLiquidity);
    }
    mul_div_floor(fee_amount, 1u128 << 64, liquidity)
}

/// `fee_growth_inside` for `[tick_lower, tick_upper]` at `tick_current`.
/// Wrapping arithmetic is intentional (see module docs).
#[allow(clippy::too_many_arguments)]
pub fn fee_growth_inside(
    tick_lower: i32,
    tick_upper: i32,
    tick_current: i32,
    fee_growth_global: u128,
    lower_fee_growth_outside: u128,
    upper_fee_growth_outside: u128,
) -> u128 {
    let below = if tick_current >= tick_lower {
        lower_fee_growth_outside
    } else {
        fee_growth_global.wrapping_sub(lower_fee_growth_outside)
    };
    let above = if tick_current < tick_upper {
        upper_fee_growth_outside
    } else {
        fee_growth_global.wrapping_sub(upper_fee_growth_outside)
    };
    fee_growth_global.wrapping_sub(below).wrapping_sub(above)
}

/// Tokens owed to a position from a fee-growth-inside delta (wrapping) since its
/// last checkpoint: `liquidity · Δinside / 2^64` (round down).
pub fn fees_owed(
    liquidity: u128,
    fee_growth_inside_now: u128,
    fee_growth_inside_last: u128,
) -> Result<u128, ClmmError> {
    let delta = fee_growth_inside_now.wrapping_sub(fee_growth_inside_last);
    mul_div_floor(liquidity, delta, 1u128 << 64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q64: u128 = 1u128 << 64;

    #[test]
    fn delta_rounds_down() {
        // 3 fee over liquidity 2 → 1.5 per-liq in Q64.64 = 1.5·2^64, floor ok.
        assert_eq!(fee_growth_delta(1, 2).unwrap(), Q64 / 2);
        // dust: fee 1 over huge liquidity → 0 (pool keeps it), never over-credit.
        assert_eq!(fee_growth_delta(1, u128::MAX).unwrap(), 0);
    }

    #[test]
    fn inside_when_price_within_range() {
        // current in [lower,upper]; nothing accrued outside yet → inside == global.
        let g = 500 * Q64;
        assert_eq!(fee_growth_inside(-100, 100, 0, g, 0, 0), g);
    }

    #[test]
    fn inside_excludes_outside_growth() {
        let g = 1000 * Q64;
        // 300 accrued below the range's lower tick, 200 above the upper.
        let below_outside = 300 * Q64; // current >= lower → below = lower_outside
        let above_outside = 200 * Q64; // current < upper → above = upper_outside
        let inside = fee_growth_inside(-100, 100, 0, g, below_outside, above_outside);
        assert_eq!(inside, 500 * Q64, "inside = global - below - above");
    }

    #[test]
    fn inside_wraps_when_price_below_range() {
        // current below the range: below = global - lower_outside (wrapping).
        let g = 1000 * Q64;
        let lower_outside = 100 * Q64;
        let upper_outside = 100 * Q64;
        // current (-200) < lower (-100): below = g - lower_outside; current < upper: above = upper_outside.
        let inside = fee_growth_inside(-100, 100, -200, g, lower_outside, upper_outside);
        // below = 900, above = 100 → inside = 1000 - 900 - 100 = 0 (price outside range earns nothing).
        assert_eq!(inside, 0);
    }

    #[test]
    fn owed_scales_with_liquidity_and_delta() {
        // Δinside = 2.0 per-liq (2·2^64), liquidity 50 → owed 100.
        assert_eq!(fees_owed(50, 2 * Q64, 0).unwrap(), 100);
    }

    #[test]
    fn owed_handles_wrapped_delta() {
        // now wrapped below last (global counter wrapped) — wrapping_sub recovers
        // the true positive delta.
        let last = u128::MAX - Q64 + 1; // = -(1) in wrapped terms relative to 0
        let now = Q64; // delta = now - last (wrapping) = 2·Q64
        assert_eq!(fees_owed(10, now, last).unwrap(), 20);
    }
}
