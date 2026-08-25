#![allow(clippy::arithmetic_side_effects)]
#![deny(missing_docs)]

//! Rome DEX concentrated-liquidity AMM (CLMM) — math core.
//!
//! Roadmap #4. A purpose-built lean native Solana CLMM (not a fork, not a
//! wrapper): concentrated liquidity in the Uniswap-V3 / Orca-Whirlpools style,
//! with the same dual-lane authority-agnostic seam the constant-product core
//! and the orders program use — every instruction takes the owner as a single
//! signer over the owner's own token accounts + program-owned PDA positions
//! (`[b"position", pool, owner, lower, upper]`), so it works identically for a
//! Solana wallet and an EVM user's Rome `external_auth` PDA. Positions are PDAs,
//! NOT NFTs: an NFT position mint needs an ephemeral keypair signer, which
//! Rome's CPI precompile cannot auto-sign — the reason wrapping Orca/Raydium is
//! not a viable dual-lane product.
//!
//! Layering: the math core (`curve`, PR ① — audited) is the highest-risk
//! piece and is isolated + test-heavy; the program (PR ②) builds on it as
//! `state` (accounts + tick bookkeeping) → `engine` (the pure, host-tested
//! swap loop and position-modify transition over raw tick-array buffers) →
//! `processor` (thin account validation; orders-program trust model).
//!
//! ## Fixed-point convention
//! Prices are Q64.64: `sqrt_price` is `floor(sqrt(price) * 2^64)` as a `u128`,
//! where `price = amount_token1 / amount_token0`. Ticks index discrete prices
//! `price(tick) = 1.0001^tick`. All rounding is chosen in the POOL's favor
//! (never the trader's) so the invariant can't be bled by rounding.

pub mod curve;
pub mod engine;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint;

pub use solana_program;

solana_program::declare_id!("cLMkE4X3PN4qwLBjUksHAnYbQiNMMedCPEdYwRbLVjV");

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
