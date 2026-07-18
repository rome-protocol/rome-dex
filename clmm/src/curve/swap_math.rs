//! Single-tick swap step (exact-in) and the sqrt-price moves it rests on.
//!
//! Mirrors Uniswap V3 `SwapMath.computeSwapStep` for the exact-input case, in
//! Q64.64. All rounding favors the pool: input (pay-in) rounds UP, output
//! (pay-out) rounds DOWN, and `next_sqrt_price` rounds so the pool never gives
//! away price.

use {
    super::{
        liquidity_math::{get_amount_0_delta, get_amount_1_delta},
        mul_div_ceil, mul_div_floor, u512_div_ceil, U512, FEE_DENOM,
    },
    crate::error::ClmmError,
};

/// New sqrt-price after adding `amount` of token0 (price falls): rounds UP so
/// the pool keeps the better price. `next < sqrt_price`.
pub fn next_sqrt_price_from_amount_0_in(
    sqrt_price: u128,
    liquidity: u128,
    amount: u128,
) -> Result<u128, ClmmError> {
    if amount == 0 {
        return Ok(sqrt_price);
    }
    if liquidity == 0 {
        return Err(ClmmError::ZeroLiquidity);
    }
    // next = ceil( (L<<64)·sqrt / ((L<<64) + amount·sqrt) )
    let numerator1 = U512::from(liquidity) << 64;
    let denom = numerator1 + U512::from(amount) * U512::from(sqrt_price);
    let num = numerator1 * U512::from(sqrt_price);
    u512_div_ceil(num, denom)
}

/// New sqrt-price after adding `amount` of token1 (price rises): rounds DOWN so
/// the pool keeps the better price. `next > sqrt_price`.
pub fn next_sqrt_price_from_amount_1_in(
    sqrt_price: u128,
    liquidity: u128,
    amount: u128,
) -> Result<u128, ClmmError> {
    if amount == 0 {
        return Ok(sqrt_price);
    }
    if liquidity == 0 {
        return Err(ClmmError::ZeroLiquidity);
    }
    // next = sqrt + floor(amount·2^64 / L)
    let quotient = mul_div_floor(amount, 1u128 << 64, liquidity)?;
    sqrt_price.checked_add(quotient).ok_or(ClmmError::MathOverflow)
}

/// Result of one swap step within a single tick's liquidity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapStep {
    /// sqrt-price after the step.
    pub sqrt_price_next: u128,
    /// Input consumed (excludes fee).
    pub amount_in: u128,
    /// Output produced.
    pub amount_out: u128,
    /// Fee taken (input token).
    pub fee_amount: u128,
}

