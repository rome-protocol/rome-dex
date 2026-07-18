//! The pure CLMM engine: the multi-tick exact-in swap loop and the
//! position-modify (add/remove liquidity) state transition.
//!
//! Everything here operates on plain state structs plus raw tick-array byte
//! buffers ([`ArrayRefMut`]) — the exact same code path runs in host unit
//! tests and on-chain, so the exploit-critical logic is fully testable off-
//! chain. The processor is a thin account-validation wrapper around these.

use {
    crate::{
        curve::{
            fee_math::fee_growth_delta,
            liquidity_math::{add_liquidity_delta, get_amount_0_delta, get_amount_1_delta},
            swap_math::compute_swap_step,
            tick_math::{
                get_sqrt_price_at_tick, get_tick_at_sqrt_price, MAX_SQRT_PRICE, MAX_TICK,
                MIN_SQRT_PRICE, MIN_TICK,
            },
        },
        error::ClmmError,
        state::{
            fee_growth_inside_from_ticks, get_tick, set_tick, tick_array_start_index, Pool,
            Position, Tick, TICK_ARRAY_SIZE,
        },
    },
};

/// A mutable view over one tick-array account's FULL data (header + ticks),
/// tagged with its start index. The engine mutates crossed ticks in place.
pub struct ArrayRefMut<'a> {
    /// The array's start tick index (validated against the account by the caller).
    pub start: i32,
    /// The account's full data buffer.
    pub data: &'a mut [u8],
}

/// Outcome of an exact-in swap over the pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapOutcome {
    /// Input consumed, excluding the fee.
    pub amount_in: u64,
    /// Fee taken, in the input token (stays in the input vault for LPs).
    pub fee: u64,
    /// Output produced.
    pub amount_out: u64,
    /// Pool sqrt-price after the swap.
    pub sqrt_price: u128,
    /// Pool current tick after the swap.
    pub current_tick: i32,
    /// In-range liquidity after the swap.
    pub liquidity: u128,
    /// Updated `fee_growth_global` for the INPUT-side token (wrapping).
    pub fee_growth_global_in: u128,
}

/// Exact-in swap across ticks. `arrays` is the contiguous tick-array window in
/// walk order (`arrays[0]` contains `pool.current_tick`; each subsequent array
/// adjacent in the swap direction). Partial fill is allowed when
/// `sqrt_price_limit` is hit; running out of window with input remaining is
/// [`ClmmError::InvalidTickArraySequence`].
pub fn swap(
    pool: &Pool,
    arrays: &mut [ArrayRefMut],
    zero_for_one: bool,
    amount_in: u64,
    sqrt_price_limit: u128,
) -> Result<SwapOutcome, ClmmError> {
    if amount_in == 0 {
        return Err(ClmmError::ZeroLiquidity);
    }
    // The limit must sit strictly on the swap's side of the current price and
    // inside the representable band.
    let valid_limit = if zero_for_one {
        (MIN_SQRT_PRICE..pool.sqrt_price).contains(&sqrt_price_limit)
    } else {
        sqrt_price_limit > pool.sqrt_price && sqrt_price_limit <= MAX_SQRT_PRICE
    };
    if !valid_limit {
        return Err(ClmmError::SqrtPriceOutOfBounds);
    }

    let spacing = pool.tick_spacing;
    let span = TICK_ARRAY_SIZE as i32 * spacing as i32;
    // Window shape: arrays[0] holds the current tick; each next array is
    // adjacent in the walk direction.
    if arrays.is_empty()
        || arrays[0].start != tick_array_start_index(pool.current_tick, spacing)
    {
        return Err(ClmmError::InvalidTickArraySequence);
    }
    for i in 1..arrays.len() {
        let expected = if zero_for_one {
            arrays[i - 1].start - span
        } else {
            arrays[i - 1].start + span
        };
        if arrays[i].start != expected {
            return Err(ClmmError::InvalidTickArraySequence);
        }
    }

    let mut sqrt_price = pool.sqrt_price;
    let mut tick = pool.current_tick;
    let mut liquidity = pool.liquidity;
    let mut fee_growth_in = if zero_for_one {
        pool.fee_growth_global_0
    } else {
        pool.fee_growth_global_1
    };
    let mut remaining = amount_in as u128;
    let mut total_in = 0u128;
    let mut total_out = 0u128;
    let mut total_fee = 0u128;

    while remaining > 0 && sqrt_price != sqrt_price_limit {
        // Next spacing-aligned candidate at-or-past `tick` in the direction.
        let (next_tick, initialized, boundary) =
            next_target(arrays, span, spacing, tick, zero_for_one)?;
        let target_sqrt = get_sqrt_price_at_tick(next_tick.clamp(MIN_TICK, MAX_TICK))?;
        let clamped = if zero_for_one {
            target_sqrt.max(sqrt_price_limit)
        } else {
            target_sqrt.min(sqrt_price_limit)
        };

        if liquidity == 0 {
            // Zero-liquidity gap: the price teleports; nothing fills.
            sqrt_price = clamped;
        } else {
            let step = compute_swap_step(sqrt_price, clamped, liquidity, remaining, pool.fee_pips)?;
            remaining = remaining
                .checked_sub(
                    step.amount_in
                        .checked_add(step.fee_amount)
                        .ok_or(ClmmError::MathOverflow)?,
                )
                .ok_or(ClmmError::MathOverflow)?;
            total_in = total_in.checked_add(step.amount_in).ok_or(ClmmError::MathOverflow)?;
            total_out = total_out.checked_add(step.amount_out).ok_or(ClmmError::MathOverflow)?;
            total_fee = total_fee.checked_add(step.fee_amount).ok_or(ClmmError::MathOverflow)?;
            if step.fee_amount > 0 {
                // Wrapping by design — fee growth is a wrapped counter.
                fee_growth_in =
                    fee_growth_in.wrapping_add(fee_growth_delta(step.fee_amount, liquidity)?);
            }
            sqrt_price = step.sqrt_price_next;
        }

        if sqrt_price == target_sqrt {
            // Reaching a PAST-WINDOW boundary means the price landed on a tick
            // whose liquidity we can't read (it lives in an un-provided array).
            // Resting or crossing here would desync liquidity from the tick —
            // refuse, forcing the caller to supply that array so the tick is
            // read and crossed correctly. (Resting strictly BELOW it above is
            // a valid partial fill and never reaches this branch.)
            if boundary == Boundary::PastWindow {
                return Err(ClmmError::InvalidTickArraySequence);
            }
            // Reached an in-window boundary tick: cross it if initialized.
            if initialized {
                let idx = array_index(arrays[0].start, span, zero_for_one, next_tick, spacing);
                let arr = &mut arrays[idx];
                let mut t = get_tick(arr.data, arr.start, spacing, next_tick)?;
                let (g0, g1) = if zero_for_one {
                    (fee_growth_in, pool.fee_growth_global_1)
                } else {
                    (pool.fee_growth_global_0, fee_growth_in)
                };
                let net = t.cross(g0, g1);
                set_tick(arr.data, arr.start, spacing, next_tick, &t)?;
                let signed = if zero_for_one {
                    net.checked_neg().ok_or(ClmmError::MathOverflow)?
                } else {
                    net
                };
                liquidity = add_liquidity_delta(liquidity, signed)?;
            }
            tick = if zero_for_one { next_tick - 1 } else { next_tick };
        } else if sqrt_price != pool.sqrt_price {
            // Stopped mid-range (limit or amount exhausted).
            tick = get_tick_at_sqrt_price(sqrt_price)?;
        }
    }

    Ok(SwapOutcome {
        amount_in: u64::try_from(total_in).map_err(|_| ClmmError::MathOverflow)?,
        fee: u64::try_from(total_fee).map_err(|_| ClmmError::MathOverflow)?,
        amount_out: u64::try_from(total_out).map_err(|_| ClmmError::MathOverflow)?,
        sqrt_price,
        // At the extreme band edges the window boundary can sit past the
        // usable range; the stored tick stays representable.
        current_tick: tick.clamp(MIN_TICK, MAX_TICK),
        liquidity,
        fee_growth_global_in: fee_growth_in,
    })
}

