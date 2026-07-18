//! Order program errors.

use {solana_program::program_error::ProgramError, thiserror::Error};

/// Errors returned by the rome-dex orders program.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum OrderError {
    /// The account is already initialized.
    #[error("Account already initialized")]
    AlreadyInitialized,
    /// The account is not initialized.
    #[error("Account not initialized")]
    Uninitialized,
    /// The derived program address did not match the supplied account.
    #[error("Derived address mismatch")]
    AddressMismatch,
    /// A supplied token account has the wrong owner, mint, or identity.
    #[error("Invalid token account")]
    InvalidTokenAccount,
    /// The supplied token program is not the SPL token program.
    #[error("Incorrect token program")]
    IncorrectTokenProgram,
    /// The supplied swap program is not the pinned DEX program.
    #[error("Incorrect DEX program")]
    IncorrectDexProgram,
    /// The signer is not the order owner.
    #[error("Unauthorized")]
    Unauthorized,
    /// The order is not open (already filled, cancelled, or expired).
    #[error("Order not open")]
    NotOpen,
    /// The order has not expired yet (CrankExpired called too early).
    #[error("Order not expired")]
    NotExpired,
    /// A DCA tranche's interval has not elapsed since the last execution.
    #[error("DCA interval not elapsed")]
    IntervalNotElapsed,
    /// The keeper fee exceeds the hard cap.
    #[error("Keeper fee too high")]
    FeeTooHigh,
    /// Order parameters are invalid (zero amount, tranche > total, etc.).
    #[error("Invalid order parameters")]
    InvalidParams,
    /// The realized net output fell below the order's per-tranche minimum.
    #[error("Output below minimum")]
    BelowMinimum,
    /// Arithmetic overflowed.
    #[error("Arithmetic overflow")]
    Overflow,
    /// The instruction data could not be parsed.
    #[error("Invalid instruction")]
    InvalidInstruction,
}

impl From<OrderError> for ProgramError {
    fn from(e: OrderError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
