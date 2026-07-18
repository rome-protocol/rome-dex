//! Order instruction processing.
//!
//! Trust model (adversary = a hostile keeper, since `Execute`/`CrankExpired` are
//! permissionless): every account these paths touch is matched against the
//! immutable `Order` state (escrow, output escrow, destination, pool), the CPI
//! target is pinned to the one DEX program, the token program is pinned to SPL,
//! and `remaining_in` is debited before the swap CPI. The keeper can only make a
//! fill happen at or above the owner's (grossed-up) limit — it can never
//! substitute accounts, a fake DEX, or a no-op token program to divert funds.

use {
    crate::{
        error::OrderError,
        instruction::OrderInstruction,
        state::{split_output, Order, ORDER_LEN, STATUS_FILLED},
        DEX_PROGRAM_ID,
    },
    solana_program::{
        account_info::{next_account_info, AccountInfo},
        clock::Clock,
        entrypoint::ProgramResult,
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
        program_error::ProgramError,
        program_pack::Pack,
        pubkey::Pubkey,
        rent::Rent,
        system_instruction,
        sysvar::Sysvar,
    },
};

/// Order instruction processor.
pub struct Processor;

impl Processor {
    /// Route an instruction to its handler.
    pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        match OrderInstruction::unpack(data)? {
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
            } => Self::place(
                program_id,
                accounts,
                nonce,
                bump,
                a_to_b,
                amount_in_total,
                tranche_in,
                min_out_per_tranche,
                interval_secs,
                expiry_ts,
                keeper_fee_bps,
            ),
            OrderInstruction::Execute => Self::execute(program_id, accounts),
            OrderInstruction::Cancel => Self::cancel(program_id, accounts),
            OrderInstruction::CrankExpired => Self::crank_expired(program_id, accounts),
            OrderInstruction::CloseFilled => Self::close_filled(program_id, accounts),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn place(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        nonce: u64,
        bump: u8,
        a_to_b: bool,
        amount_in_total: u64,
        tranche_in: u64,
        min_out_per_tranche: u64,
        interval_secs: u64,
        expiry_ts: i64,
        keeper_fee_bps: u16,
    ) -> ProgramResult {
        let it = &mut accounts.iter();
        let order_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let input_escrow_ai = next_account_info(it)?;
        let owner_src_ai = next_account_info(it)?;
        let dst_ata_ai = next_account_info(it)?;
        let src_mint_ai = next_account_info(it)?;
        let dst_mint_ai = next_account_info(it)?;
        let pool_ai = next_account_info(it)?;
        let payer_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;
        let system_program_ai = next_account_info(it)?;

        Self::check_token_program(token_program_ai.key)?;
        if !owner_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if !payer_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Parameter sanity.
        if amount_in_total == 0 || tranche_in == 0 || tranche_in > amount_in_total {
            return Err(OrderError::InvalidParams.into());
        }
        if keeper_fee_bps > crate::state::MAX_KEEPER_FEE_BPS {
            return Err(OrderError::FeeTooHigh.into());
        }
        // A one-shot LIMIT order (interval == 0) MUST carry a price floor — a
        // zero-floor limit is a keeper-timed market fill (MEV footgun). DCA
        // (interval > 0) may set 0 for intentional market-tranche dollar-cost.
        if interval_secs == 0 && min_out_per_tranche == 0 {
            return Err(OrderError::InvalidParams.into());
        }
        // Bound the DCA interval well under the i64 cast in `dca_ready` (1 year).
        if interval_secs > crate::state::MAX_INTERVAL_SECS {
            return Err(OrderError::InvalidParams.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if expiry_ts <= now {
            return Err(OrderError::InvalidParams.into());
        }

        // Derive + verify the order PDA, then create it.
        let seeds: &[&[u8]] = &[b"order", owner_ai.key.as_ref(), &nonce.to_le_bytes()];
        let (expected, expected_bump) = Pubkey::find_program_address(seeds, program_id);
        if expected != *order_ai.key || expected_bump != bump {
            return Err(OrderError::AddressMismatch.into());
        }
        if order_ai.owner == program_id && Order::unpack(&order_ai.data.borrow())?.is_initialized {
            return Err(OrderError::AlreadyInitialized.into());
        }

        // Only ONE escrow now (fee-from-input model): the input escrow, a token
        // account owned by the order PDA holding the committed funds. The
        // app/keeper creates it in-flow (create_ata_for_key on the EVM lane, an
        // idempotent ATA ix on the Solana lane); the program validates, it does
        // not trust. The owner's destination ATA is NOT required to exist here
        // (deferred): the swap output lands in it only at Execute, and the keeper
        // provisions it then — Execute re-validates its owner + mint.
        let in_esc = spl_token::state::Account::unpack(&input_escrow_ai.data.borrow())?;
        if in_esc.owner != *order_ai.key || in_esc.mint != *src_mint_ai.key {
            return Err(OrderError::InvalidTokenAccount.into());
        }
        // dst_mint_ai is bound into the stored dst_ata's expected mint via the
        // Execute-time check; here we only record the destination address.
        let _ = dst_mint_ai;

        // Create the order state account (PDA, program-owned).
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(ORDER_LEN);
        let signer_seeds: &[&[u8]] = &[b"order", owner_ai.key.as_ref(), &nonce.to_le_bytes(), &[bump]];
        invoke_signed(
            &system_instruction::create_account(
                payer_ai.key,
                order_ai.key,
                lamports,
                ORDER_LEN as u64,
                program_id,
            ),
            &[payer_ai.clone(), order_ai.clone(), system_program_ai.clone()],
            &[signer_seeds],
        )?;

        // Fund the input escrow from the owner (owner signs — authority-agnostic).
        invoke(
            &spl_token::instruction::transfer(
                token_program_ai.key,
                owner_src_ai.key,
                input_escrow_ai.key,
                owner_ai.key,
                &[],
                amount_in_total,
            )?,
            &[
                owner_src_ai.clone(),
                input_escrow_ai.clone(),
                owner_ai.clone(),
                token_program_ai.clone(),
            ],
        )?;

        let order = Order {
            is_initialized: true,
            bump,
            status: crate::state::STATUS_OPEN,
            owner: *owner_ai.key,
            pool: *pool_ai.key,
            input_escrow: *input_escrow_ai.key,
            // Deprecated (fee-from-input model has no output escrow). Field kept
            // for account-layout stability so orders placed by the prior program
            // version still parse and stay cancellable.
            output_escrow: Pubkey::default(),
            dst_ata: *dst_ata_ai.key,
            nonce,
            a_to_b,
            amount_in_total,
            remaining_in: amount_in_total,
            tranche_in,
            min_out_per_tranche,
            interval_secs,
            last_exec_ts: 0,
            expiry_ts,
            keeper_fee_bps,
        };
        order.pack(&mut order_ai.data.borrow_mut());
        Ok(())
    }

    fn execute(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let order_ai = next_account_info(it)?;
        let input_escrow_ai = next_account_info(it)?;
        let dst_ata_ai = next_account_info(it)?;
        let keeper_fee_ai = next_account_info(it)?;
        // DEX swap accounts.
        let dex_program_ai = next_account_info(it)?;
        let pool_ai = next_account_info(it)?; // swapState
        let pool_authority_ai = next_account_info(it)?;
        let src_vault_ai = next_account_info(it)?;
        let dst_vault_ai = next_account_info(it)?;
        let pool_mint_ai = next_account_info(it)?;
        let fee_account_ai = next_account_info(it)?;
        let src_mint_ai = next_account_info(it)?;
        let dst_mint_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        let mut order = Self::load_order(program_id, order_ai)?;
        if !order.is_open() {
            return Err(OrderError::NotOpen.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if order.is_expired(now) {
            return Err(OrderError::NotOpen.into()); // expired → must be cranked, not filled
        }
        if !order.dca_ready(now) {
            return Err(OrderError::IntervalNotElapsed.into());
        }

        // Pin the CPI target + token program (the arbitrary-CPI class), and
        // match every account against Order state.
        Self::check_dex_program(dex_program_ai.key)?;
        Self::check_token_program(token_program_ai.key)?;
        if *pool_ai.key != order.pool
            || *input_escrow_ai.key != order.input_escrow
            || *dst_ata_ai.key != order.dst_ata
        {
            return Err(OrderError::InvalidTokenAccount.into());
        }
        // Fee-from-input model: the swap output lands DIRECTLY in the owner's ATA
        // (no output escrow). Guard that dst_ata really is the owner's, right-mint
        // account so a keeper can't redirect proceeds.
        let dst = spl_token::state::Account::unpack(&dst_ata_ai.data.borrow())?;
        if dst.owner != order.owner || dst.mint != *dst_mint_ai.key {
            return Err(OrderError::InvalidTokenAccount.into());
        }
        // The keeper is paid in the INPUT token, skimmed from the tranche.
        let keeper_fee_acct = spl_token::state::Account::unpack(&keeper_fee_ai.data.borrow())?;
        if keeper_fee_acct.mint != *src_mint_ai.key {
            return Err(OrderError::InvalidTokenAccount.into());
        }

        let tranche = order.next_tranche_in();
        let eff_min_out = order.effective_min_out(tranche)?;
        // Fee from the INPUT side (no output escrow, no gross-up): the keeper
        // takes keeper_fee_bps of the tranche in the input token; the remainder
        // is swapped straight into the owner's ATA with the order's per-tranche
        // floor as the DEX slippage guard. The owner nets the FULL swap output.
        let (keeper_fee, swap_in) = split_output(tranche, order.keeper_fee_bps)?;

        // EFFECTS FIRST: debit + stamp before any external CPI.
        order.debit(tranche)?;
        order.last_exec_ts = now;
        order.pack(&mut order_ai.data.borrow_mut());

        let signer_seeds: &[&[u8]] = &[
            b"order",
            order.owner.as_ref(),
            &order.nonce.to_le_bytes(),
            &[order.bump],
        ];

        // Pay the keeper their input-token fee out of the escrow.
        if keeper_fee > 0 {
            Self::escrow_transfer(
                token_program_ai,
                input_escrow_ai,
                keeper_fee_ai,
                order_ai,
                signer_seeds,
                keeper_fee,
            )?;
        }

        // Swap the remainder straight into the owner's ATA. min_out = the order's
        // per-tranche floor; the DEX's slippage guard reverts an underpriced fill.
        let mut swap_data = Vec::with_capacity(17);
        swap_data.push(0x01u8); // exact-in
        swap_data.extend_from_slice(&swap_in.to_le_bytes());
        swap_data.extend_from_slice(&eff_min_out.to_le_bytes());
        let swap_ix = Instruction {
            program_id: DEX_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(*pool_ai.key, false),
                AccountMeta::new_readonly(*pool_authority_ai.key, false),
                AccountMeta::new_readonly(*order_ai.key, true), // user_transfer_authority = order PDA
                AccountMeta::new(*input_escrow_ai.key, false),
                AccountMeta::new(*src_vault_ai.key, false),
                AccountMeta::new(*dst_vault_ai.key, false),
                AccountMeta::new(*dst_ata_ai.key, false), // destination = owner's ATA (no output escrow)
                AccountMeta::new(*pool_mint_ai.key, false),
                AccountMeta::new(*fee_account_ai.key, false),
                AccountMeta::new_readonly(*src_mint_ai.key, false),
                AccountMeta::new_readonly(*dst_mint_ai.key, false),
                AccountMeta::new_readonly(*token_program_ai.key, false),
                AccountMeta::new_readonly(*token_program_ai.key, false),
                AccountMeta::new_readonly(*token_program_ai.key, false),
            ],
            data: swap_data,
        };
        invoke_signed(
            &swap_ix,
            &[
                pool_ai.clone(),
                pool_authority_ai.clone(),
                order_ai.clone(),
                input_escrow_ai.clone(),
                src_vault_ai.clone(),
                dst_vault_ai.clone(),
                dst_ata_ai.clone(),
                pool_mint_ai.clone(),
                fee_account_ai.clone(),
                src_mint_ai.clone(),
                dst_mint_ai.clone(),
                token_program_ai.clone(),
            ],
            &[signer_seeds],
        )?;
        Ok(())
    }

    fn cancel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let order_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let input_escrow_ai = next_account_info(it)?;
        let owner_src_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        let order = Self::load_order(program_id, order_ai)?;
        Self::check_token_program(token_program_ai.key)?;
        if !owner_ai.is_signer || *owner_ai.key != order.owner {
            return Err(OrderError::Unauthorized.into());
        }
        if !order.is_open() {
            return Err(OrderError::NotOpen.into());
        }
        if *input_escrow_ai.key != order.input_escrow {
            return Err(OrderError::InvalidTokenAccount.into());
        }

        // Refund the token balance, then reclaim ALL rent (escrow ATA + order
        // state account) to the owner — nothing stranded. The order ceases to
        // exist; the app treats a since-closed order as gone (readOrders → null).
        Self::refund_escrow(token_program_ai, input_escrow_ai, owner_src_ai, order_ai, &order)?;
        Self::close_escrow(token_program_ai, input_escrow_ai, owner_ai, order_ai, &order)?;
        Self::close_state_account(order_ai, owner_ai)?;
        Ok(())
    }

    fn crank_expired(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let order_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let input_escrow_ai = next_account_info(it)?;
        let owner_src_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        let order = Self::load_order(program_id, order_ai)?;
        Self::check_token_program(token_program_ai.key)?;
        if !order.is_open() {
            return Err(OrderError::NotOpen.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if !order.is_expired(now) {
            return Err(OrderError::NotExpired.into());
        }
        if *input_escrow_ai.key != order.input_escrow {
            return Err(OrderError::InvalidTokenAccount.into());
        }
        // Permissionless: funds + rent only ever return to the owner's own
        // accounts (token refund → owner_src; SOL rent → owner).
        if *owner_ai.key != order.owner {
            return Err(OrderError::InvalidTokenAccount.into());
        }
        let refund = spl_token::state::Account::unpack(&owner_src_ai.data.borrow())?;
        if refund.owner != order.owner {
            return Err(OrderError::InvalidTokenAccount.into());
        }

        Self::refund_escrow(token_program_ai, input_escrow_ai, owner_src_ai, order_ai, &order)?;
        Self::close_escrow(token_program_ai, input_escrow_ai, owner_ai, order_ai, &order)?;
        Self::close_state_account(order_ai, owner_ai)?;
        Ok(())
    }

    /// Permissionless reclamation of a FILLED order's rent. A fully-executed
    /// order has an empty escrow but its escrow ATA + state account still hold
    /// rent; this closes both, returning the lamports to the owner. Anyone may
    /// call it (a keeper can sweep), but funds only ever go to `order.owner`.
    fn close_filled(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let order_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let input_escrow_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        let order = Self::load_order(program_id, order_ai)?;
        Self::check_token_program(token_program_ai.key)?;
        if order.status != STATUS_FILLED || order.remaining_in != 0 {
            return Err(OrderError::NotOpen.into()); // only fully-filled orders
        }
        if *owner_ai.key != order.owner || *input_escrow_ai.key != order.input_escrow {
            return Err(OrderError::InvalidTokenAccount.into());
        }
        Self::close_escrow(token_program_ai, input_escrow_ai, owner_ai, order_ai, &order)?;
        Self::close_state_account(order_ai, owner_ai)?;
        Ok(())
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /// Load + validate a program-owned, initialized order.
    fn load_order(program_id: &Pubkey, order_ai: &AccountInfo) -> Result<Order, ProgramError> {
        if order_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let order = Order::unpack(&order_ai.data.borrow())?;
        if !order.is_initialized {
            return Err(OrderError::Uninitialized.into());
        }
        Ok(order)
    }

    /// Reject a CPI target that isn't the pinned DEX program (arbitrary-CPI).
    fn check_dex_program(key: &Pubkey) -> ProgramResult {
        if *key != DEX_PROGRAM_ID {
            return Err(OrderError::IncorrectDexProgram.into());
        }
        Ok(())
    }

    /// Reject a token program that isn't SPL Token (arbitrary-CPI; the farm bug).
    fn check_token_program(key: &Pubkey) -> ProgramResult {
        if *key != spl_token::id() {
            return Err(OrderError::IncorrectTokenProgram.into());
        }
        Ok(())
    }

    /// Move `amount` out of an order-PDA-owned escrow (order PDA signs).
    fn escrow_transfer<'a>(
        token_program_ai: &AccountInfo<'a>,
        from_ai: &AccountInfo<'a>,
        to_ai: &AccountInfo<'a>,
        order_ai: &AccountInfo<'a>,
        signer_seeds: &[&[u8]],
        amount: u64,
    ) -> ProgramResult {
        invoke_signed(
            &spl_token::instruction::transfer(
                token_program_ai.key,
                from_ai.key,
                to_ai.key,
                order_ai.key,
                &[],
                amount,
            )?,
            &[from_ai.clone(), to_ai.clone(), order_ai.clone(), token_program_ai.clone()],
            &[signer_seeds],
        )
    }

    /// Refund the full input-escrow balance to the owner's account.
    fn refund_escrow<'a>(
        token_program_ai: &AccountInfo<'a>,
        input_escrow_ai: &AccountInfo<'a>,
        owner_src_ai: &AccountInfo<'a>,
        order_ai: &AccountInfo<'a>,
        order: &Order,
    ) -> ProgramResult {
        let bal = spl_token::state::Account::unpack(&input_escrow_ai.data.borrow())?.amount;
        if bal == 0 {
            return Ok(());
        }
        let signer_seeds: &[&[u8]] = &[
            b"order",
            order.owner.as_ref(),
            &order.nonce.to_le_bytes(),
            &[order.bump],
        ];
        Self::escrow_transfer(
            token_program_ai,
            input_escrow_ai,
            owner_src_ai,
            order_ai,
            signer_seeds,
            bal,
        )
    }

    /// Close the (already-drained) escrow ATA, returning its rent lamports to
    /// `dest` (the order PDA signs). SPL `close_account` requires a zero token
    /// balance, so callers MUST `refund_escrow` first.
    fn close_escrow<'a>(
        token_program_ai: &AccountInfo<'a>,
        input_escrow_ai: &AccountInfo<'a>,
        dest_ai: &AccountInfo<'a>,
        order_ai: &AccountInfo<'a>,
        order: &Order,
    ) -> ProgramResult {
        let signer_seeds: &[&[u8]] = &[
            b"order",
            order.owner.as_ref(),
            &order.nonce.to_le_bytes(),
            &[order.bump],
        ];
        invoke_signed(
            &spl_token::instruction::close_account(
                token_program_ai.key,
                input_escrow_ai.key,
                dest_ai.key,
                order_ai.key,
                &[],
            )?,
            &[
                input_escrow_ai.clone(),
                dest_ai.clone(),
                order_ai.clone(),
                token_program_ai.clone(),
            ],
            &[signer_seeds],
        )
    }

    /// Close the order state account: drain its rent to `dest`, zero its data,
    /// and hand it back to the system program so it's reclaimed. Called only on
    /// a terminal transition (cancel / expiry-crank / filled-close), so the
    /// account is never re-read afterward in the same tx.
    fn close_state_account(order_ai: &AccountInfo, dest_ai: &AccountInfo) -> ProgramResult {
        let rent = order_ai.lamports();
        **dest_ai.try_borrow_mut_lamports()? = dest_ai
            .lamports()
            .checked_add(rent)
            .ok_or(OrderError::Overflow)?;
        **order_ai.try_borrow_mut_lamports()? = 0;
        // Zero the data; a 0-lamport account is reclaimed by the runtime at
        // tx-end. These are terminal single-purpose txs (nothing re-reads the
        // account afterward), so no same-tx revival is possible.
        order_ai.resize(0)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_dex_program_pins_target() {
        assert!(Processor::check_dex_program(&DEX_PROGRAM_ID).is_ok());
        let err = Processor::check_dex_program(&Pubkey::new_unique()).unwrap_err();
        assert_eq!(err, OrderError::IncorrectDexProgram.into());
    }

    #[test]
    fn check_token_program_pins_spl() {
        assert!(Processor::check_token_program(&spl_token::id()).is_ok());
        let err = Processor::check_token_program(&Pubkey::new_unique()).unwrap_err();
        assert_eq!(err, OrderError::IncorrectTokenProgram.into());
    }
}
