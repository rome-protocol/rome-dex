#![allow(clippy::arithmetic_side_effects)]
#![cfg_attr(not(test), deny(missing_docs))]

//! An Uniswap-like program for the Solana blockchain.

pub mod constraints;
pub mod curve;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint;

// Export current sdk types for downstream users building with a different sdk
// version
pub use solana_program;

solana_program::declare_id!("Fv2LgkewH9114T6Gg99ERq8TxMVj2MGPRC73dJ4AKb1A");
