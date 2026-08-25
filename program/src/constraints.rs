//! Various constraints as required for production environments

use {
    crate::{
        curve::{
            base::{CurveType, SwapCurve},
            fees::Fees,
        },
        error::SwapError,
    },
    solana_program::program_error::ProgramError,
};

/// Encodes fee constraints, used in multihost environments where the program
/// may be used by multiple frontends, to ensure that proper fees are being
/// assessed.
/// Since this struct needs to be created at compile-time, we only have access
/// to const functions and constructors. Since SwapCurve contains a Arc, it
/// cannot be used, so we have to split the curves based on their types.
pub struct SwapConstraints<'a> {
    /// Valid curve types
    pub valid_curve_types: &'a [CurveType],
    /// Valid fees
    pub fees: &'a Fees,
}

impl<'a> SwapConstraints<'a> {
    /// Checks that the provided curve is valid for the given constraints
    pub fn validate_curve(&self, swap_curve: &SwapCurve) -> Result<(), ProgramError> {
        if self.valid_curve_types.contains(&swap_curve.curve_type) {
            Ok(())
        } else {
            Err(SwapError::UnsupportedCurveType.into())
        }
    }

    /// Checks that the provided curve is valid for the given constraints
    pub fn validate_fees(&self, fees: &Fees) -> Result<(), ProgramError> {
        if fees.trade_fee_numerator >= self.fees.trade_fee_numerator
            && fees.trade_fee_denominator == self.fees.trade_fee_denominator
            && fees.owner_trade_fee_numerator >= self.fees.owner_trade_fee_numerator
            && fees.owner_trade_fee_denominator == self.fees.owner_trade_fee_denominator
            && fees.owner_withdraw_fee_numerator >= self.fees.owner_withdraw_fee_numerator
            && fees.owner_withdraw_fee_denominator == self.fees.owner_withdraw_fee_denominator
            && fees.host_fee_numerator == self.fees.host_fee_numerator
            && fees.host_fee_denominator == self.fees.host_fee_denominator
        {
            Ok(())
        } else {
            Err(SwapError::InvalidFee.into())
        }
    }
}

// Mainnet's curated fee-tier policy. Every pool we run is one of three tiers
// (0.05% / 0.30% / 1.00%), all encoded trade_num/10000, and validate_fees
// checks numerators with `>=` but denominators (and the host fee) with exact
// equality — so den=10000 is forced for trade and owner_trade, and 0/0 is the
// only legal encoding for withdraw and host.
#[cfg(feature = "production")]
const FEES: &Fees = &Fees {
    // Floor of 1/10000 so every pool pays LPs something, while leaving room
    // for a future 1bp tier with no program upgrade (`>=` admits higher).
    trade_fee_numerator: 1,
    trade_fee_denominator: 10000,
    // Forced to 0: the 0.05% and 1.00% tiers set owner num=0 with den=10000,
    // and the denominator check is exact, so any minimum above 0 would reject
    // two of three live tiers. A minimum is the wrong instrument for a
    // protocol cut anyway (that's per-tier curator policy) — this constraint's
    // job is merely to not reject it. `>=` still admits a higher cut later.
    owner_trade_fee_numerator: 0,
    owner_trade_fee_denominator: 10000,
    // den==0 forces num==0 via validate_fraction, so {0/0} is the ONLY legal
    // pair — this *enforces* a zero withdraw fee. {0/10000} would instead
    // silently permit any numerator up to 9999 via the `>=` check: a trap.
    // No tier defines a withdraw fee, and withdraw fees punish LP exit.
    owner_withdraw_fee_numerator: 0,
    owner_withdraw_fee_denominator: 0,
    // There is no host in Rome's architecture (SPL's host fee pays third-party
    // frontends in a multi-frontend deployment; rome-dex has one frontend and
    // its own routers). Exact-equality pins num to 0 either way; 0/0 is chosen
    // for consistency and because a denominator implying an impossible rate
    // is noise.
    host_fee_numerator: 0,
    host_fee_denominator: 0,
};
// Only ConstantProduct: every pool we run is ConstantProduct and the UI
// offers only that (CLMM is a separate program). Keeping ConstantPrice (or
// Offset) admissible on mainnet is pure typo/attack surface with no user.
#[cfg(feature = "production")]
const VALID_CURVE_TYPES: &[CurveType] = &[CurveType::ConstantProduct];

