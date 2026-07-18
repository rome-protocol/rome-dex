//! Order account state + the pure economic helpers (gross-up, fee split,
//! expiry / DCA timing, effects-first debit). The helpers are where the
//! security-critical invariants live, so they are unit-tested in isolation.

use {
    crate::error::OrderError,
    arrayref::{array_mut_ref, array_ref, array_refs, mut_array_refs},
    solana_program::{program_error::ProgramError, pubkey::Pubkey},
};

/// Serialized length of an [`Order`] account.
pub const ORDER_LEN: usize = 230;

/// Keeper fee hard cap (0.50%). Enforced at `Place`; bounds fee-griefing.
pub const MAX_KEEPER_FEE_BPS: u16 = 50;
/// Maximum DCA interval (1 year) — bounds the `interval_secs as i64` cast in
/// `dca_ready` well below any wrap.
pub const MAX_INTERVAL_SECS: u64 = 365 * 24 * 60 * 60;
/// Basis-point denominator.
pub const BPS_DENOM: u128 = 10_000;

/// Order lifecycle. Terminal states (Filled/Cancelled/Expired) reject `Execute`.
pub const STATUS_OPEN: u8 = 0;
/// Fully executed — `remaining_in` reached zero.
pub const STATUS_FILLED: u8 = 1;
/// Cancelled by the owner; escrow refunded.
pub const STATUS_CANCELLED: u8 = 2;
/// Expired and cranked; escrow refunded to the owner.
pub const STATUS_EXPIRED: u8 = 3;

/// A parked limit or DCA order.
///
/// A pure limit order sets `tranche_in == amount_in_total` and `interval_secs
/// == 0` (one shot). A DCA order sets `tranche_in < amount_in_total` and
/// `interval_secs > 0` (a tranche each interval until drained or expired).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Order {
    /// Whether this account has been initialized.
    pub is_initialized: bool,
    /// Bump for the order PDA `[b"order", owner, nonce]` (also the escrow owner).
    pub bump: u8,
    /// Lifecycle status (see `STATUS_*`).
    pub status: u8,
    /// Order owner: a Solana wallet pubkey OR an EVM user's `external_auth` PDA.
    pub owner: Pubkey,
    /// The DEX pool (`swapState`) this order swaps through.
    pub pool: Pubkey,
    /// Escrow ATA (owned by the order PDA) holding the un-executed input.
    pub input_escrow: Pubkey,
    /// Escrow ATA (owned by the order PDA) that receives gross swap output, then
    /// is split into the keeper fee and the owner's net proceeds.
    pub output_escrow: Pubkey,
    /// The owner's output ATA — where the net proceeds are delivered.
    pub dst_ata: Pubkey,
    /// PDA-derivation nonce (with `owner`), so one owner can hold many orders.
    pub nonce: u64,
    /// Swap direction across the pool (true = A→B).
    pub a_to_b: bool,
    /// Total input committed at placement.
    pub amount_in_total: u64,
    /// Input not yet executed (effects-first debited before each swap CPI).
    pub remaining_in: u64,
    /// Input consumed per execution (== total for a one-shot limit order).
    pub tranche_in: u64,
    /// Minimum NET output per tranche the owner must receive (0 = market).
    pub min_out_per_tranche: u64,
    /// DCA cadence in seconds (0 = limit / one-shot, execute whenever fillable).
    pub interval_secs: u64,
    /// Unix ts of the last execution (0 until first fill).
    pub last_exec_ts: i64,
    /// Unix ts after which the order may be cranked expired.
    pub expiry_ts: i64,
    /// Keeper fee in basis points of gross output (≤ `MAX_KEEPER_FEE_BPS`).
    pub keeper_fee_bps: u16,
}

impl Order {
    /// Unpack from a byte slice.
    pub fn unpack(input: &[u8]) -> Result<Order, ProgramError> {
        let input = array_ref![input, 0, ORDER_LEN];
        let (
            is_initialized,
            bump,
            status,
            owner,
            pool,
            input_escrow,
            output_escrow,
            dst_ata,
            nonce,
            a_to_b,
            amount_in_total,
            remaining_in,
            tranche_in,
            min_out_per_tranche,
            interval_secs,
            last_exec_ts,
            expiry_ts,
            keeper_fee_bps,
        ) = array_refs![input, 1, 1, 1, 32, 32, 32, 32, 32, 8, 1, 8, 8, 8, 8, 8, 8, 8, 2];
        Ok(Order {
            is_initialized: match is_initialized[0] {
                0 => false,
                1 => true,
                _ => return Err(ProgramError::InvalidAccountData),
            },
            bump: bump[0],
            status: status[0],
            owner: Pubkey::new_from_array(*owner),
            pool: Pubkey::new_from_array(*pool),
            input_escrow: Pubkey::new_from_array(*input_escrow),
            output_escrow: Pubkey::new_from_array(*output_escrow),
            dst_ata: Pubkey::new_from_array(*dst_ata),
            nonce: u64::from_le_bytes(*nonce),
            a_to_b: match a_to_b[0] {
                0 => false,
                1 => true,
                _ => return Err(ProgramError::InvalidAccountData),
            },
            amount_in_total: u64::from_le_bytes(*amount_in_total),
            remaining_in: u64::from_le_bytes(*remaining_in),
            tranche_in: u64::from_le_bytes(*tranche_in),
            min_out_per_tranche: u64::from_le_bytes(*min_out_per_tranche),
            interval_secs: u64::from_le_bytes(*interval_secs),
            last_exec_ts: i64::from_le_bytes(*last_exec_ts),
            expiry_ts: i64::from_le_bytes(*expiry_ts),
            keeper_fee_bps: u16::from_le_bytes(*keeper_fee_bps),
        })
    }

