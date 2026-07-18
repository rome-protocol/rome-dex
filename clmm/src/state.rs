//! Program state: `Pool`, `Position`, and tick-array accounts, plus the
//! tick-level bookkeeping (`Tick::update` / `Tick::cross`) the swap engine and
//! liquidity instructions rest on.
//!
//! Layouts are fixed-width little-endian (arrayref pack/unpack, orders-program
//! style). Ticks live in fixed-size TICK ARRAYS of [`TICK_ARRAY_SIZE`] spacing-
//! aligned slots — PDA `[b"tick_array", pool, start_tick_index_le]` — accessed
//! in place through byte offsets ([`get_tick`] / [`set_tick`]) so the exact
//! same code path runs on host tests and on-chain. A tick is *initialized* iff
//! `liquidity_gross != 0`; there is no separate flag.

use {
    crate::{
        curve::{
            fee_math::{fee_growth_inside, fees_owed},
            liquidity_math::add_liquidity_delta,
            tick_math::{MAX_TICK, MIN_TICK},
        },
        error::ClmmError,
    },
    arrayref::{array_mut_ref, array_ref, array_refs, mut_array_refs},
    solana_program::{program_error::ProgramError, pubkey::Pubkey},
};

/// PDA seed prefix for a pool: `[b"pool", mint_0, mint_1, fee_pips_le]`.
pub const POOL_SEED: &[u8] = b"pool";
/// PDA seed prefix for a tick array: `[b"tick_array", pool, start_tick_index_le]`.
pub const TICK_ARRAY_SEED: &[u8] = b"tick_array";
/// PDA seed prefix for a position: `[b"position", pool, owner, lower_le, upper_le]`.
pub const POSITION_SEED: &[u8] = b"position";

/// Serialized length of a [`Pool`] account.
pub const POOL_LEN: usize = 204;
/// Serialized length of a [`Position`] account.
pub const POSITION_LEN: usize = 138;
/// Serialized length of one [`Tick`] inside a tick array.
pub const TICK_LEN: usize = 64;
/// Spacing-aligned tick slots per tick array (Orca geometry).
pub const TICK_ARRAY_SIZE: usize = 88;
/// Header bytes of a tick-array account before the tick slots.
pub const TICK_ARRAY_HEADER_LEN: usize = 38;
/// Serialized length of a tick-array account.
pub const TICK_ARRAY_LEN: usize = TICK_ARRAY_HEADER_LEN + TICK_ARRAY_SIZE * TICK_LEN;

/// A concentrated-liquidity pool over an ordered SPL mint pair
/// (`mint_0 < mint_1`; price = token1/token0). The pool PDA owns both vaults
/// and signs vault transfers via `invoke_signed`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pool {
    /// Whether this account has been initialized.
    pub is_initialized: bool,
    /// Bump for the pool PDA `[b"pool", mint_0, mint_1, fee_pips_le]`.
    pub bump: u8,
    /// Token-0 mint (base). Canonically `mint_0 < mint_1`.
    pub mint_0: Pubkey,
    /// Token-1 mint (quote).
    pub mint_1: Pubkey,
    /// Token-0 vault — the pool PDA's ATA for `mint_0`.
    pub vault_0: Pubkey,
    /// Token-1 vault — the pool PDA's ATA for `mint_1`.
    pub vault_1: Pubkey,
    /// Swap fee in pips (1e-6), Uniswap-V3 style.
    pub fee_pips: u32,
    /// Tick spacing — positions and initialized ticks align to it.
    pub tick_spacing: u16,
    /// Current tick (largest tick with `sqrt_price(tick) <= sqrt_price`).
    pub current_tick: i32,
    /// Current sqrt-price, Q64.64.
    pub sqrt_price: u128,
    /// Liquidity in range at the current price.
    pub liquidity: u128,
    /// All-time fee growth per unit liquidity, token 0 (Q64.64, wrapping).
    pub fee_growth_global_0: u128,
    /// All-time fee growth per unit liquidity, token 1 (Q64.64, wrapping).
    pub fee_growth_global_1: u128,
}

