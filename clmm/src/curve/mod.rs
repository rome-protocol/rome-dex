//! CLMM math core: fixed-point (Q64.64) helpers, tick↔sqrt-price conversion,
//! liquidity/amount deltas, the per-tick swap step, and fee-growth accounting.

// The `construct_uint!` (U512) expansion trips these style lints internally.
#![allow(clippy::assign_op_pattern, clippy::manual_div_ceil)]

pub mod fee_math;
pub mod liquidity_math;
pub mod swap_math;
pub mod tick_math;

#[cfg(test)]
mod props;

use {crate::error::ClmmError, spl_math::uint::U256, uint::construct_uint};

construct_uint! {
    /// 512-bit unsigned — full-precision intermediate for the `amount0` delta
    /// (`liquidity·2^64·Δsqrt / (sqrt_a·sqrt_b)` can reach ~320 bits), matching
    /// Uniswap V3's 512-bit fullMath so no rounding compromise is needed.
    pub struct U512(8);
}

/// `floor(a·b / denom)` with a 512-bit numerator (`a`,`b`,`denom` are U512).
pub fn u512_div_floor(num: U512, denom: U512) -> Result<u128, ClmmError> {
    if denom.is_zero() {
        return Err(ClmmError::MathOverflow);
    }
    let q = num / denom;
    if q > U512::from(u128::MAX) {
        return Err(ClmmError::MathOverflow);
    }
    Ok(q.low_u128())
}

/// `ceil(a·b / denom)` with a 512-bit numerator.
pub fn u512_div_ceil(num: U512, denom: U512) -> Result<u128, ClmmError> {
    if denom.is_zero() {
        return Err(ClmmError::MathOverflow);
    }
    let q = (num + (denom - U512::from(1u8))) / denom;
    if q > U512::from(u128::MAX) {
        return Err(ClmmError::MathOverflow);
    }
    Ok(q.low_u128())
}

/// Fixed-point shift: prices are Q64.64.
pub const Q64_RESOLUTION: u32 = 64;
/// `1.0` in Q64.64.
pub const Q64: u128 = 1u128 << 64;
/// Fee denominator — fees are expressed in pips (1e-6), like Uniswap V3.
pub const FEE_DENOM: u128 = 1_000_000;

/// `floor(a * b / 2^64)` at full 256-bit intermediate precision.
pub fn mul_shift_q64(a: u128, b: u128) -> Result<u128, ClmmError> {
    let p = (U256::from(a) * U256::from(b)) >> Q64_RESOLUTION;
    u128::try_from(p).map_err(|_| ClmmError::MathOverflow)
}

/// `floor(a * b / denom)` at full 256-bit intermediate precision.
pub fn mul_div_floor(a: u128, b: u128, denom: u128) -> Result<u128, ClmmError> {
    if denom == 0 {
        return Err(ClmmError::MathOverflow);
    }
    let q = (U256::from(a) * U256::from(b)) / U256::from(denom);
    u128::try_from(q).map_err(|_| ClmmError::MathOverflow)
}

/// `ceil(a * b / denom)` at full 256-bit intermediate precision.
pub fn mul_div_ceil(a: u128, b: u128, denom: u128) -> Result<u128, ClmmError> {
    if denom == 0 {
        return Err(ClmmError::MathOverflow);
    }
    let num = U256::from(a) * U256::from(b);
    let d = U256::from(denom);
    let q = (num + (d - U256::from(1u8))) / d;
    u128::try_from(q).map_err(|_| ClmmError::MathOverflow)
}
