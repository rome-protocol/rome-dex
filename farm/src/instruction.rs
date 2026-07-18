//! Farm instructions.
//!
//! Every hot-path instruction takes the staker as a single `authority` signer
//! operating on the authority's own LP ATA / reward ATA and a `UserStake` PDA
//! derived from `(farm, authority)`. It is authority-agnostic: `authority` may
//! be a Solana wallet pubkey OR an EVM user's Rome `external_auth` PDA (the CPI
//! lane auto-signs the latter), so both lanes share one code path.

use {crate::error::FarmError, solana_program::program_error::ProgramError};

/// Instructions supported by the farm program.
#[derive(Clone, Debug, PartialEq)]
pub enum FarmInstruction {
    /// Initialize a farm over a pre-created program-owned account.
    ///
    /// Accounts:
    ///   0. `[writable]` Farm account (program-owned, uninitialized).
    ///   1. `[]` Farm authority PDA `[farm]`.
    ///   2. `[]` LP mint (staked token).
    ///   3. `[]` Reward mint (authority must be the farm authority PDA).
    ///   4. `[]` LP vault token account (owner = authority PDA, mint = lp_mint).
    ///   5. `[]` Owner (operator allowed to tune emissions).
    ///   6. `[]` SPL token program.
    InitFarm {
        /// Emission rate in reward base units per second.
        reward_per_second: u64,
    },

    /// Create a `UserStake` PDA for `(farm, authority)`. Permissionless: the
    /// authority need not sign; `payer` funds rent.
    ///
    /// Accounts:
    ///   0. `[]` Farm account.
    ///   1. `[]` Authority (stake owner; NOT a signer).
    ///   2. `[writable]` UserStake PDA `[farm, authority]`.
    ///   3. `[writable, signer]` Payer.
    ///   4. `[]` System program.
    InitUserStake,

    /// Stake `amount` LP into the farm.
    ///
    /// Accounts:
    ///   0. `[writable]` Farm account.
    ///   1. `[]` Farm authority PDA.
    ///   2. `[signer]` Authority (staker).
    ///   3. `[writable]` UserStake PDA `[farm, authority]`.
    ///   4. `[writable]` Authority's LP ATA (source).
    ///   5. `[writable]` LP vault (destination).
    ///   6. `[]` SPL token program.
    Stake {
        /// LP base units to stake.
        amount: u64,
    },

    /// Unstake `amount` LP from the farm.
    ///
    /// Accounts:
    ///   0. `[writable]` Farm account.
    ///   1. `[]` Farm authority PDA (vault owner; program-signed).
    ///   2. `[signer]` Authority (staker).
    ///   3. `[writable]` UserStake PDA.
    ///   4. `[writable]` LP vault (source).
    ///   5. `[writable]` Authority's LP ATA (destination).
    ///   6. `[]` SPL token program.
    Unstake {
        /// LP base units to unstake.
        amount: u64,
    },

    /// Mint accrued reward to the authority's reward ATA.
    ///
    /// Accounts:
    ///   0. `[writable]` Farm account.
    ///   1. `[]` Farm authority PDA (reward mint authority; program-signed).
    ///   2. `[signer]` Authority (staker).
    ///   3. `[writable]` UserStake PDA.
    ///   4. `[writable]` Reward mint.
    ///   5. `[writable]` Authority's reward ATA (destination).
    ///   6. `[]` SPL token program.
    Claim,

    /// Operator knob: set the emission rate (accrues first).
    ///
    /// Accounts:
    ///   0. `[writable]` Farm account.
    ///   1. `[signer]` Owner.
    SetRewardPerSecond {
        /// New emission rate in reward base units per second.
        reward_per_second: u64,
    },
}

impl FarmInstruction {
    /// Unpack from instruction data.
    pub fn unpack(input: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = input.split_first().ok_or(FarmError::InvalidInstruction)?;
        Ok(match tag {
            0 => FarmInstruction::InitFarm {
                reward_per_second: read_u64(rest)?,
            },
            1 => FarmInstruction::InitUserStake,
            2 => FarmInstruction::Stake {
                amount: read_u64(rest)?,
            },
            3 => FarmInstruction::Unstake {
                amount: read_u64(rest)?,
            },
            4 => FarmInstruction::Claim,
            5 => FarmInstruction::SetRewardPerSecond {
                reward_per_second: read_u64(rest)?,
            },
            _ => return Err(FarmError::InvalidInstruction.into()),
        })
    }
}

fn read_u64(input: &[u8]) -> Result<u64, ProgramError> {
    let bytes: [u8; 8] = input
        .get(..8)
        .and_then(|s| s.try_into().ok())
        .ok_or(FarmError::InvalidInstruction)?;
    Ok(u64::from_le_bytes(bytes))
}
