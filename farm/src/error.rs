//! Farm program errors.

use {solana_program::program_error::ProgramError, thiserror::Error};

/// Errors returned by the rome-dex farm program.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum FarmError {
    /// The account is already initialized.
    #[error("Account already initialized")]
    AlreadyInitialized,
    /// The account is not initialized.
    #[error("Account not initialized")]
    Uninitialized,
    /// The derived program address did not match the supplied account.
    #[error("Derived address mismatch")]
    AddressMismatch,
    /// A supplied token account has the wrong owner or mint.
    #[error("Invalid token account")]
    InvalidTokenAccount,
    /// The reward mint authority is not the farm authority PDA.
    #[error("Invalid reward mint authority")]
    InvalidRewardMintAuthority,
    /// The signer is not authorized for this operation.
    #[error("Unauthorized")]
    Unauthorized,
    /// Attempted to unstake more than the staked balance.
    #[error("Insufficient staked balance")]
    InsufficientStake,
    /// Arithmetic overflowed.
    #[error("Arithmetic overflow")]
    Overflow,
    /// The instruction data could not be parsed.
    #[error("Invalid instruction")]
    InvalidInstruction,
    /// The supplied token program is not the farm's SPL token program.
    #[error("Incorrect token program")]
    IncorrectTokenProgram,
}

impl From<FarmError> for ProgramError {
    fn from(e: FarmError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