impl Pool {
    /// Unpack from a byte slice.
    pub fn unpack(input: &[u8]) -> Result<Pool, ProgramError> {
        if input.len() < POOL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let input = array_ref![input, 0, POOL_LEN];
        let (
            is_initialized,
            bump,
            mint_0,
            mint_1,
            vault_0,
            vault_1,
            fee_pips,
            tick_spacing,
            current_tick,
            sqrt_price,
            liquidity,
            fee_growth_global_0,
            fee_growth_global_1,
        ) = array_refs![input, 1, 1, 32, 32, 32, 32, 4, 2, 4, 16, 16, 16, 16];
        Ok(Pool {
            is_initialized: unpack_bool(is_initialized[0])?,
            bump: bump[0],
            mint_0: Pubkey::new_from_array(*mint_0),
            mint_1: Pubkey::new_from_array(*mint_1),
            vault_0: Pubkey::new_from_array(*vault_0),
            vault_1: Pubkey::new_from_array(*vault_1),
            fee_pips: u32::from_le_bytes(*fee_pips),
            tick_spacing: u16::from_le_bytes(*tick_spacing),
            current_tick: i32::from_le_bytes(*current_tick),
            sqrt_price: u128::from_le_bytes(*sqrt_price),
            liquidity: u128::from_le_bytes(*liquidity),
            fee_growth_global_0: u128::from_le_bytes(*fee_growth_global_0),
            fee_growth_global_1: u128::from_le_bytes(*fee_growth_global_1),
        })
    }

    /// Pack into a byte slice.
    pub fn pack(&self, output: &mut [u8]) {
        let output = array_mut_ref![output, 0, POOL_LEN];
        let (
            is_initialized,
            bump,
            mint_0,
            mint_1,
            vault_0,
            vault_1,
            fee_pips,
            tick_spacing,
            current_tick,
            sqrt_price,
            liquidity,
            fee_growth_global_0,
            fee_growth_global_1,
        ) = mut_array_refs![output, 1, 1, 32, 32, 32, 32, 4, 2, 4, 16, 16, 16, 16];
        is_initialized[0] = self.is_initialized as u8;
        bump[0] = self.bump;
        mint_0.copy_from_slice(self.mint_0.as_ref());
        mint_1.copy_from_slice(self.mint_1.as_ref());
        vault_0.copy_from_slice(self.vault_0.as_ref());
        vault_1.copy_from_slice(self.vault_1.as_ref());
        *fee_pips = self.fee_pips.to_le_bytes();
        *tick_spacing = self.tick_spacing.to_le_bytes();
        *current_tick = self.current_tick.to_le_bytes();
        *sqrt_price = self.sqrt_price.to_le_bytes();
        *liquidity = self.liquidity.to_le_bytes();
        *fee_growth_global_0 = self.fee_growth_global_0.to_le_bytes();
        *fee_growth_global_1 = self.fee_growth_global_1.to_le_bytes();
    }
}

fn unpack_bool(b: u8) -> Result<bool, ProgramError> {
    match b {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(ProgramError::InvalidAccountData),
    }
}

/// One LP's liquidity over `[tick_lower, tick_upper]` — a PDA
/// `[b"position", pool, owner, lower_le, upper_le]`, NOT an NFT (an NFT mint
/// needs an ephemeral signer Rome's CPI precompile can't auto-sign).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Position {
    /// Whether this account has been initialized.
    pub is_initialized: bool,
    /// Bump for the position PDA.
    pub bump: u8,
    /// The pool this position provides to.
    pub pool: Pubkey,
    /// Owner: a Solana wallet pubkey OR an EVM user's `external_auth` PDA.
    pub owner: Pubkey,
    /// Lower tick bound (spacing-aligned).
    pub tick_lower: i32,
    /// Upper tick bound (spacing-aligned, > lower).
    pub tick_upper: i32,
    /// Liquidity currently provided.
    pub liquidity: u128,
    /// `fee_growth_inside` (token 0) at the last fee checkpoint (wrapping).
    pub fee_growth_inside_0_last: u128,
    /// `fee_growth_inside` (token 1) at the last fee checkpoint (wrapping).
    pub fee_growth_inside_1_last: u128,
    /// Collectable token-0 fees (and withdrawn principal is paid directly).
    pub tokens_owed_0: u64,
    /// Collectable token-1 fees.
    pub tokens_owed_1: u64,
}

