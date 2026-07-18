//! Farm + user-stake account state, with manual byte packing (arrayref).

use {
    crate::error::FarmError,
    arrayref::{array_mut_ref, array_ref, array_refs, mut_array_refs},
    solana_program::{program_error::ProgramError, pubkey::Pubkey},
};

/// Fixed-point precision for `acc_reward_per_share` (1e12).
pub const ACC_PRECISION: u128 = 1_000_000_000_000;

/// Serialized length of a [`Farm`] account.
pub const FARM_LEN: usize = 202;
/// Serialized length of a [`UserStake`] account.
pub const USER_STAKE_LEN: usize = 33;

/// A liquidity-mining farm: stake `lp_mint`, earn `reward_mint` over time.
///
/// Emission accrues via the MasterChef accumulator: `acc_reward_per_share`
/// tracks cumulative reward per staked unit (scaled by [`ACC_PRECISION`]), so a
/// user's pending reward is `amount * acc / PREC - reward_debt`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Farm {
    /// Whether this account has been initialized.
    pub is_initialized: bool,
    /// Bump for the farm authority PDA (`[farm]`), which owns `lp_vault` and is
    /// the `reward_mint` mint authority.
    pub bump_seed: u8,
    /// Operator allowed to tune `reward_per_second`.
    pub owner: Pubkey,
    /// Staked LP mint (a rome-dex pool mint).
    pub lp_mint: Pubkey,
    /// Reward mint (minted to stakers on claim).
    pub reward_mint: Pubkey,
    /// Token account (owned by the farm authority PDA) holding staked LP.
    pub lp_vault: Pubkey,
    /// SPL token program id.
    pub token_program: Pubkey,
    /// Emission rate in reward base units per second.
    pub reward_per_second: u64,
    /// Unix timestamp of the last accumulator update.
    pub last_update_ts: i64,
    /// Accumulated reward per staked unit, scaled by [`ACC_PRECISION`].
    pub acc_reward_per_share: u128,
    /// Total LP currently staked.
    pub total_staked: u64,
}

impl Farm {
    /// Unpack from a byte slice.
    pub fn unpack(input: &[u8]) -> Result<Farm, ProgramError> {
        let input = array_ref![input, 0, FARM_LEN];
        let (
            is_initialized,
            bump_seed,
            owner,
            lp_mint,
            reward_mint,
            lp_vault,
            token_program,
            reward_per_second,
            last_update_ts,
            acc_reward_per_share,
            total_staked,
        ) = array_refs![input, 1, 1, 32, 32, 32, 32, 32, 8, 8, 16, 8];
        Ok(Farm {
            is_initialized: match is_initialized[0] {
                0 => false,
                1 => true,
                _ => return Err(ProgramError::InvalidAccountData),
            },
            bump_seed: bump_seed[0],
            owner: Pubkey::new_from_array(*owner),
            lp_mint: Pubkey::new_from_array(*lp_mint),
            reward_mint: Pubkey::new_from_array(*reward_mint),
            lp_vault: Pubkey::new_from_array(*lp_vault),
            token_program: Pubkey::new_from_array(*token_program),
            reward_per_second: u64::from_le_bytes(*reward_per_second),
            last_update_ts: i64::from_le_bytes(*last_update_ts),
            acc_reward_per_share: u128::from_le_bytes(*acc_reward_per_share),
            total_staked: u64::from_le_bytes(*total_staked),
        })
    }

    /// Pack into a byte slice.
    pub fn pack(&self, output: &mut [u8]) {
        let output = array_mut_ref![output, 0, FARM_LEN];
        let (
            is_initialized,
            bump_seed,
            owner,
            lp_mint,
            reward_mint,
            lp_vault,
            token_program,
            reward_per_second,
            last_update_ts,
            acc_reward_per_share,
            total_staked,
        ) = mut_array_refs![output, 1, 1, 32, 32, 32, 32, 32, 8, 8, 16, 8];
        is_initialized[0] = self.is_initialized as u8;
        bump_seed[0] = self.bump_seed;
        owner.copy_from_slice(self.owner.as_ref());
        lp_mint.copy_from_slice(self.lp_mint.as_ref());
        reward_mint.copy_from_slice(self.reward_mint.as_ref());
        lp_vault.copy_from_slice(self.lp_vault.as_ref());
        token_program.copy_from_slice(self.token_program.as_ref());
        *reward_per_second = self.reward_per_second.to_le_bytes();
        *last_update_ts = self.last_update_ts.to_le_bytes();
        *acc_reward_per_share = self.acc_reward_per_share.to_le_bytes();
        *total_staked = self.total_staked.to_le_bytes();
    }

