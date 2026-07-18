//! CLMM errors.

use {solana_program::program_error::ProgramError, thiserror::Error};

/// Errors returned by the rome-dex CLMM.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ClmmError {
    /// A tick was outside `[MIN_TICK, MAX_TICK]`.
    #[error("Tick out of bounds")]
    TickOutOfBounds,
    /// A sqrt-price was outside `[MIN_SQRT_PRICE, MAX_SQRT_PRICE]`.
    #[error("Sqrt price out of bounds")]
    SqrtPriceOutOfBounds,
    /// Arithmetic overflowed / underflowed.
    #[error("Math overflow")]
    MathOverflow,
    /// Liquidity was zero where a positive value is required.
    #[error("Zero liquidity")]
    ZeroLiquidity,
    /// Invalid tick range (lower >= upper, or misaligned to spacing).
    #[error("Invalid tick range")]
    InvalidTickRange,
    /// The supplied tick arrays don't form a contiguous window covering the
    /// swap (wrong order / gap / window exhausted before the amount filled).
    #[error("Invalid tick array sequence")]
    InvalidTickArraySequence,
    /// Instruction data failed to parse.
    #[error("Invalid instruction")]
    InvalidInstruction,
    /// The account is already initialized.
    #[error("Already initialized")]
    AlreadyInitialized,
    /// The account is not initialized.
    #[error("Uninitialized")]
    Uninitialized,
    /// A derived address (PDA / ATA) didn't match the supplied account.
    #[error("Address mismatch")]
    AddressMismatch,
    /// A token account doesn't match the state it must correspond to.
    #[error("Invalid token account")]
    InvalidTokenAccount,
    /// The token program isn't SPL Token (arbitrary-CPI guard).
    #[error("Incorrect token program")]
    IncorrectTokenProgram,
    /// The signer isn't the owner the state names.
    #[error("Unauthorized")]
    Unauthorized,
    /// A realized amount violated the caller's slippage bound.
    #[error("Slippage exceeded")]
    SlippageExceeded,
    /// Instruction parameters are out of the accepted domain.
    #[error("Invalid parameters")]
    InvalidParams,
}

impl From<ClmmError> for ProgramError {
    fn from(e: ClmmError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