/// Which array in the walk order holds `tick`.
fn array_index(first_start: i32, span: i32, zero_for_one: bool, tick: i32, spacing: u16) -> usize {
    let start = tick_array_start_index(tick, spacing);
    let diff = if zero_for_one {
        first_start - start
    } else {
        start - first_start
    };
    (diff / span) as usize
}

/// Where a boundary tick sits relative to the provided window.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Boundary {
    /// The tick was read from a provided array — safe to cross or rest at.
    InWindow,
    /// The tick is the first tick PAST the window (lives in an un-provided
    /// array). Its liquidity is unknown, so the price may pass THROUGH the
    /// preceding range toward it but must never REST at it — the caller must
    /// supply that array instead (the swap loop errors if it lands here).
    PastWindow,
}

/// Next spacing-aligned tick to step toward from `tick` (exclusive of `tick`
/// itself when walking right, inclusive when walking left — mirrors UV3's
/// lte semantics), scanning the contiguous window. Returns the tick, whether
/// it is initialized, and whether it was read from the window or sits past it.
/// Walking off the window is [`ClmmError::InvalidTickArraySequence`].
///
/// Both directions are symmetric: the returned tick is ALWAYS either a tick
/// read from a provided array (`InWindow` — safe to rest/cross) or the
/// first tick just past the window (`PastWindow` — a target the price may
/// approach but never rest on unread). The zero-for-one floor
/// (`arrays[last].start`) is in-window and read; the one-for-zero ceiling
/// (`arrays[last].start + span`) is past-window and must be flagged so the
/// loop can refuse to skip a potentially-initialized tick there.
fn next_target(
    arrays: &[ArrayRefMut],
    span: i32,
    spacing: u16,
    tick: i32,
    zero_for_one: bool,
) -> Result<(i32, bool, Boundary), ClmmError> {
    let sp = spacing as i32;
    let first = arrays[0].start;
    if zero_for_one {
        // Greatest aligned candidate <= tick.
        let mut cand = tick.div_euclid(sp) * sp;
        let window_lo = first - (arrays.len() as i32 - 1) * span;
        if cand < window_lo {
            return Err(ClmmError::InvalidTickArraySequence);
        }
        while cand >= window_lo {
            let idx = array_index(first, span, true, cand, spacing);
            let arr = &arrays[idx];
            if get_tick(arr.data, arr.start, spacing, cand)?.is_initialized() {
                return Ok((cand, true, Boundary::InWindow));
            }
            if cand == window_lo {
                // Window floor — READ and confirmed uninitialized: safe rest.
                return Ok((cand, false, Boundary::InWindow));
            }
            cand -= sp;
        }
        unreachable!()
    } else {
        // Smallest aligned candidate > tick.
        let mut cand = tick.div_euclid(sp) * sp + sp;
        let last = arrays[arrays.len() - 1].start;
        let window_hi = last + span; // first tick past the window
        if cand > window_hi {
            return Err(ClmmError::InvalidTickArraySequence);
        }
        while cand < window_hi {
            let idx = array_index(first, span, false, cand, spacing);
            let arr = &arrays[idx];
            if get_tick(arr.data, arr.start, spacing, cand)?.is_initialized() {
                return Ok((cand, true, Boundary::InWindow));
            }
            cand += sp;
        }
        // Window ceiling. If it lies beyond MAX_TICK, no initialized tick can
        // exist there — the usable band ends at MAX_TICK, which sits inside the
        // last provided array — so resting at the clamped max is safe
        // (InWindow). Otherwise it's a genuinely un-provided array whose
        // liquidity is UNKNOWN → PastWindow: the loop must not rest here unread.
        let boundary = if window_hi > MAX_TICK { Boundary::InWindow } else { Boundary::PastWindow };
        Ok((window_hi, false, boundary))
    }
}

