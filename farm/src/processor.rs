//! Farm instruction processing.

use {
    crate::{
        error::FarmError,
        instruction::FarmInstruction,
        state::{Farm, UserStake, FARM_LEN, USER_STAKE_LEN},
    },
    solana_program::{
        account_info::{next_account_info, AccountInfo},
        clock::Clock,
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

/// Farm instruction processor.
pub struct Processor;

impl Processor {
    /// Route an instruction to its handler.
    pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        match FarmInstruction::unpack(data)? {
            FarmInstruction::InitFarm { reward_per_second } => {
                Self::init_farm(program_id, accounts, reward_per_second)
            }
            FarmInstruction::InitUserStake => Self::init_user_stake(program_id, accounts),
            FarmInstruction::Stake { amount } => Self::stake(program_id, accounts, amount),
            FarmInstruction::Unstake { amount } => Self::unstake(program_id, accounts, amount),
            FarmInstruction::Claim => Self::claim(program_id, accounts),
            FarmInstruction::SetRewardPerSecond { reward_per_second } => {
                Self::set_reward_per_second(program_id, accounts, reward_per_second)
            }
        }
    }

    fn init_farm(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        reward_per_second: u64,
    ) -> ProgramResult {
        let it = &mut accounts.iter();
        let farm_ai = next_account_info(it)?;
        let authority_ai = next_account_info(it)?;
        let lp_mint_ai = next_account_info(it)?;
        let reward_mint_ai = next_account_info(it)?;
        let lp_vault_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        if farm_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        if farm_ai.data_len() != FARM_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if Farm::unpack(&farm_ai.data.borrow())?.is_initialized {
            return Err(FarmError::AlreadyInitialized.into());
        }
        // Pin the token program at init so a farm can never be created wired to a
        // hostile substitute; the hot paths then match against this.
        if *token_program_ai.key != spl_token::id() {
            return Err(FarmError::IncorrectTokenProgram.into());
        }

        let (authority_key, bump_seed) =
            Pubkey::find_program_address(&[farm_ai.key.as_ref()], program_id);
        if authority_key != *authority_ai.key {
            return Err(FarmError::AddressMismatch.into());
        }

        // Reward mint must be mintable by the farm authority PDA (so claim can
        // mint emissions), and the LP vault must be owned by it (so it custodies
        // stake and can return it on unstake).
        let reward_mint = spl_token::state::Mint::unpack(&reward_mint_ai.data.borrow())?;
        match reward_mint.mint_authority {
            solana_program::program_option::COption::Some(a) if a == authority_key => {}
            _ => return Err(FarmError::InvalidRewardMintAuthority.into()),
        }
        let lp_vault = spl_token::state::Account::unpack(&lp_vault_ai.data.borrow())?;
        if lp_vault.owner != authority_key || lp_vault.mint != *lp_mint_ai.key {
            return Err(FarmError::InvalidTokenAccount.into());
        }

        let now = Clock::get()?.unix_timestamp;
        let farm = Farm {
            is_initialized: true,
            bump_seed,
            owner: *owner_ai.key,
            lp_mint: *lp_mint_ai.key,
            reward_mint: *reward_mint_ai.key,
            lp_vault: *lp_vault_ai.key,
            token_program: *token_program_ai.key,
            reward_per_second,
            last_update_ts: now,
            acc_reward_per_share: 0,
            total_staked: 0,
        };
        farm.pack(&mut farm_ai.data.borrow_mut());
        Ok(())
    }

    fn init_user_stake(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let farm_ai = next_account_info(it)?;
        let authority_ai = next_account_info(it)?;
        let user_stake_ai = next_account_info(it)?;
        let payer_ai = next_account_info(it)?;
        let system_program_ai = next_account_info(it)?;

        if farm_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        if !payer_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        let (expected, bump) = Pubkey::find_program_address(
            &[farm_ai.key.as_ref(), authority_ai.key.as_ref()],
            program_id,
        );
        if expected != *user_stake_ai.key {
            return Err(FarmError::AddressMismatch.into());
        }
        if user_stake_ai.owner == program_id
            && UserStake::unpack(&user_stake_ai.data.borrow())?.is_initialized
        {
            return Err(FarmError::AlreadyInitialized.into());
        }

        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(USER_STAKE_LEN);
        let seeds: &[&[u8]] = &[farm_ai.key.as_ref(), authority_ai.key.as_ref(), &[bump]];
        invoke_signed(
            &system_instruction::create_account(
                payer_ai.key,
                user_stake_ai.key,
                lamports,
                USER_STAKE_LEN as u64,
                program_id,
            ),
            &[payer_ai.clone(), user_stake_ai.clone(), system_program_ai.clone()],
            &[seeds],
        )?;

        let stake = UserStake {
            is_initialized: true,
            amount: 0,
            reward_debt: 0,
            reward_pending: 0,
        };
        stake.pack(&mut user_stake_ai.data.borrow_mut());
        Ok(())
    }

    fn stake(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
        let it = &mut accounts.iter();
        let farm_ai = next_account_info(it)?;
        let authority_pda_ai = next_account_info(it)?;
        let authority_ai = next_account_info(it)?;
        let user_stake_ai = next_account_info(it)?;
        let user_lp_ai = next_account_info(it)?;
        let lp_vault_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        let mut farm = Self::load_farm(program_id, farm_ai)?;
        Self::check_authority_pda(program_id, farm_ai, &farm, authority_pda_ai)?;
        Self::check_token_program(token_program_ai.key, &farm)?;
        if !authority_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *lp_vault_ai.key != farm.lp_vault {
            return Err(FarmError::InvalidTokenAccount.into());
        }
        let mut stake = Self::load_user_stake(program_id, farm_ai, authority_ai, user_stake_ai)?;

        let now = Clock::get()?.unix_timestamp;
        farm.accrue(now)?;
        Self::settle(&mut stake, farm.acc_reward_per_share)?;

        // Pull LP from the authority into the vault (authority signs).
        invoke(
            &spl_token::instruction::transfer(
                token_program_ai.key,
                user_lp_ai.key,
                lp_vault_ai.key,
                authority_ai.key,
                &[],
                amount,
            )?,
            &[
                user_lp_ai.clone(),
                lp_vault_ai.clone(),
                authority_ai.clone(),
                token_program_ai.clone(),
            ],
        )?;

        stake.amount = stake.amount.checked_add(amount).ok_or(FarmError::Overflow)?;
        farm.total_staked = farm
            .total_staked
            .checked_add(amount)
            .ok_or(FarmError::Overflow)?;
        stake.set_debt(farm.acc_reward_per_share)?;

        farm.pack(&mut farm_ai.data.borrow_mut());
        stake.pack(&mut user_stake_ai.data.borrow_mut());
        Ok(())
    }

    fn unstake(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
        let it = &mut accounts.iter();
        let farm_ai = next_account_info(it)?;
        let authority_pda_ai = next_account_info(it)?;
        let authority_ai = next_account_info(it)?;
        let user_stake_ai = next_account_info(it)?;
        let lp_vault_ai = next_account_info(it)?;
        let user_lp_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        let mut farm = Self::load_farm(program_id, farm_ai)?;
        Self::check_authority_pda(program_id, farm_ai, &farm, authority_pda_ai)?;
        Self::check_token_program(token_program_ai.key, &farm)?;
        if !authority_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *lp_vault_ai.key != farm.lp_vault {
            return Err(FarmError::InvalidTokenAccount.into());
        }
        let mut stake = Self::load_user_stake(program_id, farm_ai, authority_ai, user_stake_ai)?;
        if amount > stake.amount {
            return Err(FarmError::InsufficientStake.into());
        }

        let now = Clock::get()?.unix_timestamp;
        farm.accrue(now)?;
        Self::settle(&mut stake, farm.acc_reward_per_share)?;

        // Return LP from the vault to the authority (farm authority PDA signs).
        let seeds: &[&[u8]] = &[farm_ai.key.as_ref(), &[farm.bump_seed]];
        invoke_signed(
            &spl_token::instruction::transfer(
                token_program_ai.key,
                lp_vault_ai.key,
                user_lp_ai.key,
                authority_pda_ai.key,
                &[],
                amount,
            )?,
            &[
                lp_vault_ai.clone(),
                user_lp_ai.clone(),
                authority_pda_ai.clone(),
                token_program_ai.clone(),
            ],
            &[seeds],
        )?;

        stake.amount = stake.amount.checked_sub(amount).ok_or(FarmError::Overflow)?;
        farm.total_staked = farm
            .total_staked
            .checked_sub(amount)
            .ok_or(FarmError::Overflow)?;
        stake.set_debt(farm.acc_reward_per_share)?;

        farm.pack(&mut farm_ai.data.borrow_mut());
        stake.pack(&mut user_stake_ai.data.borrow_mut());
        Ok(())
    }

    fn claim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let it = &mut accounts.iter();
        let farm_ai = next_account_info(it)?;
        let authority_pda_ai = next_account_info(it)?;
        let authority_ai = next_account_info(it)?;
        let user_stake_ai = next_account_info(it)?;
        let reward_mint_ai = next_account_info(it)?;
        let user_reward_ai = next_account_info(it)?;
        let token_program_ai = next_account_info(it)?;

        let mut farm = Self::load_farm(program_id, farm_ai)?;
        Self::check_authority_pda(program_id, farm_ai, &farm, authority_pda_ai)?;
        Self::check_token_program(token_program_ai.key, &farm)?;
        if !authority_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *reward_mint_ai.key != farm.reward_mint {
            return Err(FarmError::InvalidTokenAccount.into());
        }
        let mut stake = Self::load_user_stake(program_id, farm_ai, authority_ai, user_stake_ai)?;

        let now = Clock::get()?.unix_timestamp;
        farm.accrue(now)?;
        let pending = stake.pending(farm.acc_reward_per_share)?;

        if pending > 0 {
            let seeds: &[&[u8]] = &[farm_ai.key.as_ref(), &[farm.bump_seed]];
            invoke_signed(
                &spl_token::instruction::mint_to(
                    token_program_ai.key,
                    reward_mint_ai.key,
                    user_reward_ai.key,
                    authority_pda_ai.key,
                    &[],
                    pending,
                )?,
                &[
                    reward_mint_ai.clone(),
                    user_reward_ai.clone(),
                    authority_pda_ai.clone(),
                    token_program_ai.clone(),
                ],
                &[seeds],
            )?;
        }

        stake.reward_pending = 0;
        stake.set_debt(farm.acc_reward_per_share)?;

        farm.pack(&mut farm_ai.data.borrow_mut());
        stake.pack(&mut user_stake_ai.data.borrow_mut());
        Ok(())
    }

    fn set_reward_per_second(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        reward_per_second: u64,
    ) -> ProgramResult {
        let it = &mut accounts.iter();
        let farm_ai = next_account_info(it)?;
        let owner_ai = next_account_info(it)?;

        let mut farm = Self::load_farm(program_id, farm_ai)?;
        if !owner_ai.is_signer || *owner_ai.key != farm.owner {
            return Err(FarmError::Unauthorized.into());
        }
        // Accrue at the old rate before switching, so the change is not retroactive.
        farm.accrue(Clock::get()?.unix_timestamp)?;
        farm.reward_per_second = reward_per_second;
        farm.pack(&mut farm_ai.data.borrow_mut());
        Ok(())
    }

    // ---- helpers ----

    fn load_farm(program_id: &Pubkey, farm_ai: &AccountInfo) -> Result<Farm, ProgramError> {
        if farm_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let farm = Farm::unpack(&farm_ai.data.borrow())?;
        if !farm.is_initialized {
            return Err(FarmError::Uninitialized.into());
        }
        Ok(farm)
    }

    fn check_authority_pda(
        program_id: &Pubkey,
        farm_ai: &AccountInfo,
        farm: &Farm,
        authority_pda_ai: &AccountInfo,
    ) -> ProgramResult {
        let expected =
            Pubkey::create_program_address(&[farm_ai.key.as_ref(), &[farm.bump_seed]], program_id)
                .map_err(|_| FarmError::AddressMismatch)?;
        if expected != *authority_pda_ai.key {
            return Err(FarmError::AddressMismatch.into());
        }
        Ok(())
    }

    fn load_user_stake(
        program_id: &Pubkey,
        farm_ai: &AccountInfo,
        authority_ai: &AccountInfo,
        user_stake_ai: &AccountInfo,
    ) -> Result<UserStake, ProgramError> {
        if user_stake_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let (expected, _) = Pubkey::find_program_address(
            &[farm_ai.key.as_ref(), authority_ai.key.as_ref()],
            program_id,
        );
        if expected != *user_stake_ai.key {
            return Err(FarmError::AddressMismatch.into());
        }
        let stake = UserStake::unpack(&user_stake_ai.data.borrow())?;
        if !stake.is_initialized {
            return Err(FarmError::Uninitialized.into());
        }
        Ok(stake)
    }

    /// Fold the reward accrued since the last settlement into `reward_pending`.
    fn settle(stake: &mut UserStake, acc_reward_per_share: u128) -> Result<(), FarmError> {
        let pending = stake.pending(acc_reward_per_share)?;
        stake.reward_pending = pending;
        Ok(())
    }

    /// Reject a caller-supplied token program that isn't the farm's real SPL
    /// token program (recorded at init as `farm.token_program`).
    ///
    /// Without this, a hostile caller passes a no-op program as `token_program`:
    /// the token CPI "succeeds" without moving anything while the handler still
    /// credits `stake.amount` / mints reward — a fake-stake that inflates the
    /// staker's balance with no deposit, then a real `unstake` drains other
    /// stakers' LP (arbitrary CPI, sealevel-attacks #5). Every hot path that
    /// CPIs the token program must call this, mirroring the DEX's
    /// `token_swap.token_program_id()` check.
    fn check_token_program(token_program_key: &Pubkey, farm: &Farm) -> ProgramResult {
        if *token_program_key != farm.token_program {
            return Err(FarmError::IncorrectTokenProgram.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The guard accepts the farm's recorded token program and rejects any
    // substitute — the fix for the fake-stake / vault-drain arbitrary-CPI hole.
    #[test]
    fn check_token_program_matches_farm() {
        let real = spl_token::id();
        let farm = Farm { token_program: real, ..Farm::default() };
        assert!(Processor::check_token_program(&real, &farm).is_ok());
    }

    #[test]
    fn check_token_program_rejects_substitute() {
        let farm = Farm { token_program: spl_token::id(), ..Farm::default() };
        let attacker_program = Pubkey::new_unique(); // a no-op program the attacker deployed
        let err = Processor::check_token_program(&attacker_program, &farm).unwrap_err();
        assert_eq!(err, FarmError::IncorrectTokenProgram.into());
    }
}
