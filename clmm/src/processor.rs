//! CLMM instruction processing — a thin account-validation wrapper over the
//! host-tested [`crate::engine`].
//!
//! Trust model (orders-program posture): the token program is pinned to SPL
//! Token; every vault / position / tick-array account is matched against the
//! program-owned state it must correspond to (never trusted from the caller);
//! pool vaults are the pool PDA's ATAs (verified derivation, so no attacker-
//! seeded delegate/close-authority surface); state is packed before any CPI.
//! Owner-gated paths take the owner as ONE signer — authority-agnostic for
//! the dual-lane seam.

use {
    crate::{
        curve::tick_math::{
            get_tick_at_sqrt_price, MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK,
        },
        engine::{self, ArrayRefMut},
        error::ClmmError,
        instruction::ClmmInstruction,
        state::{
            check_tick, pack_tick_array_header, tick_array_start_index, unpack_tick_array_header,
            Pool, Position, POOL_LEN, POOL_SEED, POSITION_LEN, POSITION_SEED, TICK_ARRAY_LEN,
            TICK_ARRAY_SEED, TICK_ARRAY_SIZE,
        },
    },
    solana_program::{
        account_info::{next_account_info, AccountInfo},
        entrypoint::ProgramResult,
        program::{invoke, invoke_signed},
        program_error::ProgramError,
        program_pack::Pack,
        pubkey::Pubkey,
        rent::Rent,
        system_instruction,
        sysvar::Sysvar,
    },
};

/// The SPL Associated Token Account program (vault-derivation pin).
pub const ATA_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Hard cap on the pool fee: 10% (100_000 pips).
pub const MAX_FEE_PIPS: u32 = 100_000;

/// CLMM instruction processor.
pub struct Processor;

