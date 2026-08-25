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
        // Unpacking alone only proves the BYTES decode like a token account —
        // a foreign-program account can satisfy that. Pin the owning program
        // first so the guard means what it reads as.
        if *owner_src_ai.owner != spl_token::id() {
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
    /// order's escrow should be empty, but anyone can donate to the (public,
    /// derivable) escrow ATA — SPL `close_account` reverts on a nonzero
    /// balance — so any residue is refunded to the owner first, then both the
    /// escrow ATA and the state account are closed, returning the lamports to
    /// the owner. Anyone may call it (a keeper can sweep), but funds only ever
    /// go to `order.owner`.
    fn close_filled(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let order_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let input_escrow_ai = next_account_info(it)?;
        let owner_src_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        let order = Self::load_order(program_id, order_ai)?;
        Self::check_token_program(token_program_ai.key)?;
        if order.status != STATUS_FILLED || order.remaining_in != 0 {
            return Err(OrderError::NotOpen.into()); // only fully-filled orders
        }
        if *owner_ai.key != order.owner || *input_escrow_ai.key != order.input_escrow {
            return Err(OrderError::InvalidTokenAccount.into());
        }
        // Permissionless: the refund destination must be the owner's own
        // account (mirrors crank_expired) — otherwise a caller could name
        // their own account and steal a donated/residual balance.
        // Unpacking alone only proves the BYTES decode like a token account —
        // a foreign-program account can satisfy that. Pin the owning program
        // first so the guard means what it reads as.
        if *owner_src_ai.owner != spl_token::id() {
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
    use std::{cell::RefCell, sync::Once};

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

    // ── close_filled refund-before-close fixtures ──────────────────────────
    //
    // `solana_program::program::invoke_signed` (what `escrow_transfer` and
    // `close_escrow` call) dispatches to `program_stubs::sol_invoke_signed` on
    // a non-`solana` target, which forwards to the installed `SyscallStubs`.
    // That trait's `sol_invoke_signed` IS overridable at the pinned
    // solana-program 2.1.0 (resolves to 2.3.0; confirmed by reading
    // solana-cpi 2.2.1 / solana-program-2.3.0's `program.rs`), so a recording
    // stub can capture the emitted CPI sequence — decoding the SPL tag +
    // amount straight out of `Instruction::data` — without touching real SPL
    // runtime state. Stub installation follows the `farm` crate's pattern:
    // `std::sync::Once`, since syscall stubs are process-global but cargo
    // runs tests on separate threads; the per-test recording buffer itself is
    // a `thread_local`, cleared at the start of each test.

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum RecordedIx {
        Transfer { amount: u64, source: Pubkey, destination: Pubkey },
        CloseAccount { destination: Pubkey },
    }

    thread_local! {
        static RECORDED: RefCell<Vec<RecordedIx>> = RefCell::new(Vec::new());
        // crank_expired reaches Clock::get(); only one syscall-stub impl can be
        // installed globally, so the recorder serves the clock too. Per-thread
        // so parallel tests cannot race on "now".
        static NOW: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };
    }

    struct RecordingStubs;
    impl solana_program::program_stubs::SyscallStubs for RecordingStubs {
        fn sol_invoke_signed(
            &self,
            instruction: &Instruction,
            _account_infos: &[AccountInfo],
            _signers_seeds: &[&[&[u8]]],
        ) -> ProgramResult {
            let data = &instruction.data;
            // SPL Transfer's accounts are [source, destination, authority];
            // CloseAccount's are [account, destination, authority] — pin
            // both source and destination so a mutant that swaps the refund
            // destination (e.g. to a self-transfer, or to the wrong party)
            // shows up as a recorded-value mismatch, not just a tag/amount
            // match.
            let rec = match data[0] {
                3 => RecordedIx::Transfer {
                    amount: u64::from_le_bytes(data[1..9].try_into().unwrap()),
                    source: instruction.accounts[0].pubkey,
                    destination: instruction.accounts[1].pubkey,
                },
                9 => RecordedIx::CloseAccount { destination: instruction.accounts[1].pubkey },
                other => panic!("unexpected CPI tag in close_filled test: {other}"),
            };
            RECORDED.with(|r| r.borrow_mut().push(rec));
            Ok(())
        }

        fn sol_get_clock_sysvar(&self, var_addr: *mut u8) -> u64 {
            let clock = solana_program::clock::Clock {
                slot: 0,
                epoch_start_timestamp: 0,
                epoch: 0,
                leader_schedule_epoch: 0,
                unix_timestamp: NOW.with(|n| n.get()),
            };
            unsafe { std::ptr::write(var_addr as *mut solana_program::clock::Clock, clock) };
            solana_program::entrypoint::SUCCESS
        }
    }

    static STUBS_INIT: Once = Once::new();

    /// Install the recording stub (once) and clear this thread's recorded-CPI
    /// buffer for the calling test.
    fn record_cpis() {
        STUBS_INIT.call_once(|| {
            solana_program::program_stubs::set_syscall_stubs(Box::new(RecordingStubs));
        });
        RECORDED.with(|r| r.borrow_mut().clear());
    }

    /// Set this thread's clock for the calling test (stub installed by
    /// `record_cpis`, which every test that needs either calls first).
    fn set_clock(now: i64) {
        record_cpis();
        NOW.with(|n| n.set(now));
    }

    fn recorded() -> Vec<RecordedIx> {
        RECORDED.with(|r| r.borrow().clone())
    }

    /// A fabricated account, owning its own buffers so `AccountInfo::new` can
    /// borrow them for the duration of one call.
    ///
    /// `data` carries 8 bytes of leading slack before the logical account
    /// bytes. `AccountInfo::resize` writes the new length 8 bytes *before*
    /// the data pointer it's given (see `solana-account-info-2.3.0/src/lib.rs:166-174`) —
    /// on-chain those bytes are the runtime's serialized input-buffer length
    /// prefix, so the write is valid there. A host fixture that hands
    /// `AccountInfo::new` a bare `Vec<u8>` has no such prefix, so that write
    /// lands in the allocator's own chunk header: harmless on macOS (whose
    /// allocator keeps metadata elsewhere) but corrupts glibc's malloc
    /// bookkeeping, surfacing as `free(): invalid pointer` at process exit.
    /// Owning the 8 bytes ourselves keeps the write inside memory we hold.
    struct Acc {
        key: Pubkey,
        lamports: u64,
        data: Vec<u8>,
        owner: Pubkey,
    }

    impl Acc {
        fn new(key: Pubkey, owner: Pubkey, data: Vec<u8>) -> Self {
            let mut acc = Acc { key, lamports: 0, data: Vec::new(), owner };
            acc.set_data(data);
            acc
        }
        fn info(&mut self) -> AccountInfo<'_> {
            AccountInfo::new(&self.key, false, true, &mut self.lamports, &mut self.data[8..], &self.owner, false, 0)
        }
        /// Logical account bytes, i.e. `data` minus the leading 8-byte slack
        /// `AccountInfo::resize` needs to write into. Tests that want to
        /// read or rewrite an account's contents must go through this /
        /// `set_data`, never the raw `data` field.
        fn data(&self) -> &[u8] {
            &self.data[8..]
        }
        fn set_data(&mut self, data: Vec<u8>) {
            let mut buf = vec![0u8; 8 + data.len()];
            buf[8..].copy_from_slice(&data);
            self.data = buf;
        }
    }

    fn accounts_of<'a>(accs: Vec<&'a mut Acc>) -> Vec<AccountInfo<'a>> {
        accs.into_iter().map(Acc::info).collect()
    }

    fn token_account_data(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
        let account = spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: solana_program::program_option::COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: solana_program::program_option::COption::None,
            delegated_amount: 0,
            close_authority: solana_program::program_option::COption::None,
        };
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account::pack(account, &mut data).unwrap();
        data
    }

    fn order_data(order: &Order) -> Vec<u8> {
        let mut data = vec![0u8; ORDER_LEN];
        order.pack(&mut data);
        data
    }

    /// A packed FILLED order + its escrow ATA (owned by the order PDA) + a
    /// candidate refund destination. `owner_src_authority` overrides the
    /// refund destination's SPL `owner` (authority) field — `None` means the
    /// happy path (== the order's owner); `Some(x)` exercises the guard.
    struct CloseFilledFixture {
        program_id: Pubkey,
        order: Acc,
        owner: Acc,
        escrow: Acc,
        owner_src: Acc,
        token_program: Acc,
    }

    fn close_filled_fixture(escrow_amount: u64, owner_src_authority: Option<Pubkey>) -> CloseFilledFixture {
        let program_id = Pubkey::new_unique();
        let owner_key = Pubkey::new_unique();
        let nonce: u64 = 3;
        let (order_key, bump) =
            Pubkey::find_program_address(&[b"order", owner_key.as_ref(), &nonce.to_le_bytes()], &program_id);
        let escrow_key = Pubkey::new_unique();
        let mint = Pubkey::new_unique();

        let order = Order {
            is_initialized: true,
            bump,
            status: STATUS_FILLED,
            owner: owner_key,
            pool: Pubkey::new_unique(),
            input_escrow: escrow_key,
            output_escrow: Pubkey::new_unique(),
            dst_ata: Pubkey::new_unique(),
            nonce,
            a_to_b: true,
            amount_in_total: 1_000_000,
            remaining_in: 0,
            tranche_in: 1_000_000,
            min_out_per_tranche: 0,
            interval_secs: 0,
            last_exec_ts: 0,
            expiry_ts: 0,
            keeper_fee_bps: 0,
        };

        CloseFilledFixture {
            order: Acc::new(order_key, program_id, order_data(&order)),
            owner: Acc::new(owner_key, Pubkey::default(), vec![]),
            escrow: Acc::new(escrow_key, spl_token::id(), token_account_data(mint, order_key, escrow_amount)),
            owner_src: Acc::new(
                Pubkey::new_unique(),
                spl_token::id(),
                token_account_data(mint, owner_src_authority.unwrap_or(owner_key), 0),
            ),
            token_program: Acc::new(spl_token::id(), Pubkey::default(), vec![]),
            program_id,
        }
    }

    impl CloseFilledFixture {
        fn call(&mut self) -> ProgramResult {
            let infos = accounts_of(vec![
                &mut self.order,
                &mut self.owner,
                &mut self.escrow,
                &mut self.owner_src,
                &mut self.token_program,
            ]);
            Processor::close_filled(&self.program_id, &infos)
        }
    }

    // The refund-destination guard unpacks `owner_src` as a token account but
    // never checked WHICH PROGRAM owns it, so a foreign-program account whose
    // bytes happen to decode with `owner == order.owner` satisfied it. Harmless
    // on every reachable path today (SPL rejects a non-token destination when
    // funds actually move, and the zero-balance path moves nothing), but the
    // guard read as validating a token account while only validating bytes that
    // decode like one.
    // crank_expired carries the identical guard, so it needs its own test —
    // the close_filled test above passes even with crank's copy deleted.
    // Reuses the close_filled fixture: crank takes the same first four
    // accounts, and the guard runs before any status check, so an OPEN-vs-
    // FILLED difference cannot mask the refusal.
    #[test]
    fn crank_expired_rejects_owner_src_not_owned_by_token_program() {
        // crank needs an OPEN, EXPIRED order, so rebuild the order account as
        // OPEN and put the clock past its expiry. The guard sits after those
        // checks, so both must pass for the refusal to be the thing observed.
        let mut fx = close_filled_fixture(7, None);
        let mut order = Order::unpack(fx.order.data()).unwrap();
        order.status = crate::state::STATUS_OPEN;
        order.expiry_ts = 100;
        fx.order.set_data(order_data(&order));
        set_clock(1_000);
        fx.owner_src.owner = Pubkey::new_unique();
        let infos = accounts_of(vec![
            &mut fx.order,
            &mut fx.owner,
            &mut fx.escrow,
            &mut fx.owner_src,
            &mut fx.token_program,
        ]);
        assert_eq!(
            Processor::crank_expired(&fx.program_id, &infos).unwrap_err(),
            OrderError::InvalidTokenAccount.into(),
            "crank_expired must reject a non-token-program refund destination too"
        );
    }

    #[test]
    fn close_filled_rejects_owner_src_not_owned_by_token_program() {
        let mut fx = close_filled_fixture(7, None);
        // Same bytes, same decoded authority — only the owning program differs.
        fx.owner_src.owner = Pubkey::new_unique();
        assert_eq!(
            fx.call().unwrap_err(),
            OrderError::InvalidTokenAccount.into(),
            "a non-token-program account must not satisfy the refund-destination guard"
        );
    }

    // U1 — the theft guard: before the fix, `close_filled` reads only 4
    // accounts and ignores a 5th, so a stranger-owned `owner_src` is never
    // checked and the (no-op) CPIs "succeed".
    #[test]
    fn close_filled_rejects_owner_src_not_owned_by_order_owner() {
        record_cpis();
        let stranger = Pubkey::new_unique();
        let mut f = close_filled_fixture(1, Some(stranger));
        let err = f.call().unwrap_err();
        assert_eq!(err, OrderError::InvalidTokenAccount.into());
        assert!(recorded().is_empty(), "the guard must reject before any CPI is attempted");
    }

    // U2 — before the fix, `close_filled` never refunds, so the recorded
    // sequence would be `[CloseAccount]` only and this fails. The
    // source/destination asserts additionally pin *where* the refund goes:
    // a mutant that redirects it to the wrong owner account, or to the
    // escrow itself (an SPL self-transfer — a no-op that would silently
    // reintroduce the pre-fix bug), must also fail here.
    #[test]
    fn close_filled_refunds_full_balance_before_close() {
        record_cpis();
        let mut f = close_filled_fixture(7, None);
        let escrow_key = f.escrow.key;
        let owner_src_key = f.owner_src.key;
        let owner_key = f.owner.key;
        f.call().unwrap();
        assert_eq!(
            recorded(),
            vec![
                RecordedIx::Transfer { amount: 7, source: escrow_key, destination: owner_src_key },
                RecordedIx::CloseAccount { destination: owner_key },
            ]
        );
    }

    // U3 — guard: a zero escrow balance skips the transfer CPI (refund_escrow's
    // documented early-return) but the refund-destination check still runs
    // unconditionally — a wrong `owner_src` on a zero-balance order is still
    // rejected, not silently allowed through.
    #[test]
    fn close_filled_zero_balance_emits_close_only() {
        record_cpis();
        let mut f = close_filled_fixture(0, None);
        let owner_key = f.owner.key;
        f.call().unwrap();
        assert_eq!(recorded(), vec![RecordedIx::CloseAccount { destination: owner_key }]);

        record_cpis();
        let stranger = Pubkey::new_unique();
        let mut wrong = close_filled_fixture(0, Some(stranger));
        let err = wrong.call().unwrap_err();
        assert_eq!(err, OrderError::InvalidTokenAccount.into());
    }

    // U4 — regression: the pre-existing FILLED-only status gate still rejects
    // an OPEN order.
    #[test]
    fn close_filled_rejects_open_status() {
        record_cpis();
        let mut f = close_filled_fixture(0, None);
        let mut order = Order::unpack(f.order.data()).unwrap();
        order.status = crate::state::STATUS_OPEN;
        order.remaining_in = 1_000_000;
        f.order.set_data(order_data(&order));
        let err = f.call().unwrap_err();
        assert_eq!(err, OrderError::NotOpen.into());
    }
}
