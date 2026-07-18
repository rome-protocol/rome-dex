//! Property-based fuzzing of the CLMM math invariants — the exploit-critical
//! guarantees that must hold for ALL inputs, not just the fixed vectors: rounding
//! direction (pool-favor), monotonicity, and swap-step conservation.

#![cfg(test)]

use {
    super::{
        liquidity_math::{get_amount_0_delta, get_amount_1_delta},
        swap_math::compute_swap_step,
        tick_math::{get_sqrt_price_at_tick, MAX_TICK, MIN_TICK},
    },
    proptest::prelude::*,
};

proptest! {
    // sqrt-price is strictly increasing in tick, everywhere.
    #[test]
    fn sqrt_price_monotonic(t in MIN_TICK..MAX_TICK) {
        let a = get_sqrt_price_at_tick(t).unwrap();
        let b = get_sqrt_price_at_tick(t + 1).unwrap();
        prop_assert!(b > a);
    }

    // Both amount deltas: ceil >= floor, and the gap is at most 1 unit. Fuzzes
    // the FULL u128 liquidity band (incl. 2^64..2^128, the range the earlier
    // suite left blind). An extreme combo that overflows u128 returns Err — a
    // safe rejection, not a violation — so we skip those.
    #[test]
    fn amount_deltas_round_pool_favor(
        tl in MIN_TICK..(MAX_TICK - 1),
        span in 1i32..50_000,
        liq in 1u128..=u128::MAX,
    ) {
        let tu = (tl + span).min(MAX_TICK);
        let a = get_sqrt_price_at_tick(tl).unwrap();
        let b = get_sqrt_price_at_tick(tu).unwrap();
        for f in [get_amount_0_delta, get_amount_1_delta] {
            if let (Ok(down), Ok(up)) = (f(a, b, liq, false), f(a, b, liq, true)) {
                prop_assert!(up >= down);
                prop_assert!(up - down <= 1);
            }
        }
    }

    // Amount deltas are non-decreasing in liquidity (full u128 band).
    #[test]
    fn amount_deltas_monotonic_in_liquidity(
        tl in MIN_TICK..(MAX_TICK - 1),
        span in 1i32..50_000,
        l1 in 1u128..=u128::MAX / 2,
        extra in 1u128..=u128::MAX / 2,
    ) {
        let tu = (tl + span).min(MAX_TICK);
        let a = get_sqrt_price_at_tick(tl).unwrap();
        let b = get_sqrt_price_at_tick(tu).unwrap();
        let l2 = l1 + extra;
        if let (Ok(d1), Ok(d2)) = (get_amount_0_delta(a, b, l1, false), get_amount_0_delta(a, b, l2, false)) {
            prop_assert!(d2 >= d1);
        }
        if let (Ok(d1), Ok(d2)) = (get_amount_1_delta(a, b, l1, false), get_amount_1_delta(a, b, l2, false)) {
            prop_assert!(d2 >= d1);
        }
    }

    // Swap step conserves input (in + fee <= remaining), rests between current
    // and target, and never produces output from nothing — over the FULL u128
    // liquidity/amount band and the FULL fee range (0..1e6). Err = safe reject.
    #[test]
    fn swap_step_conserves_and_bounds(
        tc in (MIN_TICK + 1)..(MAX_TICK - 1),
        dir in prop::bool::ANY,
        span in 1i32..20_000,
        liq in 1_000u128..=u128::MAX,
        remaining in 1u128..=u128::MAX,
        fee_pips in 0u32..1_000_000,
    ) {
        let tt = if dir { (tc + span).min(MAX_TICK) } else { (tc - span).max(MIN_TICK) };
        prop_assume!(tt != tc);
        let cur = get_sqrt_price_at_tick(tc).unwrap();
        let tgt = get_sqrt_price_at_tick(tt).unwrap();
        let s = match compute_swap_step(cur, tgt, liq, remaining, fee_pips) {
            Ok(s) => s,
            Err(_) => return Ok(()), // extreme-overflow input → safe rejection
        };
        // never charges more than provided
        prop_assert!(s.amount_in + s.fee_amount <= remaining);
        // next price rests within [min(cur,tgt), max(cur,tgt)]
        let (lo, hi) = if cur <= tgt { (cur, tgt) } else { (tgt, cur) };
        prop_assert!(s.sqrt_price_next >= lo && s.sqrt_price_next <= hi);
        // if any input was consumed, price moved; output is only from real input
        if s.amount_in == 0 {
            prop_assert_eq!(s.amount_out, 0);
        }
    }
}