impl Processor {
    /// Route an instruction to its handler.
    pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        match ClmmInstruction::unpack(data)? {
            ClmmInstruction::InitPool { bump, fee_pips, tick_spacing, sqrt_price } => {
                Self::init_pool(program_id, accounts, bump, fee_pips, tick_spacing, sqrt_price)
            }
            ClmmInstruction::InitTickArray { start_tick_index, bump } => {
                Self::init_tick_array(program_id, accounts, start_tick_index, bump)
            }
            ClmmInstruction::OpenPosition { tick_lower, tick_upper, bump } => {
                Self::open_position(program_id, accounts, tick_lower, tick_upper, bump)
            }
            ClmmInstruction::IncreaseLiquidity { liquidity_delta, amount_0_max, amount_1_max } => {
                Self::modify_liquidity(
                    program_id,
                    accounts,
                    i128::try_from(liquidity_delta).map_err(|_| ClmmError::InvalidParams)?,
                    amount_0_max,
                    amount_1_max,
                )
            }
            ClmmInstruction::DecreaseLiquidity { liquidity_delta, amount_0_min, amount_1_min } => {
                let delta = i128::try_from(liquidity_delta)
                    .map_err(|_| ClmmError::InvalidParams)?
                    .checked_neg()
                    .ok_or(ClmmError::InvalidParams)?;
                Self::modify_liquidity(program_id, accounts, delta, amount_0_min, amount_1_min)
            }
            ClmmInstruction::Collect => Self::collect(program_id, accounts),
            ClmmInstruction::ClosePosition => Self::close_position(program_id, accounts),
            ClmmInstruction::Swap { zero_for_one, amount_in, min_amount_out, sqrt_price_limit } => {
                Self::swap(
                    program_id,
                    accounts,
                    zero_for_one,
                    amount_in,
                    min_amount_out,
                    sqrt_price_limit,
                )
            }
        }
    }

    fn init_pool(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        bump: u8,
        fee_pips: u32,
        tick_spacing: u16,
        sqrt_price: u128,
    ) -> ProgramResult {
        let it = &mut accounts.iter();
        let pool_ai = next_account_info(it)?;
        let mint_0_ai = next_account_info(it)?;
        let mint_1_ai = next_account_info(it)?;
        let vault_0_ai = next_account_info(it)?;
        let vault_1_ai = next_account_info(it)?;
        let payer_ai = next_account_info(it)?;
        let system_program_ai = next_account_info(it)?;

        if !payer_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        check_pool_params(fee_pips, tick_spacing, sqrt_price)?;
        // Canonical mint order de-duplicates the (pair, fee) space.
        if mint_0_ai.key.as_ref() >= mint_1_ai.key.as_ref() {
            return Err(ClmmError::InvalidParams.into());
        }

        let fee_le = fee_pips.to_le_bytes();
        let seeds: &[&[u8]] =
            &[POOL_SEED, mint_0_ai.key.as_ref(), mint_1_ai.key.as_ref(), &fee_le];
        let (expected, expected_bump) = Pubkey::find_program_address(seeds, program_id);
        if expected != *pool_ai.key || expected_bump != bump {
            return Err(ClmmError::AddressMismatch.into());
        }
        if pool_ai.owner == program_id {
            return Err(ClmmError::AlreadyInitialized.into());
        }

        // Vaults must be the pool PDA's ATAs: deterministic addresses, created
        // by the standard ATA path (no delegate / close-authority surface).
        for (vault_ai, mint_ai) in [(vault_0_ai, mint_0_ai), (vault_1_ai, mint_1_ai)] {
            let (want, _) = Pubkey::find_program_address(
                &[pool_ai.key.as_ref(), spl_token::id().as_ref(), mint_ai.key.as_ref()],
                &ATA_PROGRAM_ID,
            );
            if want != *vault_ai.key {
                return Err(ClmmError::AddressMismatch.into());
            }
            let acct = spl_token::state::Account::unpack(&vault_ai.data.borrow())?;
            if acct.owner != *pool_ai.key || acct.mint != *mint_ai.key {
                return Err(ClmmError::InvalidTokenAccount.into());
            }
        }

        let signer_seeds: &[&[u8]] =
            &[POOL_SEED, mint_0_ai.key.as_ref(), mint_1_ai.key.as_ref(), &fee_le, &[bump]];
        Self::create_pda_account(payer_ai, pool_ai, system_program_ai, program_id, POOL_LEN, signer_seeds)?;

        let pool = Pool {
            is_initialized: true,
            bump,
            mint_0: *mint_0_ai.key,
            mint_1: *mint_1_ai.key,
            vault_0: *vault_0_ai.key,
            vault_1: *vault_1_ai.key,
            fee_pips,
            tick_spacing,
            current_tick: get_tick_at_sqrt_price(sqrt_price)?,
            sqrt_price,
            liquidity: 0,
            fee_growth_global_0: 0,
            fee_growth_global_1: 0,
        };
        pool.pack(&mut pool_ai.data.borrow_mut());
        Ok(())
    }

    fn init_tick_array(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        start_tick_index: i32,
        bump: u8,
    ) -> ProgramResult {
        let it = &mut accounts.iter();
        let pool_ai = next_account_info(it)?;
        let tick_array_ai = next_account_info(it)?;
        let payer_ai = next_account_info(it)?;
        let system_program_ai = next_account_info(it)?;

        if !payer_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        let pool = Self::load_pool(program_id, pool_ai)?;
        // Aligned to the array span and overlapping the usable tick band.
        let span = TICK_ARRAY_SIZE as i32 * pool.tick_spacing as i32;
        if tick_array_start_index(start_tick_index, pool.tick_spacing) != start_tick_index
            || start_tick_index > MAX_TICK
            || start_tick_index + span <= MIN_TICK
        {
            return Err(ClmmError::InvalidParams.into());
        }

        let start_le = start_tick_index.to_le_bytes();
        let seeds: &[&[u8]] = &[TICK_ARRAY_SEED, pool_ai.key.as_ref(), &start_le];
        let (expected, expected_bump) = Pubkey::find_program_address(seeds, program_id);
        if expected != *tick_array_ai.key || expected_bump != bump {
            return Err(ClmmError::AddressMismatch.into());
        }
        if tick_array_ai.owner == program_id {
            return Err(ClmmError::AlreadyInitialized.into());
        }

        let signer_seeds: &[&[u8]] =
            &[TICK_ARRAY_SEED, pool_ai.key.as_ref(), &start_le, &[bump]];
        Self::create_pda_account(
            payer_ai,
            tick_array_ai,
            system_program_ai,
            program_id,
            TICK_ARRAY_LEN,
            signer_seeds,
        )?;
        pack_tick_array_header(
            &mut tick_array_ai.data.borrow_mut(),
            bump,
            pool_ai.key,
            start_tick_index,
        );
        Ok(())
    }

    fn open_position(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        tick_lower: i32,
        tick_upper: i32,
        bump: u8,
    ) -> ProgramResult {
        let it = &mut accounts.iter();
        let pool_ai = next_account_info(it)?;
        let position_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let payer_ai = next_account_info(it)?;
        let system_program_ai = next_account_info(it)?;

        if !payer_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        let pool = Self::load_pool(program_id, pool_ai)?;
        check_tick(tick_lower, pool.tick_spacing)?;
        check_tick(tick_upper, pool.tick_spacing)?;
        if tick_lower >= tick_upper {
            return Err(ClmmError::InvalidTickRange.into());
        }

        let (lower_le, upper_le) = (tick_lower.to_le_bytes(), tick_upper.to_le_bytes());
        let seeds: &[&[u8]] = &[
            POSITION_SEED,
            pool_ai.key.as_ref(),
            owner_ai.key.as_ref(),
            &lower_le,
            &upper_le,
        ];
        let (expected, expected_bump) = Pubkey::find_program_address(seeds, program_id);
        if expected != *position_ai.key || expected_bump != bump {
            return Err(ClmmError::AddressMismatch.into());
        }
        if position_ai.owner == program_id {
            return Err(ClmmError::AlreadyInitialized.into());
        }

        let signer_seeds: &[&[u8]] = &[
            POSITION_SEED,
            pool_ai.key.as_ref(),
            owner_ai.key.as_ref(),
            &lower_le,
            &upper_le,
            &[bump],
        ];
        Self::create_pda_account(
            payer_ai,
            position_ai,
            system_program_ai,
            program_id,
            POSITION_LEN,
            signer_seeds,
        )?;
        let position = Position {
            is_initialized: true,
            bump,
            pool: *pool_ai.key,
            owner: *owner_ai.key,
            tick_lower,
            tick_upper,
            ..Position::default()
        };
        position.pack(&mut position_ai.data.borrow_mut());
        Ok(())
    }

    /// Shared Increase/Decrease path. `liquidity_delta` signed; for a decrease
    /// the two bounds are minimums, for an increase maximums.
    fn modify_liquidity(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        liquidity_delta: i128,
        bound_0: u64,
        bound_1: u64,
    ) -> ProgramResult {
        let it = &mut accounts.iter();
        let pool_ai = next_account_info(it)?;
        let position_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let owner_ata_0_ai = next_account_info(it)?;
        let owner_ata_1_ai = next_account_info(it)?;
        let vault_0_ai = next_account_info(it)?;
        let vault_1_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;
        let ta_lower_ai = next_account_info(it)?;
        let ta_upper_ai = next_account_info(it)?;

        check_token_program(token_program_ai.key)?;
        let mut pool = Self::load_pool(program_id, pool_ai)?;
        let mut position = Self::load_position(program_id, position_ai)?;
        if !owner_ai.is_signer || *owner_ai.key != position.owner {
            return Err(ClmmError::Unauthorized.into());
        }
        if position.pool != *pool_ai.key
            || *vault_0_ai.key != pool.vault_0
            || *vault_1_ai.key != pool.vault_1
        {
            return Err(ClmmError::InvalidTokenAccount.into());
        }

        // Tick arrays: program-owned, belong to this pool; window built from
        // their self-declared starts (same account may back both bounds).
        let (amount_0, amount_1) = {
            let same = ta_lower_ai.key == ta_upper_ai.key;
            let mut d_lower = Self::checked_array_data(program_id, pool_ai, ta_lower_ai)?;
            let mut d_upper = if same {
                None
            } else {
                Some(Self::checked_array_data(program_id, pool_ai, ta_upper_ai)?)
            };
            let mut window = Vec::with_capacity(2);
            let start = unpack_tick_array_header(&d_lower)?.2;
            window.push(ArrayRefMut { start, data: &mut d_lower[..] });
            if let Some(d) = d_upper.as_mut() {
                let start = unpack_tick_array_header(d)?.2;
                window.push(ArrayRefMut { start, data: &mut d[..] });
            }
            engine::modify_position(&mut pool, &mut position, &mut window, liquidity_delta)?
        };
        let amount_0 = u64::try_from(amount_0).map_err(|_| ClmmError::MathOverflow)?;
        let amount_1 = u64::try_from(amount_1).map_err(|_| ClmmError::MathOverflow)?;

        // Slippage bounds: pay-in capped above, pay-out floored below.
        let within = if liquidity_delta >= 0 {
            amount_0 <= bound_0 && amount_1 <= bound_1
        } else {
            amount_0 >= bound_0 && amount_1 >= bound_1
        };
        if !within {
            return Err(ClmmError::SlippageExceeded.into());
        }

        // Effects first: persist state, then move tokens.
        pool.pack(&mut pool_ai.data.borrow_mut());
        position.pack(&mut position_ai.data.borrow_mut());

        let transfers = [
            (owner_ata_0_ai, vault_0_ai, amount_0),
            (owner_ata_1_ai, vault_1_ai, amount_1),
        ];
        for (owner_ata_ai, vault_ai, amount) in transfers {
            if amount == 0 {
                continue;
            }
            if liquidity_delta >= 0 {
                invoke(
                    &spl_token::instruction::transfer(
                        token_program_ai.key,
                        owner_ata_ai.key,
                        vault_ai.key,
                        owner_ai.key,
                        &[],
                        amount,
                    )?,
                    &[
                        owner_ata_ai.clone(),
                        vault_ai.clone(),
                        owner_ai.clone(),
                        token_program_ai.clone(),
                    ],
                )?;
            } else {
                Self::vault_transfer(
                    &pool,
                    token_program_ai,
                    vault_ai,
                    owner_ata_ai,
                    pool_ai,
                    amount,
                )?;
            }
        }
        Ok(())
    }

    fn collect(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let pool_ai = next_account_info(it)?;
        let position_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let owner_ata_0_ai = next_account_info(it)?;
        let owner_ata_1_ai = next_account_info(it)?;
        let vault_0_ai = next_account_info(it)?;
        let vault_1_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        check_token_program(token_program_ai.key)?;
        let pool = Self::load_pool(program_id, pool_ai)?;
        let mut position = Self::load_position(program_id, position_ai)?;
        if !owner_ai.is_signer || *owner_ai.key != position.owner {
            return Err(ClmmError::Unauthorized.into());
        }
        if position.pool != *pool_ai.key
            || *vault_0_ai.key != pool.vault_0
            || *vault_1_ai.key != pool.vault_1
        {
            return Err(ClmmError::InvalidTokenAccount.into());
        }

        let (owed_0, owed_1) = (position.tokens_owed_0, position.tokens_owed_1);
        // Effects first.
        position.tokens_owed_0 = 0;
        position.tokens_owed_1 = 0;
        position.pack(&mut position_ai.data.borrow_mut());

        if owed_0 > 0 {
            Self::vault_transfer(&pool, token_program_ai, vault_0_ai, owner_ata_0_ai, pool_ai, owed_0)?;
        }
        if owed_1 > 0 {
            Self::vault_transfer(&pool, token_program_ai, vault_1_ai, owner_ata_1_ai, pool_ai, owed_1)?;
        }
        Ok(())
    }

    fn close_position(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let position_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;

        let position = Self::load_position(program_id, position_ai)?;
        if !owner_ai.is_signer || *owner_ai.key != position.owner {
            return Err(ClmmError::Unauthorized.into());
        }
        if position.liquidity != 0 || position.tokens_owed_0 != 0 || position.tokens_owed_1 != 0 {
            return Err(ClmmError::InvalidParams.into());
        }
        // Drain rent to the owner and hand the account back to the runtime.
        let rent = position_ai.lamports();
        **owner_ai.try_borrow_mut_lamports()? = owner_ai
            .lamports()
            .checked_add(rent)
            .ok_or(ClmmError::MathOverflow)?;
        **position_ai.try_borrow_mut_lamports()? = 0;
        position_ai.resize(0)?;
        Ok(())
    }

    fn swap(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        zero_for_one: bool,
        amount_in: u64,
        min_amount_out: u64,
        sqrt_price_limit: u128,
    ) -> ProgramResult {
        let it = &mut accounts.iter();
        let pool_ai = next_account_info(it)?;
        let authority_ai = next_account_info(it)?;
        let user_src_ai = next_account_info(it)?;
        let user_dst_ai = next_account_info(it)?;
        let vault_0_ai = next_account_info(it)?;
        let vault_1_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;
        let tick_array_ais: Vec<&AccountInfo> = it.collect();

        check_token_program(token_program_ai.key)?;
        if !authority_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        let mut pool = Self::load_pool(program_id, pool_ai)?;
        if *vault_0_ai.key != pool.vault_0 || *vault_1_ai.key != pool.vault_1 {
            return Err(ClmmError::InvalidTokenAccount.into());
        }
        if tick_array_ais.is_empty() || tick_array_ais.len() > 3 {
            return Err(ClmmError::InvalidTickArraySequence.into());
        }
        for w in tick_array_ais.windows(2) {
            if w[0].key == w[1].key {
                return Err(ClmmError::InvalidTickArraySequence.into());
            }
        }
        let limit = default_limit(zero_for_one, sqrt_price_limit);

        let outcome = {
            let mut datas = Vec::with_capacity(tick_array_ais.len());
            for ai in &tick_array_ais {
                datas.push(Self::checked_array_data(program_id, pool_ai, ai)?);
            }
            let mut window = Vec::with_capacity(datas.len());
            for d in datas.iter_mut() {
                let start = unpack_tick_array_header(d)?.2;
                window.push(ArrayRefMut { start, data: &mut d[..] });
            }
            engine::swap(&pool, &mut window, zero_for_one, amount_in, limit)?
        };
        if outcome.amount_out < min_amount_out {
            return Err(ClmmError::SlippageExceeded.into());
        }

        // Effects first: persist the pool, then move tokens.
        pool.sqrt_price = outcome.sqrt_price;
        pool.current_tick = outcome.current_tick;
        pool.liquidity = outcome.liquidity;
        if zero_for_one {
            pool.fee_growth_global_0 = outcome.fee_growth_global_in;
        } else {
            pool.fee_growth_global_1 = outcome.fee_growth_global_in;
        }
        pool.pack(&mut pool_ai.data.borrow_mut());

        let (vault_in_ai, vault_out_ai) = if zero_for_one {
            (vault_0_ai, vault_1_ai)
        } else {
            (vault_1_ai, vault_0_ai)
        };
        let pay_in = outcome
            .amount_in
            .checked_add(outcome.fee)
            .ok_or(ClmmError::MathOverflow)?;
        if pay_in > 0 {
            invoke(
                &spl_token::instruction::transfer(
                    token_program_ai.key,
                    user_src_ai.key,
                    vault_in_ai.key,
                    authority_ai.key,
                    &[],
                    pay_in,
                )?,
                &[
                    user_src_ai.clone(),
                    vault_in_ai.clone(),
                    authority_ai.clone(),
                    token_program_ai.clone(),
                ],
            )?;
        }
        if outcome.amount_out > 0 {
            Self::vault_transfer(
                &pool,
                token_program_ai,
                vault_out_ai,
                user_dst_ai,
                pool_ai,
                outcome.amount_out,
            )?;
        }
        Ok(())
    }

    /// Create a program-owned PDA account, robust to lamport pre-funding: a
    /// bare `create_account` fails if the address already holds lamports, and
    /// pool / tick-array / position addresses are CANONICAL — an attacker
    /// donating 1 lamport would otherwise brick that address forever. Top up
    /// to rent-exemption, then allocate + assign (PDA signs).
    fn create_pda_account<'a>(
        payer_ai: &AccountInfo<'a>,
        target_ai: &AccountInfo<'a>,
        system_program_ai: &AccountInfo<'a>,
        program_id: &Pubkey,
        space: usize,
        signer_seeds: &[&[u8]],
    ) -> ProgramResult {
        let required = Rent::get()?.minimum_balance(space);
        let current = target_ai.lamports();
        if current == 0 {
            return invoke_signed(
                &system_instruction::create_account(
                    payer_ai.key,
                    target_ai.key,
                    required,
                    space as u64,
                    program_id,
                ),
                &[payer_ai.clone(), target_ai.clone(), system_program_ai.clone()],
                &[signer_seeds],
            );
        }
        if current < required {
            invoke(
                &system_instruction::transfer(payer_ai.key, target_ai.key, required - current),
                &[payer_ai.clone(), target_ai.clone(), system_program_ai.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(target_ai.key, space as u64),
            &[target_ai.clone(), system_program_ai.clone()],
            &[signer_seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(target_ai.key, program_id),
            &[target_ai.clone(), system_program_ai.clone()],
            &[signer_seeds],
        )
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /// Load + validate a program-owned, initialized pool.
    fn load_pool(program_id: &Pubkey, pool_ai: &AccountInfo) -> Result<Pool, ProgramError> {
        if pool_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let pool = Pool::unpack(&pool_ai.data.borrow())?;
        if !pool.is_initialized {
            return Err(ClmmError::Uninitialized.into());
        }
        Ok(pool)
    }

    /// Load + validate a program-owned, initialized position.
    fn load_position(
        program_id: &Pubkey,
        position_ai: &AccountInfo,
    ) -> Result<Position, ProgramError> {
        if position_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let position = Position::unpack(&position_ai.data.borrow())?;
        if !position.is_initialized {
            return Err(ClmmError::Uninitialized.into());
        }
        Ok(position)
    }

    /// Validate a tick-array account (program-owned, belongs to `pool_ai`) and
    /// copy its data out for the engine (written back by the caller's scope —
    /// see `write_back_array`). Copy-in/copy-out keeps borrow scopes trivial
    /// when the same account backs both position bounds.
    fn checked_array_data<'a, 'info>(
        program_id: &Pubkey,
        pool_ai: &AccountInfo<'info>,
        ta_ai: &'a AccountInfo<'info>,
    ) -> Result<TickArrayGuard<'a, 'info>, ProgramError> {
        if ta_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let data = ta_ai.data.borrow().to_vec();
        let (_, pool, _) = unpack_tick_array_header(&data)?;
        if pool != *pool_ai.key {
            return Err(ClmmError::InvalidTokenAccount.into());
        }
        Ok(TickArrayGuard { ai: ta_ai, data })
    }

    /// Move `amount` out of a pool vault (pool PDA signs).
    fn vault_transfer<'a>(
        pool: &Pool,
        token_program_ai: &AccountInfo<'a>,
        from_ai: &AccountInfo<'a>,
        to_ai: &AccountInfo<'a>,
        pool_ai: &AccountInfo<'a>,
        amount: u64,
    ) -> ProgramResult {
        let fee_le = pool.fee_pips.to_le_bytes();
        let signer_seeds: &[&[u8]] = &[
            POOL_SEED,
            pool.mint_0.as_ref(),
            pool.mint_1.as_ref(),
            &fee_le,
            &[pool.bump],
        ];
        invoke_signed(
            &spl_token::instruction::transfer(
                token_program_ai.key,
                from_ai.key,
                to_ai.key,
                pool_ai.key,
                &[],
                amount,
            )?,
            &[from_ai.clone(), to_ai.clone(), pool_ai.clone(), token_program_ai.clone()],
            &[signer_seeds],
        )
    }
}

/// Owned copy of a tick-array account's data that writes itself back into the
/// account when dropped (after the engine mutated it). Copy-in/copy-out keeps
/// borrow scopes trivial when one account backs both position bounds; a
/// failed instruction reverts wholesale, so the unconditional write-back is
/// safe.
struct TickArrayGuard<'a, 'info> {
    ai: &'a AccountInfo<'info>,
    data: Vec<u8>,
}

impl core::ops::Deref for TickArrayGuard<'_, '_> {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.data
    }
}

impl core::ops::DerefMut for TickArrayGuard<'_, '_> {
    fn deref_mut(&mut self) -> &mut [u8] {
        &mut self.data
    }
}

impl Drop for TickArrayGuard<'_, '_> {
    fn drop(&mut self) {
        self.ai.data.borrow_mut().copy_from_slice(&self.data);
    }
}

/// Reject a token program that isn't SPL Token (the arbitrary-CPI class).
pub fn check_token_program(key: &Pubkey) -> ProgramResult {
    if *key != spl_token::id() {
        return Err(ClmmError::IncorrectTokenProgram.into());
    }
    Ok(())
}

/// Pool-creation parameter domain.
pub fn check_pool_params(fee_pips: u32, tick_spacing: u16, sqrt_price: u128) -> ProgramResult {
    if fee_pips > MAX_FEE_PIPS || tick_spacing == 0 {
        return Err(ClmmError::InvalidParams.into());
    }
    if !(MIN_SQRT_PRICE..=MAX_SQRT_PRICE).contains(&sqrt_price) {
        return Err(ClmmError::SqrtPriceOutOfBounds.into());
    }
    Ok(())
}

/// A zero `sqrt_price_limit` means "no bound": the band edge for the direction.
pub fn default_limit(zero_for_one: bool, sqrt_price_limit: u128) -> u128 {
    if sqrt_price_limit != 0 {
        sqrt_price_limit
    } else if zero_for_one {
        MIN_SQRT_PRICE
    } else {
        MAX_SQRT_PRICE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_program_pinned_to_spl() {
        assert!(check_token_program(&spl_token::id()).is_ok());
        let err = check_token_program(&Pubkey::new_unique()).unwrap_err();
        assert_eq!(err, ClmmError::IncorrectTokenProgram.into());
    }

    #[test]
    fn pool_params_domain() {
        assert!(check_pool_params(3000, 64, 1 << 64).is_ok());
        assert!(check_pool_params(0, 1, MIN_SQRT_PRICE).is_ok(), "zero-fee pool allowed");
        assert_eq!(
            check_pool_params(MAX_FEE_PIPS + 1, 64, 1 << 64).unwrap_err(),
            ClmmError::InvalidParams.into()
        );
        assert_eq!(
            check_pool_params(3000, 0, 1 << 64).unwrap_err(),
            ClmmError::InvalidParams.into()
        );
        assert_eq!(
            check_pool_params(3000, 64, MAX_SQRT_PRICE + 1).unwrap_err(),
            ClmmError::SqrtPriceOutOfBounds.into()
        );
    }

    #[test]
    fn limit_defaults_to_band_edge() {
        assert_eq!(default_limit(true, 0), MIN_SQRT_PRICE);
        assert_eq!(default_limit(false, 0), MAX_SQRT_PRICE);
        assert_eq!(default_limit(true, 42), 42);
    }
}
