#![allow(clippy::arithmetic_side_effects)]
#![deny(missing_docs)]

//! Rome DEX limit-order + DCA program.
//!
//! A lean native Solana program (not a fork) that lets a user park an order —
//! "swap X of A→B once the price gives me ≥ Y" (limit) or "swap a tranche every
//! N seconds" (DCA) — funded into a per-order escrow, then executed later by a
//! **permissionless keeper**. The keeper cannot fill worse than the user's
//! limit: `Execute` CPIs the DEX swap with the user's (grossed-up) minimum as
//! the swap's own slippage floor, so a bad fill reverts on-chain.
//!
//! Security posture (baked in from the pre-ship audit of the DEX + farm):
//!   * the CPI target is pinned to the one hardcoded DEX program id, and the
//!     token program to the one SPL token id — a keeper can never substitute a
//!     no-op program to fake a fill (the arbitrary-CPI class that hit the farm);
//!   * every account `Execute` touches is matched against immutable `Order`
//!     state (escrow, destination, pool), never trusted from the keeper;
//!   * effects-first: `remaining_in` is debited before the swap CPI;
//!   * the keeper fee is hard-capped and rounded in the user's favor, and the
//!     swap minimum is grossed up so the user always NETS at least their limit.
//!
//! Every owner-gated instruction takes the order `owner` as a single signer over
//! the owner's own token accounts — authority-agnostic, so it works identically
//! for a Solana wallet and an EVM user's Rome `external_auth` PDA (the CPI lane
//! auto-signs the latter). Same dual-lane seam as the DEX core and the farm.

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint;

pub use solana_program;

/// The one Solana DEX program this order book will ever route swaps through.
/// Pinned so a keeper-supplied "DEX" can never be substituted (see [`processor`]).
pub const DEX_PROGRAM_ID: solana_program::pubkey::Pubkey =
    solana_program::pubkey!("Fv2LgkewH9114T6Gg99ERq8TxMVj2MGPRC73dJ4AKb1A");

solana_program::declare_id!("ordWTztCBW7fpoq6eLHQBp2aeoB17CAbmAx6FjtfQ7C");