    /// Pack into a byte slice.
    pub fn pack(&self, output: &mut [u8]) {
        let output = array_mut_ref![output, 0, ORDER_LEN];
        let (
            is_initialized,
            bump,
            status,
            owner,
            pool,
            input_escrow,
            output_escrow,
            dst_ata,
            nonce,
            a_to_b,
            amount_in_total,
            remaining_in,
            tranche_in,
            min_out_per_tranche,
            interval_secs,
            last_exec_ts,
            expiry_ts,
            keeper_fee_bps,
        ) = mut_array_refs![output, 1, 1, 1, 32, 32, 32, 32, 32, 8, 1, 8, 8, 8, 8, 8, 8, 8, 2];
        is_initialized[0] = self.is_initialized as u8;
        bump[0] = self.bump;
        status[0] = self.status;
        owner.copy_from_slice(self.owner.as_ref());
        pool.copy_from_slice(self.pool.as_ref());
        input_escrow.copy_from_slice(self.input_escrow.as_ref());
        output_escrow.copy_from_slice(self.output_escrow.as_ref());
        dst_ata.copy_from_slice(self.dst_ata.as_ref());
        *nonce = self.nonce.to_le_bytes();
        a_to_b[0] = self.a_to_b as u8;
        *amount_in_total = self.amount_in_total.to_le_bytes();
        *remaining_in = self.remaining_in.to_le_bytes();
        *tranche_in = self.tranche_in.to_le_bytes();
        *min_out_per_tranche = self.min_out_per_tranche.to_le_bytes();
        *interval_secs = self.interval_secs.to_le_bytes();
        *last_exec_ts = self.last_exec_ts.to_le_bytes();
        *expiry_ts = self.expiry_ts.to_le_bytes();
        *keeper_fee_bps = self.keeper_fee_bps.to_le_bytes();
    }

    /// Is the order live (not filled/cancelled/expired)?
    pub fn is_open(&self) -> bool {
        self.status == STATUS_OPEN
    }

    /// Has the order reached its expiry?
    pub fn is_expired(&self, now: i64) -> bool {
        now >= self.expiry_ts
    }

    /// Is the next tranche executable at `now` (DCA interval elapsed)?
    /// Limit orders (`interval_secs == 0`) are always ready while open.
    pub fn dca_ready(&self, now: i64) -> bool {
        now >= self.last_exec_ts.saturating_add(self.interval_secs as i64)
    }

    /// Input consumed by the next execution: `min(tranche_in, remaining_in)`, so
    /// the final DCA tranche cleanly drains the remainder.
    pub fn next_tranche_in(&self) -> u64 {
        core::cmp::min(self.tranche_in, self.remaining_in)
    }

    /// The NET output floor for a tranche of `tranche_in_used`. A full tranche
    /// uses `min_out_per_tranche`; a partial final tranche scales it down
    /// proportionally, rounding UP (owner's favor) so a small remainder can
    /// still fill. `tranche_in` is guaranteed > 0 by `Place`.
    pub fn effective_min_out(&self, tranche_in_used: u64) -> Result<u64, OrderError> {
        if tranche_in_used >= self.tranche_in {
            return Ok(self.min_out_per_tranche);
        }
        // ceil(min_out · used / tranche_in)
        let num = (self.min_out_per_tranche as u128)
            .checked_mul(tranche_in_used as u128)
            .ok_or(OrderError::Overflow)?;
        let denom = self.tranche_in as u128;
        let scaled = num.div_ceil(denom);
        u64::try_from(scaled).map_err(|_| OrderError::Overflow)
    }

    /// Effects-first debit: subtract executed input and flip to Filled at zero.
    /// Callers MUST invoke this before the swap CPI so a re-entrant / double
    /// execute sees the reduced `remaining_in`.
    pub fn debit(&mut self, amount: u64) -> Result<(), OrderError> {
        self.remaining_in = self
            .remaining_in
            .checked_sub(amount)
            .ok_or(OrderError::Overflow)?;
        if self.remaining_in == 0 {
            self.status = STATUS_FILLED;
        }
        Ok(())
    }
}

