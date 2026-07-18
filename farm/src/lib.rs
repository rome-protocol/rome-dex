#![allow(clippy::arithmetic_side_effects)]
#![deny(missing_docs)]

//! Rome DEX liquidity-mining farm.
//!
//! A lean, MasterChef-style single-farm program: stake a rome-dex LP mint, earn
//! a reward SPL mint over time, claim. Every hot-path instruction takes the
//! staker as a single `authority` signer operating on the authority's own token
//! accounts and a `(farm, authority)` UserStake PDA — so it is authority-
//! agnostic and works identically for a Solana wallet and an EVM user's Rome
//! `external_auth` PDA (the CPI lane auto-signs the latter). This is the same
//! dual-lane seam the DEX core relies on.

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint;

pub use solana_program;

solana_program::declare_id!("AtseC4PTJaXfPbQVqLmcBnv7iGeftJYTzbR1stKE5Hnc");