/// Exact-in swap step from `sqrt_current` toward `sqrt_target` over `liquidity`,
/// consuming at most `amount_remaining` input, charging `fee_pips` (1e-6). The
/// direction is inferred: `sqrt_current >= sqrt_target` ⇒ token0-in (price down).
pub fn compute_swap_step(
    sqrt_current: u128,
    sqrt_target: u128,
    liquidity: u128,
    amount_remaining: u128,
    fee_pips: u32,
) -> Result<SwapStep, ClmmError> {
    let zero_for_one = sqrt_current >= sqrt_target;
    let fee = fee_pips as u128;
    if fee >= FEE_DENOM {
        return Err(ClmmError::MathOverflow);
    }

    // Amount available after fee, and the input needed to reach the target.
    let amount_less_fee = mul_div_floor(amount_remaining, FEE_DENOM - fee, FEE_DENOM)?;
    let amount_in_to_target = if zero_for_one {
        get_amount_0_delta(sqrt_target, sqrt_current, liquidity, true)?
    } else {
        get_amount_1_delta(sqrt_current, sqrt_target, liquidity, true)?
    };

    let reached_target = amount_less_fee >= amount_in_to_target;
    let sqrt_price_next = if reached_target {
        sqrt_target
    } else if zero_for_one {
        next_sqrt_price_from_amount_0_in(sqrt_current, liquidity, amount_less_fee)?
    } else {
        next_sqrt_price_from_amount_1_in(sqrt_current, liquidity, amount_less_fee)?
    };

    // amount_in (pay-in, round up) + amount_out (pay-out, round down) at next.
    let (amount_in, amount_out) = if zero_for_one {
        let ain = if reached_target {
            amount_in_to_target
        } else {
            get_amount_0_delta(sqrt_price_next, sqrt_current, liquidity, true)?
        };
        let aout = get_amount_1_delta(sqrt_price_next, sqrt_current, liquidity, false)?;
        (ain, aout)
    } else {
        let ain = if reached_target {
            amount_in_to_target
        } else {
            get_amount_1_delta(sqrt_current, sqrt_price_next, liquidity, true)?
        };
        let aout = get_amount_0_delta(sqrt_current, sqrt_price_next, liquidity, false)?;
        (ain, aout)
    };

    // Fee: if we stopped short of target, the fee is everything left after
    // amount_in (consume all remaining); otherwise it's the pro-rata fee on
    // amount_in, rounded up.
    let fee_amount = if !reached_target {
        amount_remaining.checked_sub(amount_in).ok_or(ClmmError::MathOverflow)?
    } else {
        mul_div_ceil(amount_in, fee, FEE_DENOM - fee)?
    };

    Ok(SwapStep { sqrt_price_next, amount_in, amount_out, fee_amount })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::curve::{tick_math::get_sqrt_price_at_tick, Q64};

    #[test]
    fn next_price_from_0_in_falls() {
        let n = next_sqrt_price_from_amount_0_in(Q64, Q64, 1000).unwrap();
        assert!(n < Q64, "adding token0 lowers price");
    }

    #[test]
    fn next_price_from_1_in_rises() {
        let n = next_sqrt_price_from_amount_1_in(Q64, Q64, 1000).unwrap();
        assert!(n > Q64, "adding token1 raises price");
    }

    #[test]
    fn next_price_zero_amount_is_noop() {
        assert_eq!(next_sqrt_price_from_amount_0_in(Q64, Q64, 0).unwrap(), Q64);
        assert_eq!(next_sqrt_price_from_amount_1_in(Q64, Q64, 0).unwrap(), Q64);
    }

    #[test]
    fn step_reaches_target_when_input_ample() {
        // one_for_zero: current below target, plenty of token1 in.
        let cur = get_sqrt_price_at_tick(0).unwrap();
        let tgt = get_sqrt_price_at_tick(120).unwrap();
        let l = 1_000_000_000_000u128;
        let s = compute_swap_step(cur, tgt, l, u64::MAX as u128, 3000).unwrap();
        assert_eq!(s.sqrt_price_next, tgt, "ample input crosses to target");
        assert!(s.amount_in > 0 && s.amount_out > 0);
        // fee is the pro-rata fee on amount_in at 0.30%.
        assert!(s.fee_amount > 0);
    }

    #[test]
    fn step_partial_consumes_all_remaining() {
        // Small input that can't reach the target: stops short, in+fee == remaining.
        let cur = get_sqrt_price_at_tick(0).unwrap();
        let tgt = get_sqrt_price_at_tick(10000).unwrap();
        let l = 1_000_000_000_000u128;
        let remaining = 1_000_000u128;
        let s = compute_swap_step(cur, tgt, l, remaining, 3000).unwrap();
        assert!(s.sqrt_price_next > cur && s.sqrt_price_next < tgt, "stops short of target");
        assert_eq!(s.amount_in + s.fee_amount, remaining, "partial step consumes all input");
        assert!(s.amount_out > 0);
    }

    #[test]
    fn step_never_returns_more_out_than_reserves_allow() {
        // amount_out (round-down) must not exceed the exact amount1 over the move.
        let cur = get_sqrt_price_at_tick(0).unwrap();
        let tgt = get_sqrt_price_at_tick(60).unwrap();
        let l = 5_000_000_000u128;
        let s = compute_swap_step(cur, tgt, l, u64::MAX as u128, 500).unwrap();
        let exact_out = get_amount_1_delta(cur, s.sqrt_price_next, l, false).unwrap();
        assert!(s.amount_out <= exact_out, "pool never over-pays output");
    }

    #[test]
    fn zero_for_one_direction_detected() {
        let hi = get_sqrt_price_at_tick(100).unwrap();
        let lo = get_sqrt_price_at_tick(-100).unwrap();
        // current above target → token0 in → price falls toward target.
        let s = compute_swap_step(hi, lo, 1_000_000_000u128, u64::MAX as u128, 3000).unwrap();
        assert_eq!(s.sqrt_price_next, lo);
        assert!(s.sqrt_price_next < hi);
    }
}