/// Split an input tranche into `(keeper_fee, swap_in)`. The keeper fee is taken
/// from the INPUT side (fee-from-input model — no output escrow, no gross-up):
/// `keeper_fee = floor(tranche·bps/1e4)` (rounds DOWN, owner's favor) and
/// `keeper_fee + swap_in == tranche` exactly. The remainder is swapped straight
/// into the owner's ATA, so the owner nets the full swap output.
pub fn split_output(tranche: u64, keeper_fee_bps: u16) -> Result<(u64, u64), OrderError> {
    let fee = (tranche as u128)
        .checked_mul(keeper_fee_bps as u128)
        .ok_or(OrderError::Overflow)?
        / BPS_DENOM;
    let fee = fee as u64;
    let swap_in = tranche.checked_sub(fee).ok_or(OrderError::Overflow)?;
    Ok((fee, swap_in))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Order {
        Order {
            is_initialized: true,
            bump: 253,
            status: STATUS_OPEN,
            owner: Pubkey::new_unique(),
            pool: Pubkey::new_unique(),
            input_escrow: Pubkey::new_unique(),
            output_escrow: Pubkey::new_unique(),
            dst_ata: Pubkey::new_unique(),
            nonce: 7,
            a_to_b: true,
            amount_in_total: 1_000_000,
            remaining_in: 1_000_000,
            tranche_in: 250_000,
            min_out_per_tranche: 990_000,
            interval_secs: 3_600,
            last_exec_ts: 1_700_000_000,
            expiry_ts: 1_700_600_000,
            keeper_fee_bps: 10,
        }
    }

    #[test]
    fn pack_roundtrip() {
        let o = sample();
        let mut buf = [0u8; ORDER_LEN];
        o.pack(&mut buf);
        assert_eq!(Order::unpack(&buf).unwrap(), o);
    }

    // Fee-from-input split: keeper fee rounds DOWN (owner's favor) and the fee +
    // swapped remainder always reconstruct the tranche exactly, for every fee
    // within the cap. The owner nets the full swap output of `swap_in`.
    #[test]
    fn split_conserves_tranche_and_rounds_down() {
        for &tranche in &[1u64, 100, 100_000, 1_000_000_000, u64::MAX] {
            for &bps in &[0u16, 1, 10, 25, MAX_KEEPER_FEE_BPS] {
                let (fee, swap_in) = split_output(tranche, bps).unwrap();
                assert_eq!(fee.checked_add(swap_in), Some(tranche), "fee + swap_in must equal the tranche");
                // Rounded-down fee never exceeds the exact proportional fee.
                assert!((fee as u128) <= (tranche as u128) * bps as u128 / BPS_DENOM + 1);
            }
        }
    }

    #[test]
    fn split_zero_fee_swaps_whole_tranche() {
        assert_eq!(split_output(1_000_000, 0).unwrap(), (0, 1_000_000));
    }

    #[test]
    fn debit_effects_first_and_fills_at_zero() {
        let mut o = sample();
        o.remaining_in = 250_000;
        o.debit(100_000).unwrap();
        assert_eq!(o.remaining_in, 150_000);
        assert_eq!(o.status, STATUS_OPEN);
        o.debit(150_000).unwrap();
        assert_eq!(o.remaining_in, 0);
        assert_eq!(o.status, STATUS_FILLED, "drains to Filled");
    }

    #[test]
    fn debit_rejects_over_remaining() {
        let mut o = sample();
        o.remaining_in = 100;
        assert_eq!(o.debit(101), Err(OrderError::Overflow));
    }

    #[test]
    fn dca_ready_respects_interval() {
        let mut o = sample();
        o.last_exec_ts = 1_000;
        o.interval_secs = 60;
        assert!(!o.dca_ready(1_059), "before interval");
        assert!(o.dca_ready(1_060), "at interval");
    }

    #[test]
    fn limit_order_always_ready() {
        let mut o = sample();
        o.interval_secs = 0;
        o.last_exec_ts = 5_000;
        assert!(o.dca_ready(5_000));
    }

    #[test]
    fn next_tranche_drains_remainder() {
        let mut o = sample();
        o.tranche_in = 250_000;
        o.remaining_in = 100_000; // last partial tranche
        assert_eq!(o.next_tranche_in(), 100_000);
    }

    #[test]
    fn effective_min_out_scales_partial_tranche() {
        let mut o = sample();
        o.tranche_in = 250_000;
        o.min_out_per_tranche = 1_000;
        // Full tranche → unchanged.
        assert_eq!(o.effective_min_out(250_000).unwrap(), 1_000);
        // Half tranche → half the floor.
        assert_eq!(o.effective_min_out(125_000).unwrap(), 500);
        // Rounds UP (owner's favor): 1000 * 1 / 250000 = 0.004 → 1.
        assert_eq!(o.effective_min_out(1).unwrap(), 1);
    }

    #[test]
    fn expiry_boundary() {
        let o = sample();
        assert!(!o.is_expired(o.expiry_ts - 1));
        assert!(o.is_expired(o.expiry_ts));
    }
}