/// Token amounts for `liquidity` over `[tick_lower, tick_upper]` at the pool's
/// current price. `round_up=true` for amounts the LP must pay in (increase),
/// false for amounts paid out (decrease) — always pool-favor.
pub fn amounts_for_liquidity(
    sqrt_price: u128,
    current_tick: i32,
    tick_lower: i32,
    tick_upper: i32,
    liquidity: u128,
    round_up: bool,
) -> Result<(u128, u128), ClmmError> {
    let sqrt_lower = get_sqrt_price_at_tick(tick_lower)?;
    let sqrt_upper = get_sqrt_price_at_tick(tick_upper)?;
    if current_tick < tick_lower {
        // Entirely above the current price: all token0.
        Ok((
            get_amount_0_delta(sqrt_lower, sqrt_upper, liquidity, round_up)?,
            0,
        ))
    } else if current_tick < tick_upper {
        // In range: token0 over [price, upper], token1 over [lower, price].
        Ok((
            get_amount_0_delta(sqrt_price, sqrt_upper, liquidity, round_up)?,
            get_amount_1_delta(sqrt_lower, sqrt_price, liquidity, round_up)?,
        ))
    } else {
        // Entirely below the current price: all token1.
        Ok((
            0,
            get_amount_1_delta(sqrt_lower, sqrt_upper, liquidity, round_up)?,
        ))
    }
}