impl Position {
    /// Unpack from a byte slice.
    pub fn unpack(input: &[u8]) -> Result<Position, ProgramError> {
        if input.len() < POSITION_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let input = array_ref![input, 0, POSITION_LEN];
        let (
            is_initialized,
            bump,
            pool,
            owner,
            tick_lower,
            tick_upper,
            liquidity,
            fee_growth_inside_0_last,
            fee_growth_inside_1_last,
            tokens_owed_0,
            tokens_owed_1,
        ) = array_refs![input, 1, 1, 32, 32, 4, 4, 16, 16, 16, 8, 8];
        Ok(Position {
            is_initialized: unpack_bool(is_initialized[0])?,
            bump: bump[0],
            pool: Pubkey::new_from_array(*pool),
            owner: Pubkey::new_from_array(*owner),
            tick_lower: i32::from_le_bytes(*tick_lower),
            tick_upper: i32::from_le_bytes(*tick_upper),
            liquidity: u128::from_le_bytes(*liquidity),
            fee_growth_inside_0_last: u128::from_le_bytes(*fee_growth_inside_0_last),
            fee_growth_inside_1_last: u128::from_le_bytes(*fee_growth_inside_1_last),
            tokens_owed_0: u64::from_le_bytes(*tokens_owed_0),
            tokens_owed_1: u64::from_le_bytes(*tokens_owed_1),
        })
    }

    /// Pack into a byte slice.
    pub fn pack(&self, output: &mut [u8]) {
        let output = array_mut_ref![output, 0, POSITION_LEN];
        let (
            is_initialized,
            bump,
            pool,
            owner,
            tick_lower,
            tick_upper,
            liquidity,
            fee_growth_inside_0_last,
            fee_growth_inside_1_last,
            tokens_owed_0,
            tokens_owed_1,
        ) = mut_array_refs![output, 1, 1, 32, 32, 4, 4, 16, 16, 16, 8, 8];
        is_initialized[0] = self.is_initialized as u8;
        bump[0] = self.bump;
        pool.copy_from_slice(self.pool.as_ref());
        owner.copy_from_slice(self.owner.as_ref());
        *tick_lower = self.tick_lower.to_le_bytes();
        *tick_upper = self.tick_upper.to_le_bytes();
        *liquidity = self.liquidity.to_le_bytes();
        *fee_growth_inside_0_last = self.fee_growth_inside_0_last.to_le_bytes();
        *fee_growth_inside_1_last = self.fee_growth_inside_1_last.to_le_bytes();
        *tokens_owed_0 = self.tokens_owed_0.to_le_bytes();
        *tokens_owed_1 = self.tokens_owed_1.to_le_bytes();
    }

    /// Accrue fees owed since the last checkpoint from the CURRENT
    /// `fee_growth_inside` values, then re-checkpoint. Errors (rather than
    /// silently capping) if owed overflows u64 — collect first.
    pub fn update_fees(&mut self, inside_0: u128, inside_1: u128) -> Result<(), ClmmError> {
        let owed_0 = fees_owed(self.liquidity, inside_0, self.fee_growth_inside_0_last)?;
        let owed_1 = fees_owed(self.liquidity, inside_1, self.fee_growth_inside_1_last)?;
        let owed_0 = u64::try_from(owed_0).map_err(|_| ClmmError::MathOverflow)?;
        let owed_1 = u64::try_from(owed_1).map_err(|_| ClmmError::MathOverflow)?;
        self.tokens_owed_0 = self
            .tokens_owed_0
            .checked_add(owed_0)
            .ok_or(ClmmError::MathOverflow)?;
        self.tokens_owed_1 = self
            .tokens_owed_1
            .checked_add(owed_1)
            .ok_or(ClmmError::MathOverflow)?;
        self.fee_growth_inside_0_last = inside_0;
        self.fee_growth_inside_1_last = inside_1;
        Ok(())
    }
}