    /// Advance the accumulator to `now`. Idempotent for `now <= last_update_ts`.
    pub fn accrue(&mut self, now: i64) -> Result<(), FarmError> {
        if now <= self.last_update_ts {
            return Ok(());
        }
        if self.total_staked > 0 && self.reward_per_second > 0 {
            let elapsed = (now - self.last_update_ts) as u128;
            let reward = elapsed
                .checked_mul(self.reward_per_second as u128)
                .ok_or(FarmError::Overflow)?
                .checked_mul(ACC_PRECISION)
                .ok_or(FarmError::Overflow)?;
            let per_share = reward / self.total_staked as u128;
            self.acc_reward_per_share = self
                .acc_reward_per_share
                .checked_add(per_share)
                .ok_or(FarmError::Overflow)?;
        }
        self.last_update_ts = now;
        Ok(())
    }
}

/// Per-(farm, authority) staking position.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UserStake {
    /// Whether this account has been initialized.
    pub is_initialized: bool,
    /// LP staked by this authority.
    pub amount: u64,
    /// `amount * acc_reward_per_share / PREC` snapshot at the last settlement.
    pub reward_debt: u128,
    /// Reward accrued but not yet minted (harvested on claim).
    pub reward_pending: u64,
}

impl UserStake {
    /// Unpack from a byte slice.
    pub fn unpack(input: &[u8]) -> Result<UserStake, ProgramError> {
        let input = array_ref![input, 0, USER_STAKE_LEN];
        let (is_initialized, amount, reward_debt, reward_pending) = array_refs![input, 1, 8, 16, 8];
        Ok(UserStake {
            is_initialized: match is_initialized[0] {
                0 => false,
                1 => true,
                _ => return Err(ProgramError::InvalidAccountData),
            },
            amount: u64::from_le_bytes(*amount),
            reward_debt: u128::from_le_bytes(*reward_debt),
            reward_pending: u64::from_le_bytes(*reward_pending),
        })
    }

    /// Pack into a byte slice.
    pub fn pack(&self, output: &mut [u8]) {
        let output = array_mut_ref![output, 0, USER_STAKE_LEN];
        let (is_initialized, amount, reward_debt, reward_pending) =
            mut_array_refs![output, 1, 8, 16, 8];
        is_initialized[0] = self.is_initialized as u8;
        *amount = self.amount.to_le_bytes();
        *reward_debt = self.reward_debt.to_le_bytes();
        *reward_pending = self.reward_pending.to_le_bytes();
    }

    /// Reward owed to this position at the farm's current accumulator, including
    /// the previously harvested-but-unminted `reward_pending`.
    pub fn pending(&self, acc_reward_per_share: u128) -> Result<u64, FarmError> {
        let gross = (self.amount as u128)
            .checked_mul(acc_reward_per_share)
            .ok_or(FarmError::Overflow)?
            / ACC_PRECISION;
        let accrued = gross.saturating_sub(self.reward_debt);
        let total = (self.reward_pending as u128)
            .checked_add(accrued)
            .ok_or(FarmError::Overflow)?;
        u64::try_from(total).map_err(|_| FarmError::Overflow)
    }

