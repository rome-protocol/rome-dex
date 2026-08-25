//! Wire encoding for the CLMM instructions this rig drives.
//!
//! The rig writes these bytes; the program reads them with its own
//! `ClmmInstruction::unpack`. Rather than trust that the two agree, every
//! encoder is round-tripped through the real `unpack` in `verify_encoding()`
//! before any measurement runs — a mis-encoded instruction would otherwise
//! fail inside the program and be reported as a CU difference.

use rome_dex_clmm::instruction::ClmmInstruction;

pub fn init_pool(bump: u8, fee_pips: u32, tick_spacing: u16, sqrt_price: u128) -> Vec<u8> {
    let mut d = vec![0u8];
    d.push(bump);
    d.extend_from_slice(&fee_pips.to_le_bytes());
    d.extend_from_slice(&tick_spacing.to_le_bytes());
    d.extend_from_slice(&sqrt_price.to_le_bytes());
    d
}

pub fn init_tick_array(start_tick_index: i32, bump: u8) -> Vec<u8> {
    let mut d = vec![1u8];
    d.extend_from_slice(&start_tick_index.to_le_bytes());
    d.push(bump);
    d
}

pub fn open_position(tick_lower: i32, tick_upper: i32, bump: u8) -> Vec<u8> {
    let mut d = vec![2u8];
    d.extend_from_slice(&tick_lower.to_le_bytes());
    d.extend_from_slice(&tick_upper.to_le_bytes());
    d.push(bump);
    d
}

pub fn increase_liquidity(liquidity_delta: u128, amount_0_max: u64, amount_1_max: u64) -> Vec<u8> {
    let mut d = vec![3u8];
    d.extend_from_slice(&liquidity_delta.to_le_bytes());
    d.extend_from_slice(&amount_0_max.to_le_bytes());
    d.extend_from_slice(&amount_1_max.to_le_bytes());
    d
}

pub fn swap(zero_for_one: bool, amount_in: u64, min_amount_out: u64, sqrt_price_limit: u128) -> Vec<u8> {
    let mut d = vec![7u8];
    d.push(zero_for_one as u8);
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&min_amount_out.to_le_bytes());
    d.extend_from_slice(&sqrt_price_limit.to_le_bytes());
    d
}

/// Round-trips every encoder above through the program's own `unpack`.
/// Panics with the mismatch if any encoder has drifted from the wire format.
pub fn verify_encoding() {
    match ClmmInstruction::unpack(&init_pool(254, 3000, 64, 1 << 64)).unwrap() {
        ClmmInstruction::InitPool { bump, fee_pips, tick_spacing, sqrt_price } => {
            assert_eq!((bump, fee_pips, tick_spacing, sqrt_price), (254, 3000, 64, 1 << 64));
        }
        o => panic!("init_pool encoded as {o:?}"),
    }
    match ClmmInstruction::unpack(&init_tick_array(-5632, 253)).unwrap() {
        ClmmInstruction::InitTickArray { start_tick_index, bump } => {
            assert_eq!((start_tick_index, bump), (-5632, 253));
        }
        o => panic!("init_tick_array encoded as {o:?}"),
    }
    match ClmmInstruction::unpack(&open_position(-640, 640, 252)).unwrap() {
        ClmmInstruction::OpenPosition { tick_lower, tick_upper, bump } => {
            assert_eq!((tick_lower, tick_upper, bump), (-640, 640, 252));
        }
        o => panic!("open_position encoded as {o:?}"),
    }
    match ClmmInstruction::unpack(&increase_liquidity(1 << 40, 111, 222)).unwrap() {
        ClmmInstruction::IncreaseLiquidity { liquidity_delta, amount_0_max, amount_1_max } => {
            assert_eq!((liquidity_delta, amount_0_max, amount_1_max), (1 << 40, 111, 222));
        }
        o => panic!("increase_liquidity encoded as {o:?}"),
    }
    match ClmmInstruction::unpack(&swap(true, 12345, 1, 0)).unwrap() {
        ClmmInstruction::Swap { zero_for_one, amount_in, min_amount_out, sqrt_price_limit } => {
            assert_eq!((zero_for_one, amount_in, min_amount_out, sqrt_price_limit), (true, 12345, 1, 0));
        }
        o => panic!("swap encoded as {o:?}"),
    }
}