/// Per-tick bookkeeping stored in a tick-array slot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tick {
    /// Total liquidity referencing this tick (sum over positions).
    pub liquidity_gross: u128,
    /// Net liquidity added when the tick is crossed left→right.
    pub liquidity_net: i128,
    /// Fee growth (token 0) on the far side of this tick (wrapping).
    pub fee_growth_outside_0: u128,
    /// Fee growth (token 1) on the far side of this tick (wrapping).
    pub fee_growth_outside_1: u128,
}

impl Tick {
    /// A tick is initialized iff any position references it.
    pub fn is_initialized(&self) -> bool {
        self.liquidity_gross != 0
    }

    /// Apply a position's `liquidity_delta` to this tick (`is_upper` selects
    /// the net sign). Returns whether the tick flipped initialized ⇄ empty.
    /// On first initialization, `fee_growth_outside` is seeded with the global
    /// values iff `tick_index <= current_tick` (UV3 convention: all past
    /// growth is assumed below the tick).
    pub fn update(
        &mut self,
        liquidity_delta: i128,
        is_upper: bool,
        tick_index: i32,
        current_tick: i32,
        fee_growth_global_0: u128,
        fee_growth_global_1: u128,
    ) -> Result<bool, ClmmError> {
        let gross_before = self.liquidity_gross;
        let gross_after = add_liquidity_delta(gross_before, liquidity_delta)?;
        if gross_before == 0 && tick_index <= current_tick {
            // UV3 convention: all past growth is assumed to have happened
            // below (at-or-left-of) the tick being initialized.
            self.fee_growth_outside_0 = fee_growth_global_0;
            self.fee_growth_outside_1 = fee_growth_global_1;
        }
        self.liquidity_gross = gross_after;
        self.liquidity_net = if is_upper {
            self.liquidity_net.checked_sub(liquidity_delta)
        } else {
            self.liquidity_net.checked_add(liquidity_delta)
        }
        .ok_or(ClmmError::MathOverflow)?;
        // NOTE: a tick that flips empty is NOT cleared here. `fee_growth_outside`
        // must survive until the CALLER has snapshotted the position's fees from
        // it — clearing a dead tick's outside before the snapshot over-credits
        // the removing position (audit CRITICAL). The caller clears a flipped-
        // empty tick AFTER `update_fees` (see [`crate::engine::modify_position`],
        // UV3 clear-after ordering). `clear` does the zeroing.
        Ok((gross_after == 0) != (gross_before == 0))
    }

    /// Zero a dead tick's `fee_growth_outside` so a later re-initialization
    /// starts clean. MUST be called only AFTER any position that references
    /// this tick has snapshotted its fees (UV3 clear-after ordering) — clearing
    /// earlier over-credits the removing position (audit CRITICAL).
    pub fn clear(&mut self) {
        self.fee_growth_outside_0 = 0;
        self.fee_growth_outside_1 = 0;
    }

    /// Cross this tick during a swap: flip `fee_growth_outside` to the other
    /// side and return `liquidity_net` (caller applies it sign-adjusted for
    /// the crossing direction).
    pub fn cross(&mut self, fee_growth_global_0: u128, fee_growth_global_1: u128) -> i128 {
        self.fee_growth_outside_0 = fee_growth_global_0.wrapping_sub(self.fee_growth_outside_0);
        self.fee_growth_outside_1 = fee_growth_global_1.wrapping_sub(self.fee_growth_outside_1);
        self.liquidity_net
    }

    /// Unpack one tick from a TICK_LEN slice.
    pub fn unpack(input: &[u8]) -> Tick {
        let input = array_ref![input, 0, TICK_LEN];
        let (liquidity_gross, liquidity_net, fee_growth_outside_0, fee_growth_outside_1) =
            array_refs![input, 16, 16, 16, 16];
        Tick {
            liquidity_gross: u128::from_le_bytes(*liquidity_gross),
            liquidity_net: i128::from_le_bytes(*liquidity_net),
            fee_growth_outside_0: u128::from_le_bytes(*fee_growth_outside_0),
            fee_growth_outside_1: u128::from_le_bytes(*fee_growth_outside_1),
        }
    }

