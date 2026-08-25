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

#[cfg(test)]
mod overflow_canary {
    /// Asserts the RELEASE profile has overflow-checks on. Host tests run in
    /// debug, where checks are on by default, so this is vacuous under
    /// `cargo test` and only meaningful under `cargo test --release` — which is
    /// the profile `cargo build-sbf` uses for the deployed artefact.
    #[test]
    fn release_profile_has_overflow_checks() {
        let r = std::panic::catch_unwind(|| {
            let x: u64 = std::hint::black_box(u64::MAX);
            std::hint::black_box(x + 1)
        });
        assert!(r.is_err(), "u64::MAX + 1 wrapped silently: overflow-checks are OFF in this profile");
    }
}