/// Apply a liquidity delta to a position: update both boundary ticks, accrue
/// the position's fees at the current growth, apply the delta to the position
/// and (if in range) the pool, and return the token amounts to transfer
/// (in for `delta > 0`, out for `delta < 0`).
///
/// `arrays` holds the tick array(s) containing the bounds — one entry when
/// both bounds share an array, two otherwise (any order).
pub fn modify_position(
    pool: &mut Pool,
    position: &mut Position,
    arrays: &mut [ArrayRefMut],
    liquidity_delta: i128,
) -> Result<(u128, u128), ClmmError> {
    let spacing = pool.tick_spacing;
    let (tl, tu) = (position.tick_lower, position.tick_upper);

    // Guard the position's own accounting FIRST: a negative delta larger than
    // the position must fail before any tick is touched.
    let new_position_liquidity = add_liquidity_delta(position.liquidity, liquidity_delta)?;

    // Update both boundary ticks (UV3 order: ticks, then fee snapshot, then
    // position). `is_upper` selects the net sign.
    let update_tick = |arrays: &mut [ArrayRefMut],
                           tick: i32,
                           is_upper: bool|
     -> Result<(Tick, bool), ClmmError> {
        let want = tick_array_start_index(tick, spacing);
        let arr = arrays
            .iter_mut()
            .find(|a| a.start == want)
            .ok_or(ClmmError::InvalidTickArraySequence)?;
        let mut t = get_tick(arr.data, arr.start, spacing, tick)?;
        let flipped = t.update(
            liquidity_delta,
            is_upper,
            tick,
            pool.current_tick,
            pool.fee_growth_global_0,
            pool.fee_growth_global_1,
        )?;
        set_tick(arr.data, arr.start, spacing, tick, &t)?;
        Ok((t, flipped))
    };
    let (lower, lower_flipped) = update_tick(arrays, tl, false)?;
    let (upper, upper_flipped) = update_tick(arrays, tu, true)?;

    // Accrue the position's fees at the current inside growth — reading the
    // ticks' outside values BEFORE any dead-tick clear (that ordering is the
    // audit CRITICAL: clearing first over-credits this removal). Then apply the
    // delta to the position and — if the range is active — the pool.
    let (inside_0, inside_1) = fee_growth_inside_from_ticks(
        &lower,
        &upper,
        tl,
        tu,
        pool.current_tick,
        pool.fee_growth_global_0,
        pool.fee_growth_global_1,
    );
    position.update_fees(inside_0, inside_1)?;
    position.liquidity = new_position_liquidity;
    if tl <= pool.current_tick && pool.current_tick < tu {
        pool.liquidity = add_liquidity_delta(pool.liquidity, liquidity_delta)?;
    }

    // UV3 clear-AFTER: now that fees are snapshotted, zero any boundary tick
    // that flipped empty on this call so a future re-init starts clean.
    for (tick, flipped, mut t) in [(tl, lower_flipped, lower), (tu, upper_flipped, upper)] {
        if flipped && !t.is_initialized() {
            t.clear();
            let want = tick_array_start_index(tick, spacing);
            let arr = arrays
                .iter_mut()
                .find(|a| a.start == want)
                .ok_or(ClmmError::InvalidTickArraySequence)?;
            set_tick(arr.data, arr.start, spacing, tick, &t)?;
        }
    }

    // Pay-in rounds up, pay-out rounds down — pool-favor either way.
    let magnitude = liquidity_delta.unsigned_abs();
    amounts_for_liquidity(
        pool.sqrt_price,
        pool.current_tick,
        tl,
        tu,
        magnitude,
        liquidity_delta >= 0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{pack_tick_array_header, Tick, TICK_ARRAY_LEN};
    use solana_program::pubkey::Pubkey;

    const SPACING: u16 = 64;
    const SPAN: i32 = TICK_ARRAY_SIZE as i32 * SPACING as i32; // 5632

    fn pool_at(tick: i32, liquidity: u128) -> Pool {
        Pool {
            is_initialized: true,
            bump: 255,
            mint_0: Pubkey::new_unique(),
            mint_1: Pubkey::new_unique(),
            vault_0: Pubkey::new_unique(),
            vault_1: Pubkey::new_unique(),
            fee_pips: 3000,
            tick_spacing: SPACING,
            current_tick: tick,
            sqrt_price: get_sqrt_price_at_tick(tick).unwrap(),
            liquidity,
            fee_growth_global_0: 0,
            fee_growth_global_1: 0,
        }
    }

    fn empty_array(start: i32) -> Vec<u8> {
        let mut data = vec![0u8; TICK_ARRAY_LEN];
        pack_tick_array_header(&mut data, 255, &Pubkey::new_unique(), start);
        data
    }

    fn with_tick(start: i32, tick: i32, t: &Tick) -> Vec<u8> {
        let mut data = empty_array(start);
        set_tick(&mut data, start, SPACING, tick, t).unwrap();
        data
    }

    // ── amounts_for_liquidity ───────────────────────────────────────────────

    #[test]
    fn amounts_below_range_all_token0() {
        let (a0, a1) =
            amounts_for_liquidity(get_sqrt_price_at_tick(-1000).unwrap(), -1000, 0, 1280, 1 << 40, true)
                .unwrap();
        assert!(a0 > 0);
        assert_eq!(a1, 0);
    }

    #[test]
    fn amounts_above_range_all_token1() {
        let (a0, a1) =
            amounts_for_liquidity(get_sqrt_price_at_tick(2000).unwrap(), 2000, 0, 1280, 1 << 40, true)
                .unwrap();
        assert_eq!(a0, 0);
        assert!(a1 > 0);
    }

    #[test]
    fn amounts_in_range_both_and_split_at_price() {
        let sqrt = get_sqrt_price_at_tick(640).unwrap();
        let l = 1u128 << 40;
        let (a0, a1) = amounts_for_liquidity(sqrt, 640, 0, 1280, l, true).unwrap();
        assert!(a0 > 0 && a1 > 0);
        // token0 spans [price, upper], token1 spans [lower, price].
        let want0 =
            get_amount_0_delta(sqrt, get_sqrt_price_at_tick(1280).unwrap(), l, true).unwrap();
        let want1 =
            get_amount_1_delta(get_sqrt_price_at_tick(0).unwrap(), sqrt, l, true).unwrap();
        assert_eq!((a0, a1), (want0, want1));
    }

    #[test]
    fn amounts_round_up_geq_round_down() {
        let sqrt = get_sqrt_price_at_tick(37).unwrap(); // in range, off-grid price
        let (up0, up1) = amounts_for_liquidity(sqrt, 37, -1280, 1280, 999_999_999, true).unwrap();
        let (dn0, dn1) = amounts_for_liquidity(sqrt, 37, -1280, 1280, 999_999_999, false).unwrap();
        assert!(up0 >= dn0 && up1 >= dn1);
        assert!(up0 - dn0 <= 1 && up1 - dn1 <= 1);
    }

    // At the exact lower boundary the position is IN range (tick convention:
    // lower <= current < upper), so both sides can be non-zero-token1 is zero
    // exactly at the boundary price.
    #[test]
    fn amounts_at_lower_boundary_in_range() {
        let sqrt = get_sqrt_price_at_tick(0).unwrap();
        let (a0, a1) = amounts_for_liquidity(sqrt, 0, 0, 1280, 1 << 40, true).unwrap();
        assert!(a0 > 0);
        assert_eq!(a1, 0, "no token1 span at the exact lower bound");
    }

    // ── modify_position ─────────────────────────────────────────────────────

    /// Two-array window for a [-128, 128] position (bounds straddle array 0).
    fn straddle_window() -> (Vec<u8>, Vec<u8>, i32, i32) {
        let lstart = tick_array_start_index(-128, SPACING); // -5632
        let ustart = tick_array_start_index(128, SPACING); // 0
        (empty_array(lstart), empty_array(ustart), lstart, ustart)
    }

    #[test]
    fn increase_updates_ticks_position_and_pool_liquidity() {
        let mut pool = pool_at(0, 0);
        let mut pos = Position {
            is_initialized: true,
            bump: 1,
            pool: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            tick_lower: -128,
            tick_upper: 128,
            ..Position::default()
        };
        let (mut lower, mut upper, lstart, ustart) = straddle_window();
        let mut arrays = [
            ArrayRefMut { start: lstart, data: &mut lower },
            ArrayRefMut { start: ustart, data: &mut upper },
        ];
        let (a0, a1) = modify_position(&mut pool, &mut pos, &mut arrays, 1 << 30).unwrap();
        assert!(a0 > 0 && a1 > 0, "in-range add needs both tokens");
        assert_eq!(pool.liquidity, 1 << 30, "in-range add activates liquidity");
        assert_eq!(pos.liquidity, 1 << 30);
        let lt = get_tick(&lower, lstart, SPACING, -128).unwrap();
        let ut = get_tick(&upper, ustart, SPACING, 128).unwrap();
        assert_eq!(lt.liquidity_net, 1 << 30);
        assert_eq!(ut.liquidity_net, -(1 << 30));
        assert_eq!(lt.liquidity_gross, 1 << 30);
    }

    #[test]
    fn out_of_range_add_does_not_activate_pool_liquidity() {
        let mut pool = pool_at(-2000, 77);
        let mut pos = Position {
            is_initialized: true,
            tick_lower: 0,
            tick_upper: 128,
            ..Position::default()
        };
        // both bounds live in the array starting at 0 — single-entry window.
        let mut arr = empty_array(0);
        let mut arrays = [ArrayRefMut { start: 0, data: &mut arr }];
        let (a0, a1) = modify_position(&mut pool, &mut pos, &mut arrays, 500).unwrap();
        assert!(a0 > 0 && a1 == 0, "below-range add is all token0");
        assert_eq!(pool.liquidity, 77, "pool liquidity untouched");
        // both bounds recorded in the one shared array.
        assert_eq!(get_tick(&arr, 0, SPACING, 0).unwrap().liquidity_net, 500);
        assert_eq!(get_tick(&arr, 0, SPACING, 128).unwrap().liquidity_net, -500);
    }

    #[test]
    fn decrease_returns_amounts_and_deactivates() {
        let mut pool = pool_at(0, 0);
        let mut pos = Position {
            is_initialized: true,
            tick_lower: -128,
            tick_upper: 128,
            ..Position::default()
        };
        let (mut lower, mut upper, lstart, ustart) = straddle_window();
        let l = 1u128 << 30;
        let mut arrays = [
            ArrayRefMut { start: lstart, data: &mut lower },
            ArrayRefMut { start: ustart, data: &mut upper },
        ];
        let (in0, in1) = modify_position(&mut pool, &mut pos, &mut arrays, l as i128).unwrap();
        let (out0, out1) = modify_position(&mut pool, &mut pos, &mut arrays, -(l as i128)).unwrap();
        assert_eq!(pool.liquidity, 0);
        assert_eq!(pos.liquidity, 0);
        assert!(out0 <= in0 && out1 <= in1, "pool-favor: out <= in");
        // both boundary ticks flip back to empty.
        assert!(!get_tick(&lower, lstart, SPACING, -128).unwrap().is_initialized());
        assert!(!get_tick(&upper, ustart, SPACING, 128).unwrap().is_initialized());
    }

    #[test]
    fn fees_accrue_to_position_on_modify() {
        let mut pool = pool_at(0, 0);
        let mut pos = Position {
            is_initialized: true,
            tick_lower: -128,
            tick_upper: 128,
            ..Position::default()
        };
        let (mut lower, mut upper, lstart, ustart) = straddle_window();
        let mut arrays = [
            ArrayRefMut { start: lstart, data: &mut lower },
            ArrayRefMut { start: ustart, data: &mut upper },
        ];
        modify_position(&mut pool, &mut pos, &mut arrays, 100).unwrap();
        // fees accrue globally while in range: 2.0 per unit liquidity.
        pool.fee_growth_global_0 = 2 << 64;
        modify_position(&mut pool, &mut pos, &mut arrays, 1).unwrap();
        assert_eq!(pos.tokens_owed_0, 200, "100 liquidity x 2.0 growth");
    }

    #[test]
    fn modify_rejects_removing_more_than_position() {
        let mut pool = pool_at(0, 0);
        let mut pos = Position {
            is_initialized: true,
            tick_lower: -128,
            tick_upper: 128,
            ..Position::default()
        };
        let (mut lower, mut upper, lstart, ustart) = straddle_window();
        let mut arrays = [
            ArrayRefMut { start: lstart, data: &mut lower },
            ArrayRefMut { start: ustart, data: &mut upper },
        ];
        modify_position(&mut pool, &mut pos, &mut arrays, 100).unwrap();
        assert!(modify_position(&mut pool, &mut pos, &mut arrays, -101).is_err());
    }

    /// AUDIT CRITICAL (fee over-credit): opening an in-range position in a pool
    /// that already carries accrued fees, then immediately removing it in full,
    /// must credit ZERO fees — the position earned nothing over zero duration.
    /// A premature `fee_growth_outside` clear (inside Tick::update, before the
    /// fee snapshot) would instead mint ≈ L·fee_growth_global/2^64 from nothing,
    /// drainable via Collect. The clear must happen AFTER the snapshot (UV3).
    #[test]
    fn audit_crit_no_fee_overcredit_on_open_then_immediate_full_decrease() {
        let mut pool = pool_at(0, 0);
        // Any live pool carries accrued global fee growth.
        pool.fee_growth_global_0 = 5u128 << 64;
        pool.fee_growth_global_1 = 3u128 << 64;
        let mut pos = Position {
            is_initialized: true,
            tick_lower: -128,
            tick_upper: 128,
            ..Position::default()
        };
        let (mut lower, mut upper, lstart, ustart) = straddle_window();
        let mut arrays = [
            ArrayRefMut { start: lstart, data: &mut lower },
            ArrayRefMut { start: ustart, data: &mut upper },
        ];
        let l = 1_000_000_000i128;
        modify_position(&mut pool, &mut pos, &mut arrays, l).unwrap(); // open in-range
        modify_position(&mut pool, &mut pos, &mut arrays, -l).unwrap(); // immediate full remove
        assert_eq!(pos.tokens_owed_0, 0, "zero-duration position must earn nothing (token0)");
        assert_eq!(pos.tokens_owed_1, 0, "zero-duration position must earn nothing (token1)");
    }

    /// A dead tick (flipped empty on a removal) must still be cleared so a later
    /// re-initialization above the current tick starts from zero — but that
    /// clear happens in modify_position AFTER the fee snapshot, so a subsequent
    /// re-open reads clean outside values.
    #[test]
    fn dead_boundary_tick_is_cleared_after_removal() {
        let mut pool = pool_at(0, 0);
        pool.fee_growth_global_0 = 9u128 << 64;
        let mut pos = Position { is_initialized: true, tick_lower: -128, tick_upper: 128, ..Position::default() };
        let (mut lower, mut upper, lstart, ustart) = straddle_window();
        let mut arrays = [
            ArrayRefMut { start: lstart, data: &mut lower },
            ArrayRefMut { start: ustart, data: &mut upper },
        ];
        modify_position(&mut pool, &mut pos, &mut arrays, 1_000_000_000).unwrap();
        modify_position(&mut pool, &mut pos, &mut arrays, -1_000_000_000).unwrap();
        // lower (-128) was seeded with global at open; after full removal it is
        // dead and must be cleared (else a re-init above current inherits it).
        let lt = get_tick(&lower, lstart, SPACING, -128).unwrap();
        assert!(!lt.is_initialized());
        assert_eq!(lt.fee_growth_outside_0, 0, "dead tick outside cleared");
    }

    #[test]
    fn modify_errors_when_window_misses_a_bound() {
        let mut pool = pool_at(0, 0);
        let mut pos = Position {
            is_initialized: true,
            tick_lower: -128,
            tick_upper: 128,
            ..Position::default()
        };
        // only the upper bound's array supplied.
        let mut arr = empty_array(0);
        let mut arrays = [ArrayRefMut { start: 0, data: &mut arr }];
        assert_eq!(
            modify_position(&mut pool, &mut pos, &mut arrays, 100).unwrap_err(),
            ClmmError::InvalidTickArraySequence
        );
    }

    // ── swap ────────────────────────────────────────────────────────────────

    /// One array around tick 0, ample liquidity, small swap: no crossings.
    #[test]
    fn swap_within_tick_consumes_exactly_and_grows_fees() {
        // mid-array so a small move stays inside the single array's window.
        let pool = pool_at(100, 1u128 << 50);
        let mut a0 = empty_array(0);
        let mut arrays = [ArrayRefMut { start: 0, data: &mut a0 }];
        let amount = 1_000_000u64;
        let out = swap(&pool, &mut arrays, true, amount, MIN_SQRT_PRICE).unwrap();
        assert_eq!(out.amount_in + out.fee, amount, "exact-in consumes all input");
        assert!(out.amount_out > 0);
        assert!(out.sqrt_price < pool.sqrt_price, "zero_for_one moves price down");
        assert!(out.liquidity == pool.liquidity, "no crossing");
        let expected_growth = fee_growth_delta(out.fee as u128, pool.liquidity).unwrap();
        assert_eq!(out.fee_growth_global_in, expected_growth);
    }

    #[test]
    fn swap_one_for_zero_moves_price_up() {
        let pool = pool_at(100, 1u128 << 50);
        let mut a0 = empty_array(0);
        let mut arrays = [ArrayRefMut { start: 0, data: &mut a0 }];
        let out = swap(&pool, &mut arrays, false, 1_000_000, MAX_SQRT_PRICE).unwrap();
        assert!(out.sqrt_price > pool.sqrt_price);
        assert!(out.amount_out > 0);
    }

    /// AUDIT REGRESSION (Finding 1): a one-for-zero (rising) swap must never
    /// rest at the window's top boundary `last_array.start + span` and treat it
    /// as uninitialized WITHOUT reading it — that tick lives in the next,
    /// un-provided array and may carry liquidity. Skipping it desyncs
    /// pool.liquidity from current_tick. The engine must instead demand that
    /// array (Err), mirroring the zero-for-one floor which IS read/crossable.
    #[test]
    fn swap_one_for_zero_errors_at_unreadable_window_ceiling() {
        // Window = [array@0] only. window_hi = 0 + SPAN. A rising swap with a
        // limit exactly at sqrt(window_hi) reaches that boundary; since the
        // array containing window_hi (start = SPAN) is NOT provided, the engine
        // cannot know whether a tick sits there → must error, not skip.
        let pool = pool_at(0, 1u128 << 45);
        let limit = get_sqrt_price_at_tick(SPAN).unwrap();
        let mut a0 = empty_array(0);
        let mut arrays = [ArrayRefMut { start: 0, data: &mut a0 }];
        let err = swap(&pool, &mut arrays, false, u64::MAX / 2, limit).unwrap_err();
        assert_eq!(
            err, ClmmError::InvalidTickArraySequence,
            "reaching the unreadable window ceiling must demand the next array, not silently rest",
        );
    }

    /// The companion happy path: WITH the ceiling's array provided, the same
    /// rising swap crosses an initialized tick sitting exactly at that boundary
    /// and updates liquidity — proving the fix routes the caller correctly.
    #[test]
    fn swap_one_for_zero_crosses_tick_at_window_boundary_when_array_present() {
        let extra = 400_000u128;
        let base = 1u128 << 30;
        // A position LOWER bound exactly at SPAN (net = +extra): crossing it
        // going up adds liquidity. Liquidity is small enough that the input
        // pushes the price past tick SPAN (≈ +32.5% price).
        let t = Tick { liquidity_gross: extra, liquidity_net: extra as i128, ..Tick::default() };
        let pool = pool_at(0, base);
        let mut a0 = empty_array(0);
        let mut a1 = with_tick(SPAN, SPAN, &t);
        let mut arrays = [
            ArrayRefMut { start: 0, data: &mut a0 },
            ArrayRefMut { start: SPAN, data: &mut a1 },
        ];
        // Sized to cross tick SPAN but REST below the next ceiling (2·SPAN),
        // so it's a clean crossing, not a window-exhaustion error.
        let out = swap(&pool, &mut arrays, false, 500_000_000, MAX_SQRT_PRICE).unwrap();
        assert!(out.current_tick >= SPAN, "price crossed up past the boundary tick");
        assert_eq!(out.liquidity, base + extra, "crossing up the lower bound adds its net");
    }

    /// AUDIT #8 (band-edge liveness): at the very top of the band the window
    /// ceiling `last.start + span` exceeds MAX_TICK. No tick can live past
    /// MAX_TICK, so a rising swap reaching the max must NOT spuriously error
    /// (the pre-fix code returned PastWindow → InvalidTickArraySequence).
    #[test]
    fn swap_one_for_zero_rests_at_band_top_without_error() {
        // Array containing MAX_TICK: start = floor(MAX_TICK/SPAN)*SPAN.
        let start = (MAX_TICK / SPAN) * SPAN; // 439296; start + SPAN > MAX_TICK
        let pool = pool_at(start + 64, 1u128 << 40);
        let mut a0 = empty_array(start);
        let mut arrays = [ArrayRefMut { start, data: &mut a0 }];
        // Rising swap with no explicit limit (band edge) — must succeed, not err.
        let out = swap(&pool, &mut arrays, false, 1_000_000, MAX_SQRT_PRICE).unwrap();
        assert!(out.sqrt_price > pool.sqrt_price, "price rose toward the band top");
        assert!(out.current_tick <= MAX_TICK, "tick stays representable");
    }

    /// Crossing left through a position's LOWER tick drops its liquidity.
    #[test]
    fn swap_crossing_removes_liquidity_and_flips_outside() {
        let extra = 500_000u128;
        let base = 1u128 << 40;
        // tick -128 is the lower bound of an in-range position: net = +extra.
        let t = Tick {
            liquidity_gross: extra,
            liquidity_net: extra as i128,
            fee_growth_outside_0: 7,
            fee_growth_outside_1: 11,
        };
        let mut pool = pool_at(0, base + extra);
        pool.fee_growth_global_1 = 1000;
        let mut a0 = empty_array(0);
        let mut a1 = with_tick(-SPAN, -128, &t);
        let mut arrays = [
            ArrayRefMut { start: 0, data: &mut a0 },
            ArrayRefMut { start: -SPAN, data: &mut a1 },
        ];
        // enough input to push well past tick -128 (Δsqrt ≈ in·2^64/L).
        let out = swap(&pool, &mut arrays, true, 200_000_000_000, MIN_SQRT_PRICE).unwrap();
        assert!(out.current_tick < -128, "price crossed the tick");
        assert_eq!(out.liquidity, base, "crossing left removes the position's net");
        let crossed = get_tick(arrays[1].data, -SPAN, SPACING, -128).unwrap();
        // outside flipped against the globals AS OF cross time: the input-side
        // global at the cross (recovered as outside_0 + old outside) must be
        // positive and no larger than the final global (fees keep accruing
        // after the cross); the output-side global never moves in this swap.
        let g0_at_cross = crossed.fee_growth_outside_0.wrapping_add(7);
        assert!(g0_at_cross > 0 && g0_at_cross <= out.fee_growth_global_in);
        assert_eq!(crossed.fee_growth_outside_1, 1000u128.wrapping_sub(11));
    }

    /// A zero-liquidity gap is jumped without consuming input or output.
    #[test]
    fn swap_jumps_zero_liquidity_gap() {
        // No liquidity at current price; a position [(-∞ side)…] activates at
        // tick -256 when moving left: that's its UPPER bound, net = -800000.
        let t = Tick {
            liquidity_gross: 800_000,
            liquidity_net: -800_000,
            fee_growth_outside_0: 0,
            fee_growth_outside_1: 0,
        };
        let pool = pool_at(0, 0);
        let mut a0 = empty_array(0);
        let mut a1 = with_tick(-SPAN, -256, &t);
        let mut arrays = [
            ArrayRefMut { start: 0, data: &mut a0 },
            ArrayRefMut { start: -SPAN, data: &mut a1 },
        ];
        let out = swap(&pool, &mut arrays, true, 10_000, MIN_SQRT_PRICE).unwrap();
        assert_eq!(out.liquidity, 800_000, "liquidity activates after the gap");
        assert!(out.amount_out > 0, "swap fills against the activated range");
        assert!(out.current_tick < -256);
        assert_eq!(out.amount_in + out.fee, 10_000);
    }

    #[test]
    fn swap_partial_fill_stops_at_price_limit() {
        let pool = pool_at(100, 1u128 << 45);
        let limit = get_sqrt_price_at_tick(80).unwrap();
        let mut a0 = empty_array(0);
        let mut arrays = [ArrayRefMut { start: 0, data: &mut a0 }];
        let out = swap(&pool, &mut arrays, true, u64::MAX / 2, limit).unwrap();
        assert_eq!(out.sqrt_price, limit, "stops exactly at the limit");
        assert!(
            (out.amount_in as u128) + (out.fee as u128) < (u64::MAX / 2) as u128,
            "partial fill"
        );
    }

    #[test]
    fn swap_errors_when_window_exhausted() {
        let pool = pool_at(0, 1u128 << 20);
        let mut a0 = empty_array(0);
        let mut arrays = [ArrayRefMut { start: 0, data: &mut a0 }];
        // huge amount, no limit → must walk past the single array → error.
        let err = swap(&pool, &mut arrays, true, u64::MAX, MIN_SQRT_PRICE).unwrap_err();
        assert_eq!(err, ClmmError::InvalidTickArraySequence);
    }

    #[test]
    fn swap_validates_window_shape() {
        let pool = pool_at(0, 1 << 20);
        // arrays[0] must contain the current tick.
        let mut wrong = empty_array(SPAN);
        let err = swap(
            &pool,
            &mut [ArrayRefMut { start: SPAN, data: &mut wrong }],
            true,
            1000,
            MIN_SQRT_PRICE,
        )
        .unwrap_err();
        assert_eq!(err, ClmmError::InvalidTickArraySequence);
        // adjacency: going left, next start must be start - SPAN.
        let mut a = empty_array(0);
        let mut gap = empty_array(-2 * SPAN);
        let err = swap(
            &pool,
            &mut [
                ArrayRefMut { start: 0, data: &mut a },
                ArrayRefMut { start: -2 * SPAN, data: &mut gap },
            ],
            true,
            1000,
            MIN_SQRT_PRICE,
        )
        .unwrap_err();
        assert_eq!(err, ClmmError::InvalidTickArraySequence);
    }

    #[test]
    fn swap_validates_limit_side() {
        let pool = pool_at(0, 1 << 20);
        let mut a = empty_array(0);
        // zero_for_one with a limit ABOVE the current price is invalid.
        let err = swap(
            &pool,
            &mut [ArrayRefMut { start: 0, data: &mut a }],
            true,
            1000,
            MAX_SQRT_PRICE,
        )
        .unwrap_err();
        assert_eq!(err, ClmmError::SqrtPriceOutOfBounds);
        let mut a = empty_array(0);
        let err = swap(
            &pool,
            &mut [ArrayRefMut { start: 0, data: &mut a }],
            true,
            1000,
            MIN_SQRT_PRICE - 1,
        )
        .unwrap_err();
        assert_eq!(err, ClmmError::SqrtPriceOutOfBounds);
    }

    #[test]
    fn swap_rejects_zero_amount() {
        let pool = pool_at(0, 1 << 20);
        let mut a = empty_array(0);
        assert!(swap(
            &pool,
            &mut [ArrayRefMut { start: 0, data: &mut a }],
            true,
            0,
            MIN_SQRT_PRICE
        )
        .is_err());
    }

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]
        /// Fuzz the swap loop over an empty two-array window: the engine must
        /// never consume more than the given input, must move the price only
        /// in the swap direction, and must never invent liquidity. Window
        /// exhaustion is a safe rejection, never a mis-fill.
        #[test]
        fn prop_swap_never_over_consumes_or_reverses(
            l in 1u128..(1u128 << 64),
            amt in 1u64..(u64::MAX / 4),
            t0 in -300_000i32..300_000,
            zfo in proptest::bool::ANY,
        ) {
            let pool = pool_at(t0, l);
            let s0 = tick_array_start_index(t0, SPACING);
            let s1 = if zfo { s0 - SPAN } else { s0 + SPAN };
            let mut a = empty_array(s0);
            let mut b = empty_array(s1);
            let mut arrays = [
                ArrayRefMut { start: s0, data: &mut a },
                ArrayRefMut { start: s1, data: &mut b },
            ];
            let limit = if zfo { MIN_SQRT_PRICE } else { MAX_SQRT_PRICE };
            match swap(&pool, &mut arrays, zfo, amt, limit) {
                Ok(o) => {
                    prop_assert!((o.amount_in as u128) + (o.fee as u128) <= amt as u128);
                    if zfo {
                        prop_assert!(o.sqrt_price <= pool.sqrt_price);
                    } else {
                        prop_assert!(o.sqrt_price >= pool.sqrt_price);
                    }
                    prop_assert_eq!(o.liquidity, l, "no initialized tick to cross");
                }
                // Safe rejections: ran past the two-array window, or the
                // computed amounts exceed u64 (impossible with real vaults —
                // same skip convention as the audited curve props).
                Err(ClmmError::InvalidTickArraySequence) | Err(ClmmError::MathOverflow) => {}
                Err(e) => prop_assert!(false, "unexpected error {:?}", e),
            }
        }
    }

    /// Round-trip: swap left crossing a tick, then swap right back across it.
    /// The pool must end with its original liquidity and a price at-or-below
    /// the start (pool-favor rounding), never above.
    #[test]
    fn swap_round_trip_conserves_liquidity_and_pool_favor() {
        let extra = 1u128 << 38;
        let base = 1u128 << 40;
        let t = Tick {
            liquidity_gross: extra,
            liquidity_net: extra as i128,
            ..Tick::default()
        };
        let mut pool = pool_at(0, base + extra);
        // left leg
        let mut a0 = empty_array(0);
        let mut a1 = with_tick(-SPAN, -128, &t);
        let mut arrays = [
            ArrayRefMut { start: 0, data: &mut a0 },
            ArrayRefMut { start: -SPAN, data: &mut a1 },
        ];
        let left = swap(&pool, &mut arrays, true, 200_000_000_000, MIN_SQRT_PRICE).unwrap();
        assert!(left.current_tick < -128);
        pool.sqrt_price = left.sqrt_price;
        pool.current_tick = left.current_tick;
        pool.liquidity = left.liquidity;
        pool.fee_growth_global_0 = left.fee_growth_global_in;
        // right leg: swap the output back
        let mut arrays = [
            ArrayRefMut { start: -SPAN, data: &mut a1 },
            ArrayRefMut { start: 0, data: &mut a0 },
        ];
        // walking right: first array must contain the current tick.
        let right = swap(&pool, &mut arrays[1..], false, left.amount_out, MAX_SQRT_PRICE);
        let right = match right {
            Ok(r) => r,
            // if the pool rests in the -SPAN array after the left leg, use both.
            Err(_) => swap(&pool, &mut arrays, false, left.amount_out, MAX_SQRT_PRICE).unwrap(),
        };
        assert_eq!(right.liquidity, base + extra, "net restored after re-cross");
        assert!(right.sqrt_price <= get_sqrt_price_at_tick(0).unwrap(), "pool never loses to a round trip");
    }
}