    /// Pack into a TICK_LEN slice.
    pub fn pack(&self, output: &mut [u8]) {
        let output = array_mut_ref![output, 0, TICK_LEN];
        let (liquidity_gross, liquidity_net, fee_growth_outside_0, fee_growth_outside_1) =
            mut_array_refs![output, 16, 16, 16, 16];
        *liquidity_gross = self.liquidity_gross.to_le_bytes();
        *liquidity_net = self.liquidity_net.to_le_bytes();
        *fee_growth_outside_0 = self.fee_growth_outside_0.to_le_bytes();
        *fee_growth_outside_1 = self.fee_growth_outside_1.to_le_bytes();
    }
}

/// `fee_growth_inside` for a position's range given its two boundary ticks.
pub fn fee_growth_inside_from_ticks(
    lower: &Tick,
    upper: &Tick,
    tick_lower: i32,
    tick_upper: i32,
    current_tick: i32,
    fee_growth_global_0: u128,
    fee_growth_global_1: u128,
) -> (u128, u128) {
    (
        fee_growth_inside(
            tick_lower,
            tick_upper,
            current_tick,
            fee_growth_global_0,
            lower.fee_growth_outside_0,
            upper.fee_growth_outside_0,
        ),
        fee_growth_inside(
            tick_lower,
            tick_upper,
            current_tick,
            fee_growth_global_1,
            lower.fee_growth_outside_1,
            upper.fee_growth_outside_1,
        ),
    )
}

/// Is `tick` a valid, spacing-aligned tick bound?
pub fn check_tick(tick: i32, tick_spacing: u16) -> Result<(), ClmmError> {
    if !(MIN_TICK..=MAX_TICK).contains(&tick) {
        return Err(ClmmError::TickOutOfBounds);
    }
    if tick % tick_spacing as i32 != 0 {
        return Err(ClmmError::InvalidTickRange);
    }
    Ok(())
}