    /// Snapshot the reward debt for the current `amount`.
    pub fn set_debt(&mut self, acc_reward_per_share: u128) -> Result<(), FarmError> {
        self.reward_debt = (self.amount as u128)
            .checked_mul(acc_reward_per_share)
            .ok_or(FarmError::Overflow)?
            / ACC_PRECISION;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A single staker accrues reward proportional to elapsed time * rate.
    #[test]
    fn accrue_single_staker() {
        let mut farm = Farm {
            is_initialized: true,
            reward_per_second: 1_000,
            total_staked: 100,
            last_update_ts: 0,
            ..Farm::default()
        };
        farm.accrue(10).unwrap();
        // 10s * 1000/s = 10_000 reward over 100 staked → 100 per share (×PREC).
        assert_eq!(farm.acc_reward_per_share, 100 * ACC_PRECISION);
        let user = UserStake { is_initialized: true, amount: 100, ..UserStake::default() };
        assert_eq!(user.pending(farm.acc_reward_per_share).unwrap(), 10_000);
    }

    // Two stakers split emissions in proportion to stake.
    #[test]
    fn accrue_proportional_split() {
        let mut farm = Farm {
            is_initialized: true,
            reward_per_second: 900,
            total_staked: 300, // u1=100, u2=200
            last_update_ts: 0,
            ..Farm::default()
        };
        farm.accrue(10).unwrap();
        let u1 = UserStake { is_initialized: true, amount: 100, ..UserStake::default() };
        let u2 = UserStake { is_initialized: true, amount: 200, ..UserStake::default() };
        let p1 = u1.pending(farm.acc_reward_per_share).unwrap();
        let p2 = u2.pending(farm.acc_reward_per_share).unwrap();
        // total emitted = 900*10 = 9000; split 1:2.
        assert_eq!(p1, 3_000);
        assert_eq!(p2, 6_000);
        assert_eq!(p1 + p2, 9_000);
    }

    // reward_debt is honored: a staker who joins later earns only from join time.
    #[test]
    fn late_joiner_earns_from_debt() {
        let mut farm = Farm {
            is_initialized: true,
            reward_per_second: 1_000,
            total_staked: 100,
            last_update_ts: 0,
            ..Farm::default()
        };
        farm.accrue(10).unwrap(); // acc reflects 10s with only the first staker
        // Second staker joins now: debt snapshot at current acc → 0 pending immediately.
        let mut late = UserStake { is_initialized: true, amount: 100, ..UserStake::default() };
        late.set_debt(farm.acc_reward_per_share).unwrap();
        assert_eq!(late.pending(farm.acc_reward_per_share).unwrap(), 0);
        farm.total_staked = 200;
        farm.accrue(20).unwrap(); // another 10s, now split 1:1
        assert_eq!(late.pending(farm.acc_reward_per_share).unwrap(), 5_000);
    }

    // Idle time (no stakers) emits nothing but still advances the clock.
    #[test]
    fn idle_emits_nothing() {
        let mut farm = Farm {
            is_initialized: true,
            reward_per_second: 1_000,
            total_staked: 0,
            last_update_ts: 0,
            ..Farm::default()
        };
        farm.accrue(100).unwrap();
        assert_eq!(farm.acc_reward_per_share, 0);
        assert_eq!(farm.last_update_ts, 100);
    }

    #[test]
    fn farm_pack_roundtrip() {
        let farm = Farm {
            is_initialized: true,
            bump_seed: 253,
            owner: Pubkey::new_unique(),
            lp_mint: Pubkey::new_unique(),
            reward_mint: Pubkey::new_unique(),
            lp_vault: Pubkey::new_unique(),
            token_program: Pubkey::new_unique(),
            reward_per_second: 12_345,
            last_update_ts: 1_700_000_000,
            acc_reward_per_share: 987_654_321_000,
            total_staked: 42,
        };
        let mut buf = [0u8; FARM_LEN];
        farm.pack(&mut buf);
        assert_eq!(Farm::unpack(&buf).unwrap(), farm);
    }

    #[test]
    fn user_stake_pack_roundtrip() {
        let s = UserStake {
            is_initialized: true,
            amount: 999,
            reward_debt: 123_456_789,
            reward_pending: 55,
        };
        let mut buf = [0u8; USER_STAKE_LEN];
        s.pack(&mut buf);
        assert_eq!(UserStake::unpack(&buf).unwrap(), s);
    }
}
