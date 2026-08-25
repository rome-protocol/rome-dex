#![allow(clippy::arithmetic_side_effects)]
#![cfg_attr(not(test), deny(missing_docs))]

//! An Uniswap-like program for the Solana blockchain.

pub mod config;
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
