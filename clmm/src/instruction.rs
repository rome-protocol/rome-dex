//! CLMM instructions + their wire encoding (tag byte + little-endian fields).

use {crate::error::ClmmError, solana_program::program_error::ProgramError};

/// Instructions accepted by the CLMM program.
///
/// Authority-agnostic seam: every owner-gated instruction takes the owner as
/// ONE signer over the owner's own token accounts — identical for a Solana
/// wallet and an EVM user's Rome `external_auth` PDA (the CPI lane auto-signs).
#[derive(Clone, Debug, PartialEq)]
pub enum ClmmInstruction {
    /// Create a pool for an ordered mint pair at a fee tier (permissionless).
    ///
    /// Accounts: `[pool(w), mint_0, mint_1, vault_0, vault_1, payer(s,w),
    /// system_program]`. The vaults must be the pool PDA's ATAs (deterministic
    /// clean creation — the app creates them beforehand; the program verifies
    /// the derivation, it does not trust).
    InitPool {
        /// PDA bump for `[b"pool", mint_0, mint_1, fee_pips_le]`.
        bump: u8,
        /// Swap fee in pips (1e-6), e.g. 3000 = 0.30%.
        fee_pips: u32,
        /// Tick spacing for the pool's positions.
        tick_spacing: u16,
        /// Initial sqrt-price (Q64.64) — sets the opening tick.
        sqrt_price: u128,
    },
    /// Create one tick-array account (permissionless, payer-funded — the farm
    /// `InitUserStake` pattern keeps the hot paths free of account creation).
    ///
    /// Accounts: `[pool, tick_array(w), payer(s,w), system_program]`.
    InitTickArray {
        /// Array start tick (aligned to `TICK_ARRAY_SIZE * tick_spacing`).
        start_tick_index: i32,
        /// PDA bump for `[b"tick_array", pool, start_le]`.
        bump: u8,
    },
    /// Create an empty position PDA for `(pool, owner, range)` —
    /// permissionless + payer-funded, owner need not sign.
    ///
    /// Accounts: `[pool, position(w), owner, payer(s,w), system_program]`.
    OpenPosition {
        /// Lower tick bound (spacing-aligned).
        tick_lower: i32,
        /// Upper tick bound (spacing-aligned, > lower).
        tick_upper: i32,
        /// PDA bump for `[b"position", pool, owner, lower_le, upper_le]`.
        bump: u8,
    },
    /// Add liquidity to a position (owner signs; tokens flow owner → vaults).
    ///
    /// Accounts: `[pool(w), position(w), owner(s), owner_ata_0(w),
    /// owner_ata_1(w), vault_0(w), vault_1(w), token_program,
    /// tick_array_lower(w), tick_array_upper(w)]` — the two tick arrays may be
    /// the SAME account when both bounds share an array.
    IncreaseLiquidity {
        /// Liquidity to add (> 0).
        liquidity_delta: u128,
        /// Slippage cap on the token-0 amount paid in.
        amount_0_max: u64,
        /// Slippage cap on the token-1 amount paid in.
        amount_1_max: u64,
    },
    /// Remove liquidity (owner signs; principal flows vaults → owner ATAs;
    /// accrued fees checkpoint into `tokens_owed` for `Collect`). A zero
    /// delta is the fee "poke".
    ///
    /// Accounts: same as `IncreaseLiquidity`.
    DecreaseLiquidity {
        /// Liquidity to remove (0 = poke).
        liquidity_delta: u128,
        /// Slippage floor on the token-0 amount paid out.
        amount_0_min: u64,
        /// Slippage floor on the token-1 amount paid out.
        amount_1_min: u64,
    },
    /// Pay out the position's checkpointed `tokens_owed` (owner signs). Run a
    /// poke (`DecreaseLiquidity` with delta 0) first to refresh fees.
    ///
    /// Accounts: `[pool, position(w), owner(s), owner_ata_0(w),
    /// owner_ata_1(w), vault_0(w), vault_1(w), token_program]`.
    Collect,
    /// Close an empty position (liquidity == 0, owed == 0); rent → owner.
    ///
    /// Accounts: `[position(w), owner(s,w)]`.
    ClosePosition,
    /// Exact-in swap (authority signs over their own token accounts).
    ///
    /// Accounts: `[pool(w), authority(s), user_src(w), user_dst(w),
    /// vault_0(w), vault_1(w), token_program, tick_array_0(w),
    /// tick_array_1(w)?, tick_array_2(w)?]` — 1..=3 DISTINCT tick arrays in
    /// walk order starting at the array containing the current tick.
    Swap {
        /// Direction: true = token0 in / token1 out (price falls).
        zero_for_one: bool,
        /// Exact input amount (before fee).
        amount_in: u64,
        /// Minimum acceptable output (slippage guard).
        min_amount_out: u64,
        /// Price bound; 0 = no bound (band edge for the direction). A partial
        /// fill that stops at the limit is allowed; `min_amount_out` still
        /// applies to the realized output.
        sqrt_price_limit: u128,
    },
}

