//! Order instructions + their wire encoding.

use {crate::error::OrderError, solana_program::program_error::ProgramError};

/// Instructions accepted by the orders program.
#[derive(Clone, Debug, PartialEq)]
pub enum OrderInstruction {
    /// Place a limit or DCA order. Funds `amount_in_total` from the owner's
    /// source account into the order's input escrow.
    ///
    /// Accounts: `[order(w), owner(s), input_escrow(w), output_escrow(w),
    /// owner_src(w), dst_ata, src_mint, dst_mint, pool, payer(s,w),
    /// token_program, system_program]`.
    Place {
        /// PDA-derivation nonce (with `owner`).
        nonce: u64,
        /// PDA bump for `[b"order", owner, nonce]`.
        bump: u8,
        /// Swap direction (true = A→B).
        a_to_b: bool,
        /// Total input committed.
        amount_in_total: u64,
        /// Input per execution (== total for a one-shot limit order).
        tranche_in: u64,
        /// Minimum NET output per full tranche (0 = market).
        min_out_per_tranche: u64,
        /// DCA cadence seconds (0 = limit / one-shot).
        interval_secs: u64,
        /// Absolute unix expiry.
        expiry_ts: i64,
        /// Keeper fee in bps of gross output (≤ MAX_KEEPER_FEE_BPS).
        keeper_fee_bps: u16,
    },
    /// Execute the next fillable tranche (permissionless).
    ///
    /// Accounts: `[order(w), input_escrow(w), output_escrow(w), dst_ata(w),
    /// keeper_fee(w), dex_program, pool, pool_authority, src_vault(w),
    /// dst_vault(w), pool_mint(w), fee_account(w), src_mint, dst_mint,
    /// token_program]`.
    Execute,
    /// Cancel an open order; refund the input escrow to the owner AND reclaim
    /// all rent (escrow ATA + order state account) to the owner (owner signs).
    ///
    /// Accounts: `[order(w), owner(s,w), input_escrow(w), owner_src(w),
    /// token_program]`.
    Cancel,
    /// Refund + fully close an expired order (permissionless); funds and rent
    /// go only to the owner's own accounts.
    ///
    /// Accounts: `[order(w), owner(w), input_escrow(w), owner_src(w),
    /// token_program]`.
    CrankExpired,
    /// Reclaim a FILLED order's rent (escrow ATA + state account) to the owner
    /// (permissionless; a keeper can sweep). Escrow is already empty.
    ///
    /// Accounts: `[order(w), owner(w), input_escrow(w), token_program]`.
    CloseFilled,
}

impl OrderInstruction {
    /// Parse instruction data (tag byte + little-endian fields).
    pub fn unpack(input: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = input
            .split_first()
            .ok_or(OrderError::InvalidInstruction)?;
        Ok(match tag {
            0 => {
                if rest.len() < 52 {
                    return Err(OrderError::InvalidInstruction.into());
                }
                let nonce = u64::from_le_bytes(rest[0..8].try_into().unwrap());
                let bump = rest[8];
                let a_to_b = match rest[9] {
                    0 => false,
                    1 => true,
                    _ => return Err(OrderError::InvalidInstruction.into()),
                };
                let amount_in_total = u64::from_le_bytes(rest[10..18].try_into().unwrap());
                let tranche_in = u64::from_le_bytes(rest[18..26].try_into().unwrap());
                let min_out_per_tranche = u64::from_le_bytes(rest[26..34].try_into().unwrap());
                let interval_secs = u64::from_le_bytes(rest[34..42].try_into().unwrap());
                let expiry_ts = i64::from_le_bytes(rest[42..50].try_into().unwrap());
                let keeper_fee_bps = u16::from_le_bytes(rest[50..52].try_into().unwrap());
                OrderInstruction::Place {
                    nonce,
                    bump,
                    a_to_b,
                    amount_in_total,
                    tranche_in,
                    min_out_per_tranche,
                    interval_secs,
                    expiry_ts,
                    keeper_fee_bps,
                }
            }
            1 => OrderInstruction::Execute,
            2 => OrderInstruction::Cancel,
            3 => OrderInstruction::CrankExpired,
            4 => OrderInstruction::CloseFilled,
            _ => return Err(OrderError::InvalidInstruction.into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_roundtrip_fields() {
        let mut data = vec![0u8]; // tag
        data.extend_from_slice(&7u64.to_le_bytes()); // nonce
        data.push(254); // bump
        data.push(1); // a_to_b
        data.extend_from_slice(&1_000_000u64.to_le_bytes()); // amount_in_total
        data.extend_from_slice(&250_000u64.to_le_bytes()); // tranche_in
        data.extend_from_slice(&990_000u64.to_le_bytes()); // min_out
        data.extend_from_slice(&3_600u64.to_le_bytes()); // interval
        data.extend_from_slice(&1_700_600_000i64.to_le_bytes()); // expiry
        data.extend_from_slice(&10u16.to_le_bytes()); // keeper_fee_bps
        match OrderInstruction::unpack(&data).unwrap() {
            OrderInstruction::Place {
                nonce,
                bump,
                a_to_b,
                amount_in_total,
                tranche_in,
                min_out_per_tranche,
                interval_secs,
                expiry_ts,
                keeper_fee_bps,
            } => {
                assert_eq!(nonce, 7);
                assert_eq!(bump, 254);
                assert!(a_to_b);
                assert_eq!(amount_in_total, 1_000_000);
                assert_eq!(tranche_in, 250_000);
                assert_eq!(min_out_per_tranche, 990_000);
                assert_eq!(interval_secs, 3_600);
                assert_eq!(expiry_ts, 1_700_600_000);
                assert_eq!(keeper_fee_bps, 10);
            }
            other => panic!("expected Place, got {other:?}"),
        }
    }

    #[test]
    fn tags_map_to_variants() {
        assert_eq!(OrderInstruction::unpack(&[1]).unwrap(), OrderInstruction::Execute);
        assert_eq!(OrderInstruction::unpack(&[2]).unwrap(), OrderInstruction::Cancel);
        assert_eq!(
            OrderInstruction::unpack(&[3]).unwrap(),
            OrderInstruction::CrankExpired
        );
        assert_eq!(
            OrderInstruction::unpack(&[4]).unwrap(),
            OrderInstruction::CloseFilled
        );
    }

    #[test]
    fn empty_and_unknown_tag_rejected() {
        assert!(OrderInstruction::unpack(&[]).is_err());
        assert!(OrderInstruction::unpack(&[9]).is_err());
    }

    #[test]
    fn truncated_place_rejected() {
        assert!(OrderInstruction::unpack(&[0, 1, 2, 3]).is_err());
    }
}