/// Start index of the tick array containing `tick` (floor-aligned to
/// `TICK_ARRAY_SIZE · tick_spacing`). Computed in i64 so an adversarial
/// out-of-band `tick` (e.g. near `i32::MIN`, possible via unvalidated
/// instruction data) can't overflow the multiply; the result is only ever
/// used where an out-of-band start subsequently fails validation.
pub fn tick_array_start_index(tick: i32, tick_spacing: u16) -> i32 {
    let span = TICK_ARRAY_SIZE as i64 * tick_spacing as i64;
    let start = (tick as i64).div_euclid(span) * span;
    start.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// Byte offset of `tick`'s slot inside a tick-array account's data. Errors if
/// `tick` is misaligned or outside the array's window.
pub fn tick_offset(start_tick_index: i32, tick_spacing: u16, tick: i32) -> Result<usize, ClmmError> {
    let spacing = tick_spacing as i32;
    let rel = tick - start_tick_index;
    if rel % spacing != 0 {
        return Err(ClmmError::InvalidTickRange);
    }
    let slot = rel / spacing;
    if !(0..TICK_ARRAY_SIZE as i32).contains(&slot) {
        return Err(ClmmError::TickOutOfBounds);
    }
    Ok(TICK_ARRAY_HEADER_LEN + slot as usize * TICK_LEN)
}

/// Read `tick` from a tick-array account's full data.
pub fn get_tick(data: &[u8], start_tick_index: i32, tick_spacing: u16, tick: i32) -> Result<Tick, ClmmError> {
    let off = tick_offset(start_tick_index, tick_spacing, tick)?;
    Ok(Tick::unpack(&data[off..off + TICK_LEN]))
}

/// Write `tick` into a tick-array account's full data.
pub fn set_tick(
    data: &mut [u8],
    start_tick_index: i32,
    tick_spacing: u16,
    tick: i32,
    value: &Tick,
) -> Result<(), ClmmError> {
    let off = tick_offset(start_tick_index, tick_spacing, tick)?;
    value.pack(&mut data[off..off + TICK_LEN]);
    Ok(())
}

/// Pack a tick-array header (`is_initialized=1`, bump, pool, start index).
pub fn pack_tick_array_header(data: &mut [u8], bump: u8, pool: &Pubkey, start_tick_index: i32) {
    let header = array_mut_ref![data, 0, TICK_ARRAY_HEADER_LEN];
    let (is_initialized, bump_out, pool_out, start) = mut_array_refs![header, 1, 1, 32, 4];
    is_initialized[0] = 1;
    bump_out[0] = bump;
    pool_out.copy_from_slice(pool.as_ref());
    *start = start_tick_index.to_le_bytes();
}

/// Unpack + validate a tick-array header; returns `(bump, pool, start_tick_index)`.
pub fn unpack_tick_array_header(data: &[u8]) -> Result<(u8, Pubkey, i32), ProgramError> {
    if data.len() < TICK_ARRAY_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let header = array_ref![data, 0, TICK_ARRAY_HEADER_LEN];
    let (is_initialized, bump, pool, start) = array_refs![header, 1, 1, 32, 4];
    if !unpack_bool(is_initialized[0])? {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok((
        bump[0],
        Pubkey::new_from_array(*pool),
        i32::from_le_bytes(*start),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_pool() -> Pool {
        Pool {
            is_initialized: true,
            bump: 252,
            mint_0: Pubkey::new_unique(),
            mint_1: Pubkey::new_unique(),
            vault_0: Pubkey::new_unique(),
            vault_1: Pubkey::new_unique(),
            fee_pips: 3000,
            tick_spacing: 64,
            current_tick: -7,
            sqrt_price: 18446744073709551616,
            liquidity: 123456789012345678901234567890,
            fee_growth_global_0: u128::MAX - 5,
            fee_growth_global_1: 42,
        }
    }

    fn sample_position() -> Position {
        Position {
            is_initialized: true,
            bump: 254,
            pool: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            tick_lower: -1280,
            tick_upper: 1280,
            liquidity: 5_000_000_000,
            fee_growth_inside_0_last: 1 << 70,
            fee_growth_inside_1_last: u128::MAX - 1,
            tokens_owed_0: 17,
            tokens_owed_1: 0,
        }
    }

    #[test]
    fn pool_pack_roundtrip() {
        let p = sample_pool();
        let mut buf = [0u8; POOL_LEN];
        p.pack(&mut buf);
        assert_eq!(Pool::unpack(&buf).unwrap(), p);
    }

    #[test]
    fn pool_rejects_bad_init_flag() {
        let p = sample_pool();
        let mut buf = [0u8; POOL_LEN];
        p.pack(&mut buf);
        buf[0] = 2;
        assert!(Pool::unpack(&buf).is_err());
    }

    #[test]
    fn position_pack_roundtrip() {
        let p = sample_position();
        let mut buf = [0u8; POSITION_LEN];
        p.pack(&mut buf);
        assert_eq!(Position::unpack(&buf).unwrap(), p);
    }

    #[test]
    fn tick_pack_roundtrip_negative_net() {
        let t = Tick {
            liquidity_gross: 999,
            liquidity_net: -12345678901234567890i128,
            fee_growth_outside_0: u128::MAX,
            fee_growth_outside_1: 1,
        };
        let mut buf = [0u8; TICK_LEN];
        t.pack(&mut buf);
        assert_eq!(Tick::unpack(&buf), t);
    }

    // ── tick array geometry ─────────────────────────────────────────────────

    #[test]
    fn start_index_floor_aligns_negatives() {
        // span = 88 * 64 = 5632
        assert_eq!(tick_array_start_index(0, 64), 0);
        assert_eq!(tick_array_start_index(5631, 64), 0);
        assert_eq!(tick_array_start_index(5632, 64), 5632);
        assert_eq!(tick_array_start_index(-1, 64), -5632);
        assert_eq!(tick_array_start_index(-5632, 64), -5632);
        assert_eq!(tick_array_start_index(-5633, 64), -11264);
    }

    #[test]
    fn check_tick_alignment_and_bounds() {
        assert!(check_tick(128, 64).is_ok());
        assert!(check_tick(-128, 64).is_ok());
        assert_eq!(check_tick(65, 64), Err(ClmmError::InvalidTickRange));
        assert_eq!(check_tick(-65, 64), Err(ClmmError::InvalidTickRange));
        assert_eq!(check_tick(MAX_TICK + 1, 1), Err(ClmmError::TickOutOfBounds));
        assert_eq!(check_tick(MIN_TICK - 1, 1), Err(ClmmError::TickOutOfBounds));
    }

    #[test]
    fn tick_offset_within_window() {
        // window [5632, 5632 + 88*64)
        assert_eq!(tick_offset(5632, 64, 5632).unwrap(), TICK_ARRAY_HEADER_LEN);
        assert_eq!(
            tick_offset(5632, 64, 5632 + 64).unwrap(),
            TICK_ARRAY_HEADER_LEN + TICK_LEN
        );
        assert_eq!(
            tick_offset(5632, 64, 5632 + 87 * 64).unwrap(),
            TICK_ARRAY_HEADER_LEN + 87 * TICK_LEN
        );
        // misaligned
        assert!(tick_offset(5632, 64, 5633).is_err());
        // outside window (one past the last slot)
        assert!(tick_offset(5632, 64, 5632 + 88 * 64).is_err());
        // below window
        assert!(tick_offset(5632, 64, 5632 - 64).is_err());
    }

    #[test]
    fn get_set_tick_in_account_data() {
        let mut data = vec![0u8; TICK_ARRAY_LEN];
        let start = -5632;
        let t = Tick {
            liquidity_gross: 7,
            liquidity_net: -7,
            fee_growth_outside_0: 3,
            fee_growth_outside_1: 4,
        };
        set_tick(&mut data, start, 64, -64, &t).unwrap();
        assert_eq!(get_tick(&data, start, 64, -64).unwrap(), t);
        // untouched slots stay default
        assert_eq!(get_tick(&data, start, 64, -128).unwrap(), Tick::default());
    }

    #[test]
    fn tick_array_header_roundtrip() {
        let mut data = vec![0u8; TICK_ARRAY_LEN];
        let pool = Pubkey::new_unique();
        pack_tick_array_header(&mut data, 251, &pool, -11264);
        let (bump, got_pool, start) = unpack_tick_array_header(&data).unwrap();
        assert_eq!((bump, got_pool, start), (251, pool, -11264));
    }

    #[test]
    fn tick_array_header_uninitialized_rejected() {
        let data = vec![0u8; TICK_ARRAY_LEN];
        assert!(unpack_tick_array_header(&data).is_err());
    }

    // ── tick update / cross semantics (UV3) ────────────────────────────────

    #[test]
    fn update_seeds_outside_growth_iff_at_or_below_current() {
        // tick <= current_tick → outside seeded with global on first init.
        let mut t = Tick::default();
        let flipped = t.update(100, false, -64, 0, 111, 222).unwrap();
        assert!(flipped, "0 → nonzero flips");
        assert_eq!(t.fee_growth_outside_0, 111);
        assert_eq!(t.fee_growth_outside_1, 222);

        // tick > current_tick → outside stays 0.
        let mut t = Tick::default();
        t.update(100, true, 64, 0, 111, 222).unwrap();
        assert_eq!(t.fee_growth_outside_0, 0);
        assert_eq!(t.fee_growth_outside_1, 0);
    }

    #[test]
    fn update_does_not_reseed_when_already_initialized() {
        let mut t = Tick::default();
        t.update(100, false, -64, 0, 111, 222).unwrap();
        // second position on the same tick: outside must NOT re-seed.
        let flipped = t.update(50, false, -64, 0, 999, 999).unwrap();
        assert!(!flipped, "nonzero → nonzero does not flip");
        assert_eq!(t.fee_growth_outside_0, 111);
        assert_eq!(t.liquidity_gross, 150);
    }

    #[test]
    fn update_net_sign_lower_adds_upper_subtracts() {
        let mut t = Tick::default();
        t.update(100, false, 0, 0, 0, 0).unwrap(); // lower bound
        assert_eq!(t.liquidity_net, 100);
        let mut t = Tick::default();
        t.update(100, true, 0, 0, 0, 0).unwrap(); // upper bound
        assert_eq!(t.liquidity_net, -100);
    }

    #[test]
    fn update_flip_to_empty_on_full_removal() {
        let mut t = Tick::default();
        t.update(100, false, 0, 0, 0, 0).unwrap();
        let flipped = t.update(-100, false, 0, 0, 0, 0).unwrap();
        assert!(flipped, "nonzero → 0 flips");
        assert!(!t.is_initialized());
        assert_eq!(t.liquidity_net, 0);
    }

    #[test]
    fn flip_to_empty_does_not_clear_outside_growth_in_update() {
        // Tick::update must NOT clear a flipped-empty tick's outside growth —
        // the removing position still needs to snapshot its fees from these
        // values. Clearing is done by the caller AFTER the snapshot (see
        // engine::modify_position, UV3 clear-after). Clearing here would
        // over-credit the removal (audit CRITICAL).
        let mut t = Tick::default();
        t.update(100, false, -64, 0, 111, 222).unwrap(); // seeded (111, 222)
        let flipped = t.update(-100, false, -64, 0, 500, 600).unwrap(); // flips to empty
        assert!(flipped, "nonzero → 0 flips");
        assert!(!t.is_initialized());
        assert_eq!(t.fee_growth_outside_0, 111, "outside RETAINED until caller clears");
        assert_eq!(t.fee_growth_outside_1, 222);
        // The explicit clear zeroes it (what modify_position calls post-snapshot).
        t.clear();
        assert_eq!(t.fee_growth_outside_0, 0);
        assert_eq!(t.fee_growth_outside_1, 0);
    }

    #[test]
    fn update_rejects_removing_more_than_gross() {
        let mut t = Tick::default();
        t.update(100, false, 0, 0, 0, 0).unwrap();
        assert!(t.update(-101, false, 0, 0, 0, 0).is_err());
    }

    #[test]
    fn cross_flips_outside_and_returns_net() {
        let mut t = Tick::default();
        t.update(100, false, -64, 0, 40, 60).unwrap(); // seeded outside = (40, 60)
        let net = t.cross(100, 200);
        assert_eq!(net, 100);
        assert_eq!(t.fee_growth_outside_0, 60, "global - outside");
        assert_eq!(t.fee_growth_outside_1, 140);
        // crossing back restores the original values.
        t.cross(100, 200);
        assert_eq!(t.fee_growth_outside_0, 40);
        assert_eq!(t.fee_growth_outside_1, 60);
    }

    // ── position fee accrual ────────────────────────────────────────────────

    #[test]
    fn position_update_fees_accrues_and_checkpoints() {
        let mut p = sample_position();
        p.liquidity = 50;
        p.fee_growth_inside_0_last = 0;
        p.fee_growth_inside_1_last = 0;
        p.tokens_owed_0 = 0;
        p.tokens_owed_1 = 0;
        // Δinside_0 = 2.0/liq → owed_0 = 100; Δinside_1 = 0.5/liq → owed_1 = 25.
        p.update_fees(2 << 64, 1 << 63).unwrap();
        assert_eq!(p.tokens_owed_0, 100);
        assert_eq!(p.tokens_owed_1, 25);
        assert_eq!(p.fee_growth_inside_0_last, 2 << 64);
        assert_eq!(p.fee_growth_inside_1_last, 1 << 63);
        // idempotent at the same growth: no double-accrual.
        p.update_fees(2 << 64, 1 << 63).unwrap();
        assert_eq!(p.tokens_owed_0, 100);
        assert_eq!(p.tokens_owed_1, 25);
    }

    #[test]
    fn position_update_fees_errors_on_owed_overflow() {
        let mut p = sample_position();
        p.liquidity = u64::MAX as u128;
        p.tokens_owed_0 = u64::MAX;
        p.fee_growth_inside_0_last = 0;
        p.fee_growth_inside_1_last = 0;
        assert!(p.update_fees(1 << 64, 0).is_err());
    }

    #[test]
    fn fee_growth_inside_from_ticks_matches_fee_math() {
        // In-range, growth accrued outside both bounds is excluded.
        let lower = Tick { fee_growth_outside_0: 300, ..Tick::default() };
        let upper = Tick { fee_growth_outside_0: 200, ..Tick::default() };
        let (in0, in1) =
            fee_growth_inside_from_ticks(&lower, &upper, -100, 100, 0, 1000, 0);
        assert_eq!(in0, 500);
        assert_eq!(in1, 0);
    }
}