impl ClmmInstruction {
    /// Parse instruction data.
    pub fn unpack(input: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = input.split_first().ok_or(ClmmError::InvalidInstruction)?;
        Ok(match tag {
            0 => {
                if rest.len() < 23 {
                    return Err(ClmmError::InvalidInstruction.into());
                }
                ClmmInstruction::InitPool {
                    bump: rest[0],
                    fee_pips: u32::from_le_bytes(rest[1..5].try_into().unwrap()),
                    tick_spacing: u16::from_le_bytes(rest[5..7].try_into().unwrap()),
                    sqrt_price: u128::from_le_bytes(rest[7..23].try_into().unwrap()),
                }
            }
            1 => {
                if rest.len() < 5 {
                    return Err(ClmmError::InvalidInstruction.into());
                }
                ClmmInstruction::InitTickArray {
                    start_tick_index: i32::from_le_bytes(rest[0..4].try_into().unwrap()),
                    bump: rest[4],
                }
            }
            2 => {
                if rest.len() < 9 {
                    return Err(ClmmError::InvalidInstruction.into());
                }
                ClmmInstruction::OpenPosition {
                    tick_lower: i32::from_le_bytes(rest[0..4].try_into().unwrap()),
                    tick_upper: i32::from_le_bytes(rest[4..8].try_into().unwrap()),
                    bump: rest[8],
                }
            }
            3 | 4 => {
                if rest.len() < 32 {
                    return Err(ClmmError::InvalidInstruction.into());
                }
                let liquidity_delta = u128::from_le_bytes(rest[0..16].try_into().unwrap());
                let a = u64::from_le_bytes(rest[16..24].try_into().unwrap());
                let b = u64::from_le_bytes(rest[24..32].try_into().unwrap());
                if tag == 3 {
                    ClmmInstruction::IncreaseLiquidity {
                        liquidity_delta,
                        amount_0_max: a,
                        amount_1_max: b,
                    }
                } else {
                    ClmmInstruction::DecreaseLiquidity {
                        liquidity_delta,
                        amount_0_min: a,
                        amount_1_min: b,
                    }
                }
            }
            5 => ClmmInstruction::Collect,
            6 => ClmmInstruction::ClosePosition,
            7 => {
                if rest.len() < 33 {
                    return Err(ClmmError::InvalidInstruction.into());
                }
                let zero_for_one = match rest[0] {
                    0 => false,
                    1 => true,
                    _ => return Err(ClmmError::InvalidInstruction.into()),
                };
                ClmmInstruction::Swap {
                    zero_for_one,
                    amount_in: u64::from_le_bytes(rest[1..9].try_into().unwrap()),
                    min_amount_out: u64::from_le_bytes(rest[9..17].try_into().unwrap()),
                    sqrt_price_limit: u128::from_le_bytes(rest[17..33].try_into().unwrap()),
                }
            }
            _ => return Err(ClmmError::InvalidInstruction.into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_pool_roundtrip() {
        let mut d = vec![0u8, 253];
        d.extend_from_slice(&3000u32.to_le_bytes());
        d.extend_from_slice(&64u16.to_le_bytes());
        d.extend_from_slice(&(1u128 << 64).to_le_bytes());
        assert_eq!(
            ClmmInstruction::unpack(&d).unwrap(),
            ClmmInstruction::InitPool {
                bump: 253,
                fee_pips: 3000,
                tick_spacing: 64,
                sqrt_price: 1 << 64,
            }
        );
    }

    #[test]
    fn init_tick_array_negative_start() {
        let mut d = vec![1u8];
        d.extend_from_slice(&(-5632i32).to_le_bytes());
        d.push(255);
        assert_eq!(
            ClmmInstruction::unpack(&d).unwrap(),
            ClmmInstruction::InitTickArray { start_tick_index: -5632, bump: 255 }
        );
    }

    #[test]
    fn open_position_roundtrip() {
        let mut d = vec![2u8];
        d.extend_from_slice(&(-128i32).to_le_bytes());
        d.extend_from_slice(&128i32.to_le_bytes());
        d.push(254);
        assert_eq!(
            ClmmInstruction::unpack(&d).unwrap(),
            ClmmInstruction::OpenPosition { tick_lower: -128, tick_upper: 128, bump: 254 }
        );
    }

    #[test]
    fn liquidity_tags_share_layout() {
        let mut d = vec![3u8];
        d.extend_from_slice(&(1u128 << 80).to_le_bytes());
        d.extend_from_slice(&111u64.to_le_bytes());
        d.extend_from_slice(&222u64.to_le_bytes());
        assert_eq!(
            ClmmInstruction::unpack(&d).unwrap(),
            ClmmInstruction::IncreaseLiquidity {
                liquidity_delta: 1 << 80,
                amount_0_max: 111,
                amount_1_max: 222,
            }
        );
        d[0] = 4;
        assert_eq!(
            ClmmInstruction::unpack(&d).unwrap(),
            ClmmInstruction::DecreaseLiquidity {
                liquidity_delta: 1 << 80,
                amount_0_min: 111,
                amount_1_min: 222,
            }
        );
    }

    #[test]
    fn swap_roundtrip_and_bad_bool() {
        let mut d = vec![7u8, 1];
        d.extend_from_slice(&1_000_000u64.to_le_bytes());
        d.extend_from_slice(&990_000u64.to_le_bytes());
        d.extend_from_slice(&0u128.to_le_bytes());
        assert_eq!(
            ClmmInstruction::unpack(&d).unwrap(),
            ClmmInstruction::Swap {
                zero_for_one: true,
                amount_in: 1_000_000,
                min_amount_out: 990_000,
                sqrt_price_limit: 0,
            }
        );
        d[1] = 2;
        assert!(ClmmInstruction::unpack(&d).is_err());
    }

    #[test]
    fn simple_tags() {
        assert_eq!(ClmmInstruction::unpack(&[5]).unwrap(), ClmmInstruction::Collect);
        assert_eq!(ClmmInstruction::unpack(&[6]).unwrap(), ClmmInstruction::ClosePosition);
    }

    #[test]
    fn empty_unknown_truncated_rejected() {
        assert!(ClmmInstruction::unpack(&[]).is_err());
        assert!(ClmmInstruction::unpack(&[9]).is_err());
        assert!(ClmmInstruction::unpack(&[0, 1, 2]).is_err());
        assert!(ClmmInstruction::unpack(&[7, 1, 2]).is_err());
    }
}