/// Fee structure defined by program creator in order to enforce certain
/// fees when others use the program.  Adds checks on pool creation and
/// swapping to ensure the correct fees and account owners are passed.
/// Fees provided during production build currently are considered min
/// fees that creator of the pool can specify. Host fee is a fixed
/// percentage that host receives as a portion of owner fees
pub const SWAP_CONSTRAINTS: Option<SwapConstraints> = {
    #[cfg(feature = "production")]
    {
        Some(SwapConstraints {
            valid_curve_types: VALID_CURVE_TYPES,
            fees: FEES,
        })
    }
    #[cfg(not(feature = "production"))]
    {
        None
    }
};

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::curve::{base::CurveType, constant_product::ConstantProductCurve},
        std::sync::Arc,
    };

    #[test]
    fn validate_fees() {
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 4;
        let owner_trade_fee_numerator = 2;
        let owner_trade_fee_denominator = 5;
        let owner_withdraw_fee_numerator = 4;
        let owner_withdraw_fee_denominator = 10;
        let host_fee_numerator = 10;
        let host_fee_denominator = 100;
        let curve_type = CurveType::ConstantProduct;
        let valid_fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };
        let calculator = ConstantProductCurve {};
        let swap_curve = SwapCurve {
            curve_type,
            calculator: Arc::new(calculator.clone()),
        };
        let constraints = SwapConstraints {
            valid_curve_types: &[curve_type],
            fees: &valid_fees,
        };

        constraints.validate_curve(&swap_curve).unwrap();
        constraints.validate_fees(&valid_fees).unwrap();

        let mut fees = valid_fees.clone();
        fees.trade_fee_numerator = trade_fee_numerator - 1;
        assert_eq!(
            Err(SwapError::InvalidFee.into()),
            constraints.validate_fees(&fees),
        );
        fees.trade_fee_numerator = trade_fee_numerator;

        // passing higher fee is ok
        fees.trade_fee_numerator = trade_fee_numerator - 1;
        assert_eq!(constraints.validate_fees(&valid_fees), Ok(()));
        fees.trade_fee_numerator = trade_fee_numerator;

        fees.trade_fee_denominator = trade_fee_denominator - 1;
        assert_eq!(
            Err(SwapError::InvalidFee.into()),
            constraints.validate_fees(&fees),
        );
        fees.trade_fee_denominator = trade_fee_denominator;

        fees.trade_fee_denominator = trade_fee_denominator + 1;
        assert_eq!(
            Err(SwapError::InvalidFee.into()),
            constraints.validate_fees(&fees),
        );
        fees.trade_fee_denominator = trade_fee_denominator;

        fees.owner_trade_fee_numerator = owner_trade_fee_numerator - 1;
        assert_eq!(
            Err(SwapError::InvalidFee.into()),
            constraints.validate_fees(&fees),
        );
        fees.owner_trade_fee_numerator = owner_trade_fee_numerator;

        // passing higher fee is ok
        fees.owner_trade_fee_numerator = owner_trade_fee_numerator - 1;
        assert_eq!(constraints.validate_fees(&valid_fees), Ok(()));
        fees.owner_trade_fee_numerator = owner_trade_fee_numerator;

        fees.owner_trade_fee_denominator = owner_trade_fee_denominator - 1;
        assert_eq!(
            Err(SwapError::InvalidFee.into()),
            constraints.validate_fees(&fees),
        );
        fees.owner_trade_fee_denominator = owner_trade_fee_denominator;

        let swap_curve = SwapCurve {
            curve_type: CurveType::ConstantPrice,
            calculator: Arc::new(calculator),
        };
        assert_eq!(
            Err(SwapError::UnsupportedCurveType.into()),
            constraints.validate_curve(&swap_curve),
        );
    }
}

#[cfg(all(test, feature = "production"))]
mod production_tests {
    use {
        super::*,
        crate::curve::constant_product::ConstantProductCurve,
        std::sync::Arc,
    };

    fn tier(trade_num: u64, owner_num: u64) -> Fees {
        Fees {
            trade_fee_numerator: trade_num,
            trade_fee_denominator: 10000,
            owner_trade_fee_numerator: owner_num,
            owner_trade_fee_denominator: 10000,
            owner_withdraw_fee_numerator: 0,
            owner_withdraw_fee_denominator: 0,
            host_fee_numerator: 0,
            host_fee_denominator: 0,
        }
    }

    /// The genesis-ceremony guard: every fee tier we actually run on mainnet
    /// must clear BOTH the program's own `Fees::validate` and the production
    /// constraint set's `validate_fees` — the intersection, not one validator.
    #[test]
    fn production_accepts_every_intended_tier() {
        let constraints = SWAP_CONSTRAINTS.as_ref().unwrap();
        for (trade_num, owner_num) in [(5u64, 0u64), (25, 5), (100, 0)] {
            let fees = tier(trade_num, owner_num);
            assert!(
                fees.validate().is_ok(),
                "tier {trade_num}/10000 failed Fees::validate"
            );
            assert!(
                constraints.validate_fees(&fees).is_ok(),
                "tier {trade_num}/10000 (owner {owner_num}/10000) failed validate_fees"
            );
        }
    }

    /// Proves the trade-fee floor is live: 0/10000 must be rejected.
    #[test]
    fn production_rejects_zero_trade_fee() {
        let constraints = SWAP_CONSTRAINTS.as_ref().unwrap();
        let fees = tier(0, 0);
        assert!(constraints.validate_fees(&fees).is_err());
    }

    /// Pins the encoding fix: the legacy 0/10000 withdraw+host encoding must be
    /// rejected now that the constant requires exact-equal 0/0.
    #[test]
    fn production_rejects_legacy_denominator_encoding() {
        let constraints = SWAP_CONSTRAINTS.as_ref().unwrap();
        let mut fees = tier(25, 5);
        fees.owner_withdraw_fee_denominator = 10000;
        fees.host_fee_denominator = 10000;
        assert!(constraints.validate_fees(&fees).is_err());
    }

    #[test]
    fn production_rejects_offset_and_constant_price_curves() {
        let constraints = SWAP_CONSTRAINTS.as_ref().unwrap();
        for curve_type in [CurveType::Offset, CurveType::ConstantPrice] {
            let swap_curve = SwapCurve {
                curve_type,
                calculator: Arc::new(ConstantProductCurve {}),
            };
            assert_eq!(
                Err(SwapError::UnsupportedCurveType.into()),
                constraints.validate_curve(&swap_curve),
            );
        }
    }
}
