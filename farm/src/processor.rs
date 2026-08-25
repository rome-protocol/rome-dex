//! Farm instruction processing.

use {
    crate::{
        error::FarmError,
        instruction::FarmInstruction,
        state::{Farm, UserStake, FARM_LEN, MAX_REWARD_PER_SECOND, USER_STAKE_LEN},
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
            FarmInstruction::EmergencyUnstake => Self::emergency_unstake(program_id, accounts),
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
        // The farm account is a plain keypair account (created just before by
        // SystemProgram.createAccount), not a PDA — so without this check
        // anyone who learns the pubkey can front-run InitFarm and install
        // themselves as `owner` before the legitimate creator's InitFarm
        // lands. Requiring this signature ties InitFarm to the same key that
        // authorized the account's creation.
        if !farm_ai.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
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
        // Bound the emission rate so `accrue` can never be driven to
        // permanent overflow (see MAX_REWARD_PER_SECOND).
        if reward_per_second > MAX_REWARD_PER_SECOND {
            return Err(FarmError::RewardRateTooHigh.into());
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
        // Bound the emission rate so `accrue` can never be driven to
        // permanent overflow (see MAX_REWARD_PER_SECOND).
        if reward_per_second > MAX_REWARD_PER_SECOND {
            return Err(FarmError::RewardRateTooHigh.into());
        }
        // Accrue at the old rate before switching, so the change is not retroactive.
        farm.accrue(Clock::get()?.unix_timestamp)?;
        farm.reward_per_second = reward_per_second;
        farm.pack(&mut farm_ai.data.borrow_mut());
        Ok(())
    }

    /// Exit the caller's full position without touching reward arithmetic —
    /// the one exit that still works when `accrue` has been driven to
    /// permanent overflow by an uncapped `reward_per_second` (both `unstake`
    /// and `claim` call `accrue` before moving funds). Canonical MasterChef
    /// `emergencyWithdraw`: full position only, forfeits any unsettled
    /// pending reward, leaves `acc_reward_per_share` / `last_update_ts`
    /// untouched. No amount argument — a partial exit would need
    /// `set_debt`, i.e. the very multiplication this instruction routes
    /// around.
    fn emergency_unstake(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
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
        let stake = Self::load_user_stake(program_id, farm_ai, authority_ai, user_stake_ai)?;
        let amount = stake.amount;

        // Return the full staked position (farm authority PDA signs); no
        // accrue/settle/pending — arithmetic-free by design.
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

        farm.total_staked = farm
            .total_staked
            .checked_sub(amount)
            .ok_or(FarmError::Overflow)?;
        let stake = UserStake {
            is_initialized: true,
            amount: 0,
            reward_debt: 0,
            reward_pending: 0,
        };

        farm.pack(&mut farm_ai.data.borrow_mut());
        stake.pack(&mut user_stake_ai.data.borrow_mut());
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

    // ---- exit-safety fixture ----
    //
    // `sol_invoke_signed`'s default host stub is a logged no-op returning `Ok`
    // (solana-sysvar's `program_stubs::DefaultSyscallStubs`), so the token CPIs
    // exercised below never move real tokens — these tests assert STATE
    // accounting only. `sol_get_clock_sysvar` has no such default (it returns
    // `UNSUPPORTED_SYSVAR`), so `Clock::get()` needs a stub installed.
    //
    // Deviation from the brief: syscall stubs are process-global, but cargo
    // runs tests on separate OS threads by default, so a single global "now"
    // would race across tests. Installing the `SyscallStubs` impl happens once
    // (`std::sync::Once`, as specified); the per-test clock value itself is
    // carried in a `thread_local`, which each test sets right before calling
    // `Processor::process` and which is thread-safe under parallel test runs.
    use solana_program::program_option::COption;
    use spl_token::state::{Account as TokenAccount, AccountState, Mint};
    use std::cell::Cell;
    use std::sync::Once;

    thread_local! {
        static NOW: Cell<i64> = Cell::new(0);
    }

    struct TestStubs;
    impl solana_program::program_stubs::SyscallStubs for TestStubs {
        fn sol_get_clock_sysvar(&self, var_addr: *mut u8) -> u64 {
            let clock = Clock {
                slot: 0,
                epoch_start_timestamp: 0,
                epoch: 0,
                leader_schedule_epoch: 0,
                unix_timestamp: NOW.with(|n| n.get()),
            };
            unsafe { std::ptr::write(var_addr as *mut Clock, clock) };
            solana_program::entrypoint::SUCCESS
        }
    }

    static STUBS_INIT: Once = Once::new();

    /// Install the Clock stub (once) and set this thread's "now" for the
    /// duration of the calling test.
    fn set_clock(now: i64) {
        STUBS_INIT.call_once(|| {
            solana_program::program_stubs::set_syscall_stubs(Box::new(TestStubs));
        });
        NOW.with(|n| n.set(now));
    }

    /// A fabricated account, owning its own buffers so `AccountInfo::new` can
    /// borrow them for the duration of one `Processor::process` call.
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
    /// `farm` has no resize call today, so this can't yet trigger — but the
    /// slack keeps the fixture safe if a close path is ever added (see the
    /// `orders` crate, which hit exactly this via `close_state_account`).
    struct Acc {
        key: Pubkey,
        lamports: u64,
        data: Vec<u8>,
        owner: Pubkey,
        is_signer: bool,
        is_writable: bool,
    }

    impl Acc {
        fn new(key: Pubkey, owner: Pubkey, data: Vec<u8>) -> Self {
            let mut acc =
                Acc { key, lamports: 0, data: Vec::new(), owner, is_signer: false, is_writable: true };
            acc.set_data(data);
            acc
        }
        fn signer(mut self) -> Self {
            self.is_signer = true;
            self
        }
        fn readonly(mut self) -> Self {
            self.is_writable = false;
            self
        }
        fn info(&mut self) -> AccountInfo<'_> {
            AccountInfo::new(
                &self.key,
                self.is_signer,
                self.is_writable,
                &mut self.lamports,
                &mut self.data[8..],
                &self.owner,
                false,
                0,
            )
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

    /// Borrow a batch of `Acc`s into the `AccountInfo` slice `Processor::process`
    /// expects. The borrow (and any writes `process` made) lives only as long
    /// as the returned `Vec` — drop it before inspecting `Acc::data` again.
    fn accounts_of<'a>(accs: Vec<&'a mut Acc>) -> Vec<AccountInfo<'a>> {
        accs.into_iter().map(Acc::info).collect()
    }

    fn mint_data(mint_authority: Pubkey, decimals: u8) -> Vec<u8> {
        let mint = Mint {
            mint_authority: COption::Some(mint_authority),
            supply: 0,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut data = vec![0u8; Mint::LEN];
        Mint::pack(mint, &mut data).unwrap();
        data
    }

    fn token_account_data(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
        let account = TokenAccount {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut data = vec![0u8; TokenAccount::LEN];
        TokenAccount::pack(account, &mut data).unwrap();
        data
    }

    fn u64_data(tag: u8, amount: u64) -> Vec<u8> {
        let mut data = vec![tag];
        data.extend_from_slice(&amount.to_le_bytes());
        data
    }

    /// A fully-valid, not-yet-initialized `init_farm` fixture: farm/authority
    /// PDA/mints/vault all line up; only `farm.is_signer` and `reward_per_second`
    /// vary per test.
    struct InitFarmFixture {
        program_id: Pubkey,
        farm: Acc,
        authority: Acc,
        lp_mint: Acc,
        reward_mint: Acc,
        lp_vault: Acc,
        owner: Acc,
        token_program: Acc,
    }

    fn init_farm_fixture(owner_key: Pubkey) -> InitFarmFixture {
        let program_id = Pubkey::new_unique();
        let farm_key = Pubkey::new_unique();
        let (authority_key, bump) =
            Pubkey::find_program_address(&[farm_key.as_ref()], &program_id);
        let lp_mint_key = Pubkey::new_unique();
        let reward_mint_key = Pubkey::new_unique();
        let lp_vault_key = Pubkey::new_unique();
        let _ = bump; // bump only matters once packed into Farm state (post-init)

        InitFarmFixture {
            program_id,
            farm: Acc::new(farm_key, program_id, vec![0u8; FARM_LEN]),
            authority: Acc::new(authority_key, Pubkey::default(), vec![]),
            lp_mint: Acc::new(lp_mint_key, spl_token::id(), vec![]),
            reward_mint: Acc::new(
                reward_mint_key,
                spl_token::id(),
                mint_data(authority_key, 9),
            ),
            lp_vault: Acc::new(
                lp_vault_key,
                spl_token::id(),
                token_account_data(lp_mint_key, authority_key, 0),
            ),
            owner: Acc::new(owner_key, Pubkey::default(), vec![]),
            token_program: Acc::new(spl_token::id(), Pubkey::default(), vec![]),
        }
    }

    impl InitFarmFixture {
        fn process(&mut self, reward_per_second: u64) -> Result<(), ProgramError> {
            let data = u64_data(0, reward_per_second);
            let accounts = accounts_of(vec![
                &mut self.farm,
                &mut self.authority,
                &mut self.lp_mint,
                &mut self.reward_mint,
                &mut self.lp_vault,
                &mut self.owner,
                &mut self.token_program,
            ]);
            let program_id = self.program_id;
            Processor::process(&program_id, &accounts, &data)
        }
    }

    // A-1: init_farm requires no signer today — an attacker who knows the
    // (unsigned) farm keypair's pubkey can front-run InitFarm and install
    // themselves as owner. RED before the fix: today this returns Ok.
    #[test]
    fn init_farm_unsigned_frontrun_installs_attacker_owner() {
        let attacker = Pubkey::new_unique();
        let mut fx = init_farm_fixture(attacker);
        // farm_ai.is_signer left false — the attacker never signed for the
        // farm keypair.
        set_clock(1_000);
        let err = fx.process(1_000_000).unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
        assert!(!Farm::unpack(fx.farm.data()).unwrap().is_initialized);
    }

    // A-2: companion guard — the legitimate creator (whose signature created
    // the farm keypair account) still succeeds. Green both before and after
    // the fix; not part of the RED set.
    #[test]
    fn init_farm_succeeds_when_farm_keypair_signs() {
        let owner = Pubkey::new_unique();
        let mut fx = init_farm_fixture(owner);
        fx.farm.is_signer = true;
        set_clock(1_000);
        fx.process(1_000_000).unwrap();
        let farm = Farm::unpack(fx.farm.data()).unwrap();
        assert!(farm.is_initialized);
        assert_eq!(farm.owner, owner);
    }

    // B-1: an uncapped rate at init would permanently brick the farm's exit
    // path once accrue overflows (see accrue_uncapped_rate_bricks_permanently
    // in state.rs) — reject it at the door. RED before the fix: today Ok.
    #[test]
    fn init_farm_rejects_rate_above_cap() {
        let owner = Pubkey::new_unique();
        let mut fx = init_farm_fixture(owner);
        fx.farm.is_signer = true;
        set_clock(1_000);
        let err = fx.process(MAX_REWARD_PER_SECOND + 1).unwrap_err();
        assert_eq!(err, FarmError::RewardRateTooHigh.into());
    }

    // B-2: same cap enforced on the operator's runtime knob. RED before the
    // fix: today Ok.
    #[test]
    fn set_reward_per_second_rejects_rate_above_cap() {
        let program_id = Pubkey::new_unique();
        let owner_key = Pubkey::new_unique();
        let farm_key = Pubkey::new_unique();
        let farm_state = Farm {
            is_initialized: true,
            bump_seed: 0,
            owner: owner_key,
            lp_mint: Pubkey::new_unique(),
            reward_mint: Pubkey::new_unique(),
            lp_vault: Pubkey::new_unique(),
            token_program: spl_token::id(),
            reward_per_second: 1_000,
            last_update_ts: 0,
            acc_reward_per_share: 0,
            total_staked: 0,
        };
        let mut farm_data = vec![0u8; FARM_LEN];
        farm_state.pack(&mut farm_data);

        let mut farm_acc = Acc::new(farm_key, program_id, farm_data);
        let mut owner_acc = Acc::new(owner_key, Pubkey::default(), vec![]).signer();

        set_clock(2_000);
        let data = u64_data(5, MAX_REWARD_PER_SECOND + 1);
        let accounts = accounts_of(vec![&mut farm_acc, &mut owner_acc]);
        let err = Processor::process(&program_id, &accounts, &data).unwrap_err();
        assert_eq!(err, FarmError::RewardRateTooHigh.into());
    }

    // N3: pins the cap as inclusive — only cap+1 rejection (B-2, above) was
    // covered before, so an off-by-one narrowing the check to `>=` would
    // have gone unnoticed.
    #[test]
    fn set_reward_per_second_accepts_rate_at_cap() {
        let program_id = Pubkey::new_unique();
        let owner_key = Pubkey::new_unique();
        let farm_key = Pubkey::new_unique();
        let farm_state = Farm {
            is_initialized: true,
            bump_seed: 0,
            owner: owner_key,
            lp_mint: Pubkey::new_unique(),
            reward_mint: Pubkey::new_unique(),
            lp_vault: Pubkey::new_unique(),
            token_program: spl_token::id(),
            reward_per_second: 1_000,
            last_update_ts: 0,
            acc_reward_per_share: 0,
            total_staked: 0,
        };
        let mut farm_data = vec![0u8; FARM_LEN];
        farm_state.pack(&mut farm_data);

        let mut farm_acc = Acc::new(farm_key, program_id, farm_data);
        let mut owner_acc = Acc::new(owner_key, Pubkey::default(), vec![]).signer();

        set_clock(2_000);
        let data = u64_data(5, MAX_REWARD_PER_SECOND);
        let accounts = accounts_of(vec![&mut farm_acc, &mut owner_acc]);
        Processor::process(&program_id, &accounts, &data).unwrap();
        assert_eq!(Farm::unpack(farm_acc.data()).unwrap().reward_per_second, MAX_REWARD_PER_SECOND);
    }

    // N3 companion: same boundary at init. Cheap off the existing
    // InitFarmFixture, so added alongside rather than skipped.
    #[test]
    fn init_farm_accepts_rate_at_cap() {
        let owner = Pubkey::new_unique();
        let mut fx = init_farm_fixture(owner);
        fx.farm.is_signer = true;
        set_clock(1_000);
        fx.process(MAX_REWARD_PER_SECOND).unwrap();
        let farm = Farm::unpack(fx.farm.data()).unwrap();
        assert!(farm.is_initialized);
        assert_eq!(farm.reward_per_second, MAX_REWARD_PER_SECOND);
    }

    // A fully-wired, already-initialized farm + one staker, for the
    // Stake/Unstake/EmergencyUnstake handlers. `rate`/`total_staked`/
    // `last_update_ts`/`acc_reward_per_share`/`stake_amount` are caller-chosen
    // so both a healthy farm and an already-poisoned one can be built.
    struct FarmFixture {
        program_id: Pubkey,
        farm: Acc,
        authority_pda: Acc,
        staker: Acc,
        user_stake: Acc,
        lp_vault: Acc,
        user_lp: Acc,
        token_program: Acc,
    }

    #[allow(clippy::too_many_arguments)]
    fn farm_fixture(
        rate: u64,
        last_update_ts: i64,
        acc_reward_per_share: u128,
        total_staked: u64,
        stake_amount: u64,
        reward_debt: u128,
        reward_pending: u64,
    ) -> FarmFixture {
        let program_id = Pubkey::new_unique();
        let farm_key = Pubkey::new_unique();
        let (authority_key, bump) =
            Pubkey::find_program_address(&[farm_key.as_ref()], &program_id);
        let staker_key = Pubkey::new_unique();
        let lp_mint_key = Pubkey::new_unique();
        let lp_vault_key = Pubkey::new_unique();

        let farm_state = Farm {
            is_initialized: true,
            bump_seed: bump,
            owner: Pubkey::new_unique(),
            lp_mint: lp_mint_key,
            reward_mint: Pubkey::new_unique(),
            lp_vault: lp_vault_key,
            token_program: spl_token::id(),
            reward_per_second: rate,
            last_update_ts,
            acc_reward_per_share,
            total_staked,
        };
        let mut farm_data = vec![0u8; FARM_LEN];
        farm_state.pack(&mut farm_data);

        let (user_stake_key, _) = Pubkey::find_program_address(
            &[farm_key.as_ref(), staker_key.as_ref()],
            &program_id,
        );
        let stake_state = UserStake {
            is_initialized: true,
            amount: stake_amount,
            reward_debt,
            reward_pending,
        };
        let mut stake_data = vec![0u8; USER_STAKE_LEN];
        stake_state.pack(&mut stake_data);

        let user_lp_key = Pubkey::new_unique();

        FarmFixture {
            program_id,
            farm: Acc::new(farm_key, program_id, farm_data),
            authority_pda: Acc::new(authority_key, Pubkey::default(), vec![]).readonly(),
            staker: Acc::new(staker_key, Pubkey::default(), vec![]).signer().readonly(),
            user_stake: Acc::new(user_stake_key, program_id, stake_data),
            lp_vault: Acc::new(
                lp_vault_key,
                spl_token::id(),
                token_account_data(lp_mint_key, authority_key, stake_amount),
            ),
            user_lp: Acc::new(
                user_lp_key,
                spl_token::id(),
                token_account_data(lp_mint_key, staker_key, 0),
            ),
            token_program: Acc::new(spl_token::id(), Pubkey::default(), vec![]),
        }
    }

    impl FarmFixture {
        fn farm_state(&self) -> Farm {
            Farm::unpack(self.farm.data()).unwrap()
        }
        fn stake_state(&self) -> UserStake {
            UserStake::unpack(self.user_stake.data()).unwrap()
        }
        /// For Unstake (tag 3) / EmergencyUnstake (tag 6): `lp_vault` before
        /// `user_lp`.
        fn process(&mut self, data: Vec<u8>) -> Result<(), ProgramError> {
            let accounts = accounts_of(vec![
                &mut self.farm,
                &mut self.authority_pda,
                &mut self.staker,
                &mut self.user_stake,
                &mut self.lp_vault,
                &mut self.user_lp,
                &mut self.token_program,
            ]);
            let program_id = self.program_id;
            Processor::process(&program_id, &accounts, &data)
        }
        /// For Stake (tag 2): `user_lp` before `lp_vault` — the reverse of
        /// Unstake/EmergencyUnstake (see instruction.rs account docs).
        fn process_stake(&mut self, amount: u64) -> Result<(), ProgramError> {
            let accounts = accounts_of(vec![
                &mut self.farm,
                &mut self.authority_pda,
                &mut self.staker,
                &mut self.user_stake,
                &mut self.user_lp,
                &mut self.lp_vault,
                &mut self.token_program,
            ]);
            let program_id = self.program_id;
            Processor::process(&program_id, &accounts, &u64_data(2, amount))
        }
    }

    // B-4: the exit-safety RED. A farm already poisoned by an uncapped rate
    // (bypassing the new capped `init_farm`/`set_reward_per_second` — this
    // simulates a farm that was poisoned before the fix shipped) permanently
    // bricks `unstake` via `accrue`. `EmergencyUnstake` (tag 6) must still
    // return principal without going through `accrue`.
    #[test]
    fn emergency_unstake_returns_principal_when_accrue_is_bricked() {
        let mut fx = farm_fixture(u64::MAX, 0, 0, 100, 100, 0, 0);

        // Precondition: the brick is real on today's code — a normal unstake
        // of the full position fails with Overflow.
        set_clock(30_000_000);
        let unstake_err = fx.process(u64_data(3, 100)).unwrap_err();
        assert_eq!(unstake_err, FarmError::Overflow.into());
        // The failed unstake must not have mutated anything.
        assert_eq!(fx.farm_state().total_staked, 100);
        assert_eq!(fx.stake_state().amount, 100);

        // Pre-fix, tag 6 didn't exist (InvalidInstruction, no exit at all);
        // post-fix, EmergencyUnstake returns the full principal without
        // touching accrue, so it still works on a farm the overflow above
        // has permanently bricked.
        set_clock(30_000_001);
        fx.process(vec![6]).unwrap();

        let farm = fx.farm_state();
        let stake = fx.stake_state();
        assert_eq!(stake.amount, 0);
        assert_eq!(stake.reward_debt, 0);
        assert_eq!(stake.reward_pending, 0);
        assert_eq!(farm.total_staked, 0);
        // Arithmetic-free: the poisoned accumulator/clock are untouched.
        assert_eq!(farm.acc_reward_per_share, 0);
        assert_eq!(farm.last_update_ts, 0);
    }

    // B-5: re-entry after an emergency exit on a HEALTHY farm must not
    // resurrect forfeited pending reward. A staker has an unsettled 10_000
    // pending reward at the time of the emergency exit (forfeited by design —
    // emergency exit skips settlement); after re-staking the same amount,
    // pending must read 0 immediately and the new debt must snapshot the
    // farm's current accumulator exactly.
    #[test]
    fn emergency_unstake_reentry_is_clean() {
        // acc already reflects 100 per share (as if 10s @ 1000/s over 100
        // staked had accrued); staker's debt is still 0 (never settled), so
        // amount(100) * acc(100) = 10_000 pending is outstanding.
        let acc = 100u128 * 1_000_000_000_000u128; // ACC_PRECISION
        let mut fx = farm_fixture(1_000, 10, acc, 100, 100, 0, 0);
        assert_eq!(fx.stake_state().pending(acc).unwrap(), 10_000);

        set_clock(20);
        fx.process(vec![6]).unwrap();
        assert_eq!(fx.stake_state().amount, 0);
        assert_eq!(fx.farm_state().total_staked, 0);
        // Forfeited, not carried forward, and untouched (arithmetic-free).
        assert_eq!(fx.farm_state().acc_reward_per_share, acc);
        assert_eq!(fx.farm_state().last_update_ts, 10);

        // Re-stake the same amount. total_staked is 0 going in, so accrue is a
        // no-op on the accumulator (just advances the clock).
        set_clock(30);
        fx.process_stake(100).unwrap();

        let farm = fx.farm_state();
        let stake = fx.stake_state();
        assert_eq!(pending_of(&stake, farm.acc_reward_per_share), 0);
        assert_eq!(
            stake.reward_debt,
            (stake.amount as u128 * farm.acc_reward_per_share) / crate::state::ACC_PRECISION
        );
    }

    fn pending_of(stake: &UserStake, acc_reward_per_share: u128) -> u64 {
        stake.pending(acc_reward_per_share).unwrap()
    }

    // M1: `load_user_stake` binds the UserStake PDA to [farm, authority], so
    // naming the victim as `authority` makes that derivation check pass on
    // its own — the signer check on `authority_ai` is the only thing
    // stopping an attacker from submitting tag 6 with the victim unsigned
    // and draining the victim's full position to an attacker-owned
    // `user_lp` (unvalidated by design). No downstream arithmetic fails
    // incidentally here, unlike stake/unstake/claim.
    #[test]
    fn emergency_unstake_requires_authority_signature() {
        let mut fx = farm_fixture(1_000, 10, 0, 100, 100, 5, 7);
        fx.staker.is_signer = false;

        set_clock(20);
        let err = fx.process(vec![6]).unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);

        // Nothing mutated: neither the stake nor the farm's totals moved.
        let stake = fx.stake_state();
        assert_eq!(stake.amount, 100);
        assert_eq!(stake.reward_debt, 5);
        assert_eq!(stake.reward_pending, 7);
        assert_eq!(fx.farm_state().total_staked, 100);
    }

    // M2: `user_lp` is unvalidated by design (the exit is arithmetic-free),
    // so the `lp_vault == farm.lp_vault` check is what stops the PDA-signed
    // transfer from being pointed at a vault other than the farm's real
    // custody.
    #[test]
    fn emergency_unstake_rejects_substitute_lp_vault() {
        let mut fx = farm_fixture(1_000, 10, 0, 100, 100, 5, 7);
        let substitute_key = Pubkey::new_unique();
        fx.lp_vault = Acc::new(
            substitute_key,
            spl_token::id(),
            token_account_data(Pubkey::new_unique(), fx.authority_pda.key, 100),
        );

        set_clock(20);
        let err = fx.process(vec![6]).unwrap_err();
        assert_eq!(err, FarmError::InvalidTokenAccount.into());

        // Nothing mutated: neither the stake nor the farm's totals moved.
        let stake = fx.stake_state();
        assert_eq!(stake.amount, 100);
        assert_eq!(stake.reward_debt, 5);
        assert_eq!(stake.reward_pending, 7);
        assert_eq!(fx.farm_state().total_staked, 100);
    }
}
