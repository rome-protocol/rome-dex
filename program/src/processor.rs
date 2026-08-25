//! Program state processor

use {
    crate::{
        config::{ProtocolConfig, CONFIG_SEED, CONFIG_VERSION, MODE_PERMISSIONLESS},
        constraints::{SwapConstraints, SWAP_CONSTRAINTS},
        curve::{
            base::SwapCurve,
            calculator::{RoundDirection, TradeDirection},
            fees::Fees,
        },
        error::SwapError,
        instruction::{
            CreatePool, DepositAllTokenTypes, DepositSingleTokenTypeExactAmountIn,
            InitializeConfig, SetPoolCreation, SetTreasury, Swap, SwapExactOut, SwapInstruction,
            TransferAdmin, WithdrawAllTokenTypes, WithdrawSingleTokenTypeExactAmountOut,
        },
        state::{SwapState, SwapV2, SwapVersion},
    },
    num_traits::FromPrimitive,
    solana_program::{
        account_info::{next_account_info, AccountInfo},
        bpf_loader_upgradeable,
        clock::Clock,
        decode_error::DecodeError,
        entrypoint::ProgramResult,
        instruction::Instruction,
        msg,
        program::{invoke, invoke_signed},
        program_error::{PrintProgramError, ProgramError},
        program_option::COption,
        program_pack::Pack as _,
        pubkey::Pubkey,
        rent::Rent,
        system_instruction,
        sysvar::Sysvar,
    },
    spl_token_2022::{
        check_spl_token_program_account,
        error::TokenError,
        extension::{
            mint_close_authority::MintCloseAuthority, transfer_fee::TransferFeeConfig,
            BaseStateWithExtensions, StateWithExtensions,
        },
        state::{Account, Mint},
    },
    std::{convert::TryInto, error::Error},
};

/// Program state handler.
pub struct Processor {}

/// How a swap's trade amounts are specified: an exact input (default), or an
/// exact output with a cap on the input.
#[derive(Clone, Copy, Debug)]
enum SwapSpec {
    /// Pay exactly `amount_in`, receive at least `minimum_amount_out`.
    ExactIn {
        amount_in: u64,
        minimum_amount_out: u64,
    },
    /// Receive exactly `amount_out`, pay at most `maximum_amount_in`.
    ExactOut {
        amount_out: u64,
        maximum_amount_in: u64,
    },
}

impl Processor {
    /// Unpacks a spl_token `Account`.
    pub fn unpack_token_account(
        account_info: &AccountInfo,
        token_program_id: &Pubkey,
    ) -> Result<Account, SwapError> {
        if account_info.owner != token_program_id
            && check_spl_token_program_account(account_info.owner).is_err()
        {
            Err(SwapError::IncorrectTokenProgramId)
        } else {
            StateWithExtensions::<Account>::unpack(&account_info.data.borrow())
                .map(|a| a.base)
                .map_err(|_| SwapError::ExpectedAccount)
        }
    }

    /// Unpacks a spl_token `Mint`.
    pub fn unpack_mint(
        account_info: &AccountInfo,
        token_program_id: &Pubkey,
    ) -> Result<Mint, SwapError> {
        if account_info.owner != token_program_id
            && check_spl_token_program_account(account_info.owner).is_err()
        {
            Err(SwapError::IncorrectTokenProgramId)
        } else {
            StateWithExtensions::<Mint>::unpack(&account_info.data.borrow())
                .map(|m| m.base)
                .map_err(|_| SwapError::ExpectedMint)
        }
    }

    /// Unpacks a spl_token `Mint` with extension data
    pub fn unpack_mint_with_extensions<'a>(
        account_data: &'a [u8],
        owner: &Pubkey,
        token_program_id: &Pubkey,
    ) -> Result<StateWithExtensions<'a, Mint>, SwapError> {
        if owner != token_program_id && check_spl_token_program_account(owner).is_err() {
            Err(SwapError::IncorrectTokenProgramId)
        } else {
            StateWithExtensions::<Mint>::unpack(account_data).map_err(|_| SwapError::ExpectedMint)
        }
    }

    /// Calculates the authority id by generating a program address.
    pub fn authority_id(
        program_id: &Pubkey,
        my_info: &Pubkey,
        bump_seed: u8,
    ) -> Result<Pubkey, SwapError> {
        Pubkey::create_program_address(&[&my_info.to_bytes()[..32], &[bump_seed]], program_id)
            .or(Err(SwapError::InvalidProgramAddress))
    }

    /// Issue a spl_token `Burn` instruction.
    pub fn token_burn<'a>(
        swap: &Pubkey,
        token_program: AccountInfo<'a>,
        burn_account: AccountInfo<'a>,
        mint: AccountInfo<'a>,
        authority: AccountInfo<'a>,
        bump_seed: u8,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let swap_bytes = swap.to_bytes();
        let authority_signature_seeds = [&swap_bytes[..32], &[bump_seed]];
        let signers = &[&authority_signature_seeds[..]];

        let ix = spl_token_2022::instruction::burn(
            token_program.key,
            burn_account.key,
            mint.key,
            authority.key,
            &[],
            amount,
        )?;

        invoke_signed_wrapper::<TokenError>(
            &ix,
            &[burn_account, mint, authority, token_program],
            signers,
        )
    }

    /// Issue a spl_token `MintTo` instruction.
    pub fn token_mint_to<'a>(
        swap: &Pubkey,
        token_program: AccountInfo<'a>,
        mint: AccountInfo<'a>,
        destination: AccountInfo<'a>,
        authority: AccountInfo<'a>,
        bump_seed: u8,
        amount: u64,
    ) -> Result<(), ProgramError> {
        let swap_bytes = swap.to_bytes();
        let authority_signature_seeds = [&swap_bytes[..32], &[bump_seed]];
        let signers = &[&authority_signature_seeds[..]];
        let ix = spl_token_2022::instruction::mint_to(
            token_program.key,
            mint.key,
            destination.key,
            authority.key,
            &[],
            amount,
        )?;

        invoke_signed_wrapper::<TokenError>(
            &ix,
            &[mint, destination, authority, token_program],
            signers,
        )
    }

    /// Issue a spl_token `Transfer` instruction.
    #[allow(clippy::too_many_arguments)]
    pub fn token_transfer<'a>(
        swap: &Pubkey,
        token_program: AccountInfo<'a>,
        source: AccountInfo<'a>,
        mint: AccountInfo<'a>,
        destination: AccountInfo<'a>,
        authority: AccountInfo<'a>,
        bump_seed: u8,
        amount: u64,
        decimals: u8,
    ) -> Result<(), ProgramError> {
        let swap_bytes = swap.to_bytes();
        let authority_signature_seeds = [&swap_bytes[..32], &[bump_seed]];
        let signers = &[&authority_signature_seeds[..]];
        let ix = spl_token_2022::instruction::transfer_checked(
            token_program.key,
            source.key,
            mint.key,
            destination.key,
            authority.key,
            &[],
            amount,
            decimals,
        )?;
        invoke_signed_wrapper::<TokenError>(
            &ix,
            &[source, mint, destination, authority, token_program],
            signers,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn check_accounts(
        token_swap: &dyn SwapState,
        program_id: &Pubkey,
        swap_account_info: &AccountInfo,
        authority_info: &AccountInfo,
        token_a_info: &AccountInfo,
        token_b_info: &AccountInfo,
        pool_mint_info: &AccountInfo,
        pool_token_program_info: &AccountInfo,
        user_token_a_info: Option<&AccountInfo>,
        user_token_b_info: Option<&AccountInfo>,
    ) -> ProgramResult {
        if swap_account_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }
        if *authority_info.key
            != Self::authority_id(program_id, swap_account_info.key, token_swap.bump_seed())?
        {
            return Err(SwapError::InvalidProgramAddress.into());
        }
        if *token_a_info.key != *token_swap.token_a_account() {
            return Err(SwapError::IncorrectSwapAccount.into());
        }
        if *token_b_info.key != *token_swap.token_b_account() {
            return Err(SwapError::IncorrectSwapAccount.into());
        }
        if *pool_mint_info.key != *token_swap.pool_mint() {
            return Err(SwapError::IncorrectPoolMint.into());
        }
        if *pool_token_program_info.key != *token_swap.token_program_id() {
            return Err(SwapError::IncorrectTokenProgramId.into());
        }
        if let Some(user_token_a_info) = user_token_a_info {
            if token_a_info.key == user_token_a_info.key {
                return Err(SwapError::InvalidInput.into());
            }
        }
        if let Some(user_token_b_info) = user_token_b_info {
            if token_b_info.key == user_token_b_info.key {
                return Err(SwapError::InvalidInput.into());
            }
        }
        Ok(())
    }

    /// LP-owned reserve: pool math NEVER sees protocol-owned tokens. Every
    /// pool-math function computes this once at the head, for each side,
    /// and every downstream site (curve reads, pro-rata, clamps, zero-
    /// guards) uses the result — never the raw vault amount
    /// (the design plan). `checked_sub` fails closed: the
    /// invariant guarantees `protocol_fees <= vault_amount` (counters only
    /// grow by fee tokens that physically entered the vault; vault debits
    /// are program-computed from LP-owned math), but a violating state
    /// (e.g. hand-packed in a test) must produce the named error, never wrap.
    fn lp_owned(vault_amount: u64, protocol_fees: u64) -> Result<u64, ProgramError> {
        vault_amount
            .checked_sub(protocol_fees)
            .ok_or_else(|| SwapError::CalculationFailure.into())
    }

    /// Grief-proof PDA creation (Part D): transfer any
    /// lamport shortfall then `Allocate`+`Assign`, instead of bare
    /// `create_account` — which fails PERMANENTLY if the target already
    /// holds ≥1 lamport. Canonical PDAs (config, pool, LP mint, dest) are
    /// public precomputable addresses, so a dust pre-fund would otherwise be
    /// a permanent creation brick (the design plan). Shared by
    /// `InitializeConfig` and all three of `CreatePool`'s PDA creations.
    #[allow(clippy::too_many_arguments)]
    fn create_pda_account<'a>(
        payer_info: &AccountInfo<'a>,
        target_info: &AccountInfo<'a>,
        system_program_info: &AccountInfo<'a>,
        signer_seeds: &[&[u8]],
        space: usize,
        owner: &Pubkey,
    ) -> ProgramResult {
        let rent = Rent::get()?;
        let rent_needed = rent.minimum_balance(space);
        let current_lamports = target_info.lamports();
        if current_lamports < rent_needed {
            let transfer_amount = rent_needed - current_lamports;
            invoke(
                &system_instruction::transfer(payer_info.key, target_info.key, transfer_amount),
                &[
                    payer_info.clone(),
                    target_info.clone(),
                    system_program_info.clone(),
                ],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(target_info.key, space as u64),
            &[target_info.clone(), system_program_info.clone()],
            &[signer_seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(target_info.key, owner),
            &[target_info.clone(), system_program_info.clone()],
            &[signer_seeds],
        )?;
        Ok(())
    }

    /// Manually parses + verifies the loader's ProgramData account
    /// The address is DERIVED, never trusted; owner, shape, and the
    /// mutability flag are checked; the upgrade authority is extracted. No
    /// bincode dependency — same manual-parse precedent as the test stub's
    /// system-instruction parse. Layout (45 bytes): u32 LE discriminant (3 =
    /// `ProgramData`) + u64 slot + 1-byte Option flag + 32-byte pubkey.
    fn verify_program_data(
        program_id: &Pubkey,
        programdata_info: &AccountInfo,
    ) -> Result<Pubkey, ProgramError> {
        let (expected, _bump) = Pubkey::find_program_address(
            &[program_id.as_ref()],
            &bpf_loader_upgradeable::id(),
        );
        if *programdata_info.key != expected {
            return Err(SwapError::InvalidProgramData.into());
        }
        if *programdata_info.owner != bpf_loader_upgradeable::id() {
            return Err(SwapError::InvalidProgramData.into());
        }
        let data = programdata_info.data.borrow();
        let head = data.get(..45).ok_or(SwapError::InvalidProgramData)?;
        let discriminant = u32::from_le_bytes(head[0..4].try_into().unwrap());
        if discriminant != 3 {
            return Err(SwapError::InvalidProgramData.into());
        }
        if head[12] != 1 {
            return Err(SwapError::ImmutableProgram.into());
        }
        let authority_bytes: [u8; 32] = head[13..45].try_into().unwrap();
        Ok(Pubkey::new_from_array(authority_bytes))
    }

    /// Shared config accessor: derives `[b"config"]` and compares
    /// against the passed account's key (else `InvalidProgramAddress` — same
    /// error the pool derivations use, so a forged/wrong-address config can
    /// never be substituted); then requires `owner == program_id` and
    /// `version == 1` (else `absent_error`, named by each caller: CreatePool
    /// maps to `PoolCreationNotConfigured`, every other consumer to
    /// `ConfigNotInitialized`).
    fn load_config(
        program_id: &Pubkey,
        config_info: &AccountInfo,
        absent_error: SwapError,
    ) -> Result<ProtocolConfig, ProgramError> {
        let (expected, _bump) = ProtocolConfig::find_address(program_id);
        if *config_info.key != expected {
            return Err(SwapError::InvalidProgramAddress.into());
        }
        if config_info.owner != program_id {
            return Err(absent_error.into());
        }
        let config = ProtocolConfig::unpack_from_slice(&config_info.data.borrow())?;
        if config.version != CONFIG_VERSION {
            return Err(absent_error.into());
        }
        Ok(config)
    }

    /// Processes an [InitializeConfig](enum.Instruction.html): one-shot,
    /// upgrade-authority-gated creation of `[b"config"]`. Pinned order
    /// (the design plan, Step A1+A2): payer signer → config-PDA
    /// derivation → already-initialized → ProgramData verification
    /// → data validation → grief-proof create → pack.
    pub fn process_initialize_config(
        program_id: &Pubkey,
        admin: Pubkey,
        treasury: Pubkey,
        mode: u8,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let payer_info = next_account_info(account_info_iter)?;
        let upgrade_authority_info = next_account_info(account_info_iter)?;
        let config_info = next_account_info(account_info_iter)?;
        let programdata_info = next_account_info(account_info_iter)?;
        let system_program_info = next_account_info(account_info_iter)?;

        if !payer_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        let (expected_config, config_bump) = ProtocolConfig::find_address(program_id);
        if *config_info.key != expected_config {
            return Err(SwapError::InvalidProgramAddress.into());
        }
        // One-shot: a config PDA already OWNED by this program is a
        // completed InitializeConfig. Refused explicitly and BEFORE any
        // CPI — under the grief-proof path the CPI-level failure on a
        // re-create attempt would be a different, less legible error.
        if config_info.owner == program_id {
            return Err(SwapError::ConfigAlreadyInitialized.into());
        }

        if !upgrade_authority_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        let parsed_authority = Self::verify_program_data(program_id, programdata_info)?;
        if *upgrade_authority_info.key != parsed_authority {
            return Err(SwapError::InvalidConfigAuthority.into());
        }

        if admin == Pubkey::default() || treasury == Pubkey::default() {
            return Err(SwapError::InvalidConfigValue.into());
        }
        if mode > MODE_PERMISSIONLESS {
            return Err(SwapError::InvalidPoolCreationMode.into());
        }

        let config_signer_seeds: &[&[u8]] = &[CONFIG_SEED, &[config_bump]];
        Self::create_pda_account(
            payer_info,
            config_info,
            system_program_info,
            config_signer_seeds,
            ProtocolConfig::LEN,
            program_id,
        )?;

        let config = ProtocolConfig {
            version: CONFIG_VERSION,
            admin,
            pending_admin: Pubkey::default(),
            treasury,
            pool_creation_mode: mode,
        };
        ProtocolConfig::pack(config, &mut config_info.data.borrow_mut())?;
        Ok(())
    }

    /// Processes a [SetTreasury](enum.Instruction.html): admin-signed,
    /// live-read by `CollectProtocolFees` (retroactivity).
    pub fn process_set_treasury(
        program_id: &Pubkey,
        treasury: Pubkey,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_info = next_account_info(account_info_iter)?;
        let admin_info = next_account_info(account_info_iter)?;

        let mut config =
            Self::load_config(program_id, config_info, SwapError::ConfigNotInitialized)?;
        if !admin_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *admin_info.key != config.admin {
            return Err(SwapError::NotAdmin.into());
        }
        if treasury == Pubkey::default() {
            return Err(SwapError::InvalidConfigValue.into());
        }
        config.treasury = treasury;
        ProtocolConfig::pack(config, &mut config_info.data.borrow_mut())?;
        Ok(())
    }

    /// Processes a [TransferAdmin](enum.Instruction.html): step 1 of 2.
    /// Writes `pending_admin` ONLY — `admin` stays exactly as it was until
    /// `AcceptAdmin` runs (two-step; `Pubkey::default()` cancels).
    pub fn process_transfer_admin(
        program_id: &Pubkey,
        pending_admin: Pubkey,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_info = next_account_info(account_info_iter)?;
        let admin_info = next_account_info(account_info_iter)?;

        let mut config =
            Self::load_config(program_id, config_info, SwapError::ConfigNotInitialized)?;
        if !admin_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *admin_info.key != config.admin {
            return Err(SwapError::NotAdmin.into());
        }
        config.pending_admin = pending_admin;
        ProtocolConfig::pack(config, &mut config_info.data.borrow_mut())?;
        Ok(())
    }

    /// Processes an [AcceptAdmin](enum.Instruction.html): step 2 of 2.
    /// Promotes `pending_admin` to `admin`, clears `pending_admin` back to
    /// default. `pending_admin == default` (no transfer pending) can never
    /// match a real signer — the zero key has no private key — so that case
    /// is `NotPendingAdmin` too, not a separate arm.
    pub fn process_accept_admin(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_info = next_account_info(account_info_iter)?;
        let pending_admin_info = next_account_info(account_info_iter)?;

        let mut config =
            Self::load_config(program_id, config_info, SwapError::ConfigNotInitialized)?;
        if !pending_admin_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if config.pending_admin == Pubkey::default()
            || *pending_admin_info.key != config.pending_admin
        {
            return Err(SwapError::NotPendingAdmin.into());
        }
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();
        ProtocolConfig::pack(config, &mut config_info.data.borrow_mut())?;
        Ok(())
    }

    /// Processes [CollectProtocolFees](enum.Instruction.html): PERMISSIONLESS
    /// (zero instruction data — the amount moved is read from state, the
    /// destination owner from config, never from caller input). Moves
    /// EXACTLY the accrued counters vault → treasury-owned destinations,
    /// then zeroes both counters — the outflow invariant, I1-I3
    /// (the design plan). Pinned order: pool owner +
    /// SwapVersion::unpack → authority derivation → vault keys vs state →
    /// per-side token-program-vs-vault-owner pins → load_config →
    /// destination unpack → destination pins → per-side transfer
    /// → zero-both-counters repack.
    ///
    /// Mixed-vault pools (vault A and vault B under DIFFERENT token
    /// programs) need each side served by ITS OWN program — a single
    /// shared program can only ever match one side, so account 10
    /// (`token_program_b`) is appended to give each side its own program
    /// (the pre-fix single-program shape permanently stranded whichever
    /// side's counter it couldn't reach).
    pub fn process_collect_protocol_fees(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let pool_info = next_account_info(account_info_iter)?;
        let authority_info = next_account_info(account_info_iter)?;
        let vault_a_info = next_account_info(account_info_iter)?;
        let vault_b_info = next_account_info(account_info_iter)?;
        let dest_a_info = next_account_info(account_info_iter)?;
        let dest_b_info = next_account_info(account_info_iter)?;
        let mint_a_info = next_account_info(account_info_iter)?;
        let mint_b_info = next_account_info(account_info_iter)?;
        let config_info = next_account_info(account_info_iter)?;
        let token_program_a_info = next_account_info(account_info_iter)?;
        let token_program_b_info = next_account_info(account_info_iter)?;

        if pool_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }
        let token_swap = SwapVersion::unpack(&pool_info.data.borrow())?;

        if *authority_info.key
            != Self::authority_id(program_id, pool_info.key, token_swap.bump_seed())?
        {
            return Err(SwapError::InvalidProgramAddress.into());
        }
        if *vault_a_info.key != *token_swap.token_a_account()
            || *vault_b_info.key != *token_swap.token_b_account()
        {
            return Err(SwapError::IncorrectSwapAccount.into());
        }

        // Each side's caller-supplied token program must be the program
        // that ACTUALLY owns that side's vault — a NAMED error up front,
        // not the bare CPI failure a mismatched transfer would otherwise
        // surface several steps later (and only for whichever side the
        // wrong program happened to fail on).
        if *vault_a_info.owner != *token_program_a_info.key {
            return Err(SwapError::IncorrectTokenProgramId.into());
        }
        if *vault_b_info.owner != *token_program_b_info.key {
            return Err(SwapError::IncorrectTokenProgramId.into());
        }

        let config = Self::load_config(program_id, config_info, SwapError::ConfigNotInitialized)?;

        let dest_a = Self::unpack_token_account(dest_a_info, token_program_a_info.key)?;
        let dest_b = Self::unpack_token_account(dest_b_info, token_program_b_info.key)?;

        // Destination pins the token program does NOT check itself
        // (transfer_checked already binds source.mint == mint == dest.mint).
        if dest_a.owner != config.treasury
            || dest_a.mint != *token_swap.token_a_mint()
            || *dest_a_info.key == *vault_a_info.key
        {
            return Err(SwapError::InvalidTreasuryDestination.into());
        }
        if dest_b.owner != config.treasury
            || dest_b.mint != *token_swap.token_b_mint()
            || *dest_b_info.key == *vault_b_info.key
        {
            return Err(SwapError::InvalidTreasuryDestination.into());
        }

        let counter_a = token_swap.protocol_fees_a();
        let counter_b = token_swap.protocol_fees_b();

        if counter_a > 0 {
            let decimals = Self::unpack_mint(mint_a_info, token_program_a_info.key)?.decimals;
            Self::token_transfer(
                pool_info.key,
                token_program_a_info.clone(),
                vault_a_info.clone(),
                mint_a_info.clone(),
                dest_a_info.clone(),
                authority_info.clone(),
                token_swap.bump_seed(),
                counter_a,
                decimals,
            )?;
        }
        if counter_b > 0 {
            let decimals = Self::unpack_mint(mint_b_info, token_program_b_info.key)?.decimals;
            Self::token_transfer(
                pool_info.key,
                token_program_b_info.clone(),
                vault_b_info.clone(),
                mint_b_info.clone(),
                dest_b_info.clone(),
                authority_info.clone(),
                token_swap.bump_seed(),
                counter_b,
                decimals,
            )?;
        }

        {
            let mut data = pool_info.data.borrow_mut();
            let mut v2 = SwapV2::unpack(&data[1..])?;
            v2.protocol_fees_a = 0;
            v2.protocol_fees_b = 0;
            SwapV2::pack(v2, &mut data[1..])?;
        }

        Ok(())
    }

    /// Processes a [SetPoolCreation](enum.Instruction.html): admin-signed
    /// flip of `pool_creation_mode` (0 or 1 only).
    pub fn process_set_pool_creation(
        program_id: &Pubkey,
        mode: u8,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let config_info = next_account_info(account_info_iter)?;
        let admin_info = next_account_info(account_info_iter)?;

        let mut config =
            Self::load_config(program_id, config_info, SwapError::ConfigNotInitialized)?;
        if !admin_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *admin_info.key != config.admin {
            return Err(SwapError::NotAdmin.into());
        }
        if mode > MODE_PERMISSIONLESS {
            return Err(SwapError::InvalidPoolCreationMode.into());
        }
        config.pool_creation_mode = mode;
        ProtocolConfig::pack(config, &mut config_info.data.borrow_mut())?;
        Ok(())
    }

    /// Shared validation + initial-LP-mint + pack tail, delegated to by
    /// [`process_create_pool`] (the single creation path; tag 0 `Initialize`
    /// is retired — see the dispatch arm in `process_with_constraints`).
    fn init_pool_state(
        program_id: &Pubkey,
        fees: Fees,
        swap_curve: SwapCurve,
        accounts: &[AccountInfo],
        swap_constraints: &Option<SwapConstraints>,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let swap_info = next_account_info(account_info_iter)?;
        let authority_info = next_account_info(account_info_iter)?;
        let token_a_info = next_account_info(account_info_iter)?;
        let token_b_info = next_account_info(account_info_iter)?;
        let pool_mint_info = next_account_info(account_info_iter)?;
        let destination_info = next_account_info(account_info_iter)?;
        let pool_token_program_info = next_account_info(account_info_iter)?;

        let token_program_id = *pool_token_program_info.key;
        if SwapVersion::is_initialized(&swap_info.data.borrow()) {
            return Err(SwapError::AlreadyInUse.into());
        }

        let (swap_authority, bump_seed) =
            Pubkey::find_program_address(&[&swap_info.key.to_bytes()], program_id);
        if *authority_info.key != swap_authority {
            return Err(SwapError::InvalidProgramAddress.into());
        }
        let token_a = Self::unpack_token_account(token_a_info, &token_program_id)?;
        let token_b = Self::unpack_token_account(token_b_info, &token_program_id)?;
        let destination = Self::unpack_token_account(destination_info, &token_program_id)?;
        let pool_mint = {
            let pool_mint_data = pool_mint_info.data.borrow();
            let pool_mint = Self::unpack_mint_with_extensions(
                &pool_mint_data,
                pool_mint_info.owner,
                &token_program_id,
            )?;
            if let Ok(extension) = pool_mint.get_extension::<MintCloseAuthority>() {
                let close_authority: Option<Pubkey> = extension.close_authority.into();
                if close_authority.is_some() {
                    return Err(SwapError::InvalidCloseAuthority.into());
                }
            }
            pool_mint.base
        };
        if *authority_info.key != token_a.owner {
            return Err(SwapError::InvalidOwner.into());
        }
        if *authority_info.key != token_b.owner {
            return Err(SwapError::InvalidOwner.into());
        }
        if *authority_info.key == destination.owner {
            return Err(SwapError::InvalidOutputOwner.into());
        }
        if COption::Some(*authority_info.key) != pool_mint.mint_authority {
            return Err(SwapError::InvalidOwner.into());
        }

        if token_a.mint == token_b.mint {
            return Err(SwapError::RepeatedMint.into());
        }
        // Reserve-exclusion EXEMPT site (the design plan):
        // this instruction itself packs both protocol-fee counters as zero
        // (below), so there is no state in which excluding them could differ
        // from this raw read. No mutant is claimable here — decorative by
        // construction.
        swap_curve
            .calculator
            .validate_supply(token_a.amount, token_b.amount)?;
        if token_a.delegate.is_some() {
            return Err(SwapError::InvalidDelegate.into());
        }
        if token_b.delegate.is_some() {
            return Err(SwapError::InvalidDelegate.into());
        }
        if token_a.close_authority.is_some() {
            return Err(SwapError::InvalidCloseAuthority.into());
        }
        if token_b.close_authority.is_some() {
            return Err(SwapError::InvalidCloseAuthority.into());
        }

        if pool_mint.supply != 0 {
            return Err(SwapError::InvalidSupply.into());
        }
        if pool_mint.freeze_authority.is_some() {
            return Err(SwapError::InvalidFreezeAuthority.into());
        }

        if let Some(swap_constraints) = swap_constraints {
            swap_constraints.validate_curve(&swap_curve)?;
            swap_constraints.validate_fees(&fees)?;
        }
        fees.validate()?;
        swap_curve.calculator.validate()?;

        let initial_amount = swap_curve.calculator.new_pool_supply();

        Self::token_mint_to(
            swap_info.key,
            pool_token_program_info.clone(),
            pool_mint_info.clone(),
            destination_info.clone(),
            authority_info.clone(),
            bump_seed,
            to_u64(initial_amount)?,
        )?;

        let obj = SwapVersion::SwapV2(SwapV2 {
            is_initialized: true,
            bump_seed,
            token_program_id,
            token_a: *token_a_info.key,
            token_b: *token_b_info.key,
            pool_mint: *pool_mint_info.key,
            token_a_mint: token_a.mint,
            token_b_mint: token_b.mint,
            fees,
            swap_curve,
            protocol_fees_a: 0,
            protocol_fees_b: 0,
        });
        SwapVersion::pack(obj, &mut swap_info.data.borrow_mut())?;
        Ok(())
    }

    /// Processes a [CreatePool](enum.Instruction.html).
    ///
    /// Creates a NEW pool with NO ephemeral signers: the program creates the pool
    /// state PDA `[b"cp_pool", mint_a, mint_b, fee_bps_le]` and the LP mint PDA
    /// `[b"cp_lp", pool]` via `invoke_signed`, then delegates to the SAME
    /// validation + initial-LP-mint + pack as [`init_pool_state`] (the vaults
    /// must already be funded by the caller, exactly as Initialize requires). This
    /// is what lets the EVM lane create a pool through the CPI precompile.
    #[allow(clippy::too_many_arguments)]
    pub fn process_create_pool(
        program_id: &Pubkey,
        fees: Fees,
        swap_curve: SwapCurve,
        fee_bps: u16,
        pool_bump: u8,
        lp_bump: u8,
        accounts: &[AccountInfo],
        swap_constraints: &Option<SwapConstraints>,
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let payer_info = next_account_info(account_info_iter)?;
        let pool_info = next_account_info(account_info_iter)?;
        let authority_info = next_account_info(account_info_iter)?;
        let mint_a_info = next_account_info(account_info_iter)?;
        let mint_b_info = next_account_info(account_info_iter)?;
        let vault_a_info = next_account_info(account_info_iter)?;
        let vault_b_info = next_account_info(account_info_iter)?;
        let lp_mint_info = next_account_info(account_info_iter)?;
        let destination_info = next_account_info(account_info_iter)?;
        let pool_token_program_info = next_account_info(account_info_iter)?;
        let system_program_info = next_account_info(account_info_iter)?;
        let config_info = next_account_info(account_info_iter)?;

        if !payer_info.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Pool-creation policy gate — runs immediately after the
        // payer signer check, before AlreadyInUse (policy outermost).
        // Config absence/uninitialized fails CLOSED: `PoolCreationNotConfigured`,
        // never a permissive fallback (today, pre-v2, CreatePool has no
        // gate at all and always succeeds — that is the definitive red this
        // closes). Mode 0 requires the payer to be the admin.
        let config =
            Self::load_config(program_id, config_info, SwapError::PoolCreationNotConfigured)?;
        if !config.is_permissionless() && *payer_info.key != config.admin {
            return Err(SwapError::PoolCreationRestricted.into());
        }

        if SwapVersion::is_initialized(&pool_info.data.borrow()) {
            return Err(SwapError::AlreadyInUse.into());
        }
        let token_program_id = *pool_token_program_info.key;

        // fee_bps bind: the pool PDA seed must agree
        // with the fee parameters that will actually run, or a canonical
        // address could be created with divergent economics. Floor rule,
        // u128 arithmetic, mirroring the reference formula
        // (`processor.rs:1981-1991` in the test harness) exactly — reduces to
        // `trade_num + owner_num == fee_bps` wherever denominators are 10000
        // (production's pinned denominators, `constraints.rs:91-117`).
        // Validated BEFORE any derivation or CPI — the seed is checked before
        // it is used.
        fn term(n: u64, d: u64) -> Result<u128, SwapError> {
            if d == 0 {
                Ok(0)
            } else {
                (n as u128)
                    .checked_mul(10000)
                    .ok_or(SwapError::FeeCalculationFailure)?
                    .checked_div(d as u128)
                    .ok_or(SwapError::FeeCalculationFailure)
            }
        }
        let bound = term(fees.trade_fee_numerator, fees.trade_fee_denominator)?
            .checked_add(term(
                fees.owner_trade_fee_numerator,
                fees.owner_trade_fee_denominator,
            )?)
            .ok_or(SwapError::FeeCalculationFailure)?;
        if u128::from(fee_bps) != bound {
            return Err(SwapError::FeeBpsMismatch.into());
        }

        // Pool state PDA: [b"cp_pool", mint_a, mint_b, fee_bps_le, pool_bump].
        let fee_le = fee_bps.to_le_bytes();
        let pool_signer_seeds: &[&[u8]] = &[
            b"cp_pool",
            mint_a_info.key.as_ref(),
            mint_b_info.key.as_ref(),
            &fee_le,
            &[pool_bump],
        ];
        let expected_pool = Pubkey::create_program_address(pool_signer_seeds, program_id)
            .map_err(|_| SwapError::InvalidProgramAddress)?;
        if expected_pool != *pool_info.key {
            return Err(SwapError::InvalidProgramAddress.into());
        }

        // Authority PDA == the derivation Swap/Deposit/Withdraw use ([pool]).
        let (authority_key, _authority_bump) =
            Pubkey::find_program_address(&[&pool_info.key.to_bytes()], program_id);
        if authority_key != *authority_info.key {
            return Err(SwapError::InvalidProgramAddress.into());
        }

        // Create the pool state account (pool PDA signs its own creation).
        // Grief-proof (Part D): bare `create_account` fails forever
        // if this canonical, precomputable address already holds ≥1
        // lamport — a dust pre-fund would permanently brick this pool
        // (the design plan). `create_pda_account` does its own
        // `Rent::get()` internally.
        let pool_space = SwapVersion::LATEST_LEN;
        Self::create_pda_account(
            payer_info,
            pool_info,
            system_program_info,
            pool_signer_seeds,
            pool_space,
            program_id,
        )?;

        // Create + initialize the LP mint (LP PDA signs; authority = pool authority).
        let lp_signer_seeds: &[&[u8]] = &[b"cp_lp", pool_info.key.as_ref(), &[lp_bump]];
        let expected_lp = Pubkey::create_program_address(lp_signer_seeds, program_id)
            .map_err(|_| SwapError::InvalidProgramAddress)?;
        if expected_lp != *lp_mint_info.key {
            return Err(SwapError::InvalidProgramAddress.into());
        }
        let mint_space = Mint::LEN;
        Self::create_pda_account(
            payer_info,
            lp_mint_info,
            system_program_info,
            lp_signer_seeds,
            mint_space,
            pool_token_program_info.key,
        )?;
        invoke(
            &spl_token_2022::instruction::initialize_mint2(
                pool_token_program_info.key,
                lp_mint_info.key,
                authority_info.key,
                None,
                6, // LP mint decimals
            )?,
            &[lp_mint_info.clone(), pool_token_program_info.clone()],
        )?;

        // Create the destination LP token account INSIDE the instruction —
        // it is a token account of the LP mint just created, so the caller
        // can't pre-make it. Program-signed PDA; InitializeAccount3 sets its
        // owner to the CREATOR, so the creator holds the initial LP. (D6:
        // the fee LP account this loop used to ALSO create — cp_fee, owned
        // by the pool key, the colliding object — is deleted;
        // protocol fees are counters in SwapV2 state now, not an LP-mint
        // account.)
        let account_space = Account::LEN;
        let (expected_dest, dest_bump) =
            Pubkey::find_program_address(&[b"cp_dest", pool_info.key.as_ref()], program_id);
        if expected_dest != *destination_info.key {
            return Err(SwapError::InvalidProgramAddress.into());
        }
        let dest_signer_seeds: &[&[u8]] = &[b"cp_dest", pool_info.key.as_ref(), &[dest_bump]];
        Self::create_pda_account(
            payer_info,
            destination_info,
            system_program_info,
            dest_signer_seeds,
            account_space,
            &token_program_id,
        )?;
        invoke(
            &spl_token_2022::instruction::initialize_account3(
                &token_program_id,
                destination_info.key,
                lp_mint_info.key,
                payer_info.key,
            )?,
            &[destination_info.clone(), lp_mint_info.clone()],
        )?;

        // Delegate to the SAME validation + initial-LP-mint + pack as
        // init_pool_state. The vaults must already be funded by the caller.
        let init_accounts = [
            pool_info.clone(),
            authority_info.clone(),
            vault_a_info.clone(),
            vault_b_info.clone(),
            lp_mint_info.clone(),
            destination_info.clone(),
            pool_token_program_info.clone(),
        ];
        Self::init_pool_state(program_id, fees, swap_curve, &init_accounts, swap_constraints)
    }

    /// Processes an [Swap](enum.Instruction.html).
    pub fn process_swap(
        program_id: &Pubkey,
        amount_in: u64,
        minimum_amount_out: u64,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        Self::process_swap_generic(
            program_id,
            SwapSpec::ExactIn {
                amount_in,
                minimum_amount_out,
            },
            accounts,
        )
    }

    /// Processes a [SwapExactOut](enum.Instruction.html): receive an exact
    /// amount of destination token, paying up to `maximum_amount_in` source.
    pub fn process_swap_exact_out(
        program_id: &Pubkey,
        amount_out: u64,
        maximum_amount_in: u64,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        Self::process_swap_generic(
            program_id,
            SwapSpec::ExactOut {
                amount_out,
                maximum_amount_in,
            },
            accounts,
        )
    }

    /// Shared swap engine for both exact-in and exact-out. Account layout,
    /// validation, Token-2022 transfer-fee handling, and owner-fee minting are
    /// identical across modes; only how the curve result is derived and which
    /// side the slippage guard applies to differ.
    fn process_swap_generic(
        program_id: &Pubkey,
        spec: SwapSpec,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let swap_info = next_account_info(account_info_iter)?;
        let authority_info = next_account_info(account_info_iter)?;
        let user_transfer_authority_info = next_account_info(account_info_iter)?;
        let source_info = next_account_info(account_info_iter)?;
        let swap_source_info = next_account_info(account_info_iter)?;
        let swap_destination_info = next_account_info(account_info_iter)?;
        let destination_info = next_account_info(account_info_iter)?;
        let pool_mint_info = next_account_info(account_info_iter)?;
        let source_token_mint_info = next_account_info(account_info_iter)?;
        let destination_token_mint_info = next_account_info(account_info_iter)?;
        let source_token_program_info = next_account_info(account_info_iter)?;
        let destination_token_program_info = next_account_info(account_info_iter)?;
        let pool_token_program_info = next_account_info(account_info_iter)?;

        if swap_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }
        let token_swap = SwapVersion::unpack(&swap_info.data.borrow())?;

        if *authority_info.key
            != Self::authority_id(program_id, swap_info.key, token_swap.bump_seed())?
        {
            return Err(SwapError::InvalidProgramAddress.into());
        }
        if !(*swap_source_info.key == *token_swap.token_a_account()
            || *swap_source_info.key == *token_swap.token_b_account())
        {
            return Err(SwapError::IncorrectSwapAccount.into());
        }
        if !(*swap_destination_info.key == *token_swap.token_a_account()
            || *swap_destination_info.key == *token_swap.token_b_account())
        {
            return Err(SwapError::IncorrectSwapAccount.into());
        }
        if *swap_source_info.key == *swap_destination_info.key {
            return Err(SwapError::InvalidInput.into());
        }
        if swap_source_info.key == source_info.key {
            return Err(SwapError::InvalidInput.into());
        }
        if swap_destination_info.key == destination_info.key {
            return Err(SwapError::InvalidInput.into());
        }
        if *pool_mint_info.key != *token_swap.pool_mint() {
            return Err(SwapError::IncorrectPoolMint.into());
        }
        if *pool_token_program_info.key != *token_swap.token_program_id() {
            return Err(SwapError::IncorrectTokenProgramId.into());
        }

        let source_account =
            Self::unpack_token_account(swap_source_info, token_swap.token_program_id())?;
        let dest_account =
            Self::unpack_token_account(swap_destination_info, token_swap.token_program_id())?;

        // Calculate the trade direction
        let trade_direction = if *swap_source_info.key == *token_swap.token_a_account() {
            TradeDirection::AtoB
        } else {
            TradeDirection::BtoA
        };

        // Reserve exclusions X1-X4 (the design plan): pool
        // math never sees the counters' tokens. Direction-keyed: AtoB's
        // source is token_a (excludes protocol_fees_a) / dest is token_b
        // (excludes protocol_fees_b); BtoA is the mirror.
        let (lp_source, lp_dest) = match trade_direction {
            TradeDirection::AtoB => (
                Self::lp_owned(source_account.amount, token_swap.protocol_fees_a())?,
                Self::lp_owned(dest_account.amount, token_swap.protocol_fees_b())?,
            ),
            TradeDirection::BtoA => (
                Self::lp_owned(source_account.amount, token_swap.protocol_fees_b())?,
                Self::lp_owned(dest_account.amount, token_swap.protocol_fees_a())?,
            ),
        };

        // Derive the curve result. Exact-in feeds a (transfer-fee-adjusted)
        // input amount forward; exact-out solves the curve for the required
        // input given the desired output.
        let result = match spec {
            SwapSpec::ExactIn { amount_in, .. } => {
                // Take transfer fees into account for actual amount transferred in
                let actual_amount_in = {
                    let source_mint_data = source_token_mint_info.data.borrow();
                    let source_mint = Self::unpack_mint_with_extensions(
                        &source_mint_data,
                        source_token_mint_info.owner,
                        token_swap.token_program_id(),
                    )?;

                    if let Ok(transfer_fee_config) =
                        source_mint.get_extension::<TransferFeeConfig>()
                    {
                        amount_in.saturating_sub(
                            transfer_fee_config
                                .calculate_epoch_fee(Clock::get()?.epoch, amount_in)
                                .ok_or(SwapError::FeeCalculationFailure)?,
                        )
                    } else {
                        amount_in
                    }
                };
                token_swap
                    .swap_curve()
                    .swap(
                        u128::from(actual_amount_in),
                        u128::from(lp_source),
                        u128::from(lp_dest),
                        trade_direction,
                        token_swap.fees(),
                    )
                    .ok_or(SwapError::ZeroTradingTokens)?
            }
            SwapSpec::ExactOut { amount_out, .. } => token_swap
                .swap_curve()
                .swap_for_exact_out(
                    u128::from(amount_out),
                    u128::from(lp_source),
                    u128::from(lp_dest),
                    trade_direction,
                    token_swap.fees(),
                )
                .ok_or(SwapError::ZeroTradingTokens)?,
        };

        // Re-calculate the source amount swapped based on what the curve says
        let (source_transfer_amount, source_mint_decimals) = {
            let source_amount_swapped = to_u64(result.source_amount_swapped)?;

            let source_mint_data = source_token_mint_info.data.borrow();
            let source_mint = Self::unpack_mint_with_extensions(
                &source_mint_data,
                source_token_mint_info.owner,
                token_swap.token_program_id(),
            )?;
            let amount =
                if let Ok(transfer_fee_config) = source_mint.get_extension::<TransferFeeConfig>() {
                    source_amount_swapped.saturating_add(
                        transfer_fee_config
                            .calculate_inverse_epoch_fee(Clock::get()?.epoch, source_amount_swapped)
                            .ok_or(SwapError::FeeCalculationFailure)?,
                    )
                } else {
                    source_amount_swapped
                };
            (amount, source_mint.base.decimals)
        };

        // Exact-out slippage guard applies to the INPUT side.
        if let SwapSpec::ExactOut {
            maximum_amount_in, ..
        } = spec
        {
            if source_transfer_amount > maximum_amount_in {
                return Err(SwapError::ExceededSlippage.into());
            }
        }

        let (destination_transfer_amount, destination_mint_decimals) = {
            let destination_mint_data = destination_token_mint_info.data.borrow();
            let destination_mint = Self::unpack_mint_with_extensions(
                &destination_mint_data,
                destination_token_mint_info.owner,
                token_swap.token_program_id(),
            )?;
            let amount_out = to_u64(result.destination_amount_swapped)?;
            let amount_received = if let Ok(transfer_fee_config) =
                destination_mint.get_extension::<TransferFeeConfig>()
            {
                amount_out.saturating_sub(
                    transfer_fee_config
                        .calculate_epoch_fee(Clock::get()?.epoch, amount_out)
                        .ok_or(SwapError::FeeCalculationFailure)?,
                )
            } else {
                amount_out
            };
            // Exact-in slippage guard applies to the OUTPUT side.
            if let SwapSpec::ExactIn {
                minimum_amount_out, ..
            } = spec
            {
                if amount_received < minimum_amount_out {
                    return Err(SwapError::ExceededSlippage.into());
                }
            }
            (amount_out, destination_mint.base.decimals)
        };

        Self::token_transfer(
            swap_info.key,
            source_token_program_info.clone(),
            source_info.clone(),
            source_token_mint_info.clone(),
            swap_source_info.clone(),
            user_transfer_authority_info.clone(),
            token_swap.bump_seed(),
            source_transfer_amount,
            source_mint_decimals,
        )?;

        // Accrue the protocol's slice of the fee to the source side's
        // counter. The tokens are already IN the vault: both curve paths
        // fold total_fees into new_swap_source_amount (curve/base.rs:96-106,
        // :139-149), so this is pure u64 bookkeeping over tokens the source
        // transfer just delivered. Unconditional (no `if owner_fee > 0`
        // branch — adding 0 is a no-op): one uniform path, no waiver-shaped
        // branch to mutate. `checked_add` (never bare `+` — dev profile has
        // no overflow checks; never `saturating_add` — silent fee
        // destruction).
        let owner_fee = to_u64(result.owner_fee)?;
        {
            let mut data = swap_info.data.borrow_mut();
            // Version already validated by the SwapVersion::unpack above.
            let mut v2 = SwapV2::unpack(&data[1..])?;
            let counter = match trade_direction {
                TradeDirection::AtoB => &mut v2.protocol_fees_a,
                TradeDirection::BtoA => &mut v2.protocol_fees_b,
            };
            *counter = counter
                .checked_add(owner_fee)
                .ok_or(SwapError::FeeCalculationFailure)?;
            SwapV2::pack(v2, &mut data[1..])?;
        }

        Self::token_transfer(
            swap_info.key,
            destination_token_program_info.clone(),
            swap_destination_info.clone(),
            destination_token_mint_info.clone(),
            destination_info.clone(),
            authority_info.clone(),
            token_swap.bump_seed(),
            destination_transfer_amount,
            destination_mint_decimals,
        )?;

        Ok(())
    }

    /// Processes an [DepositAllTokenTypes](enum.Instruction.html).
    pub fn process_deposit_all_token_types(
        program_id: &Pubkey,
        pool_token_amount: u64,
        maximum_token_a_amount: u64,
        maximum_token_b_amount: u64,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let swap_info = next_account_info(account_info_iter)?;
        let authority_info = next_account_info(account_info_iter)?;
        let user_transfer_authority_info = next_account_info(account_info_iter)?;
        let source_a_info = next_account_info(account_info_iter)?;
        let source_b_info = next_account_info(account_info_iter)?;
        let token_a_info = next_account_info(account_info_iter)?;
        let token_b_info = next_account_info(account_info_iter)?;
        let pool_mint_info = next_account_info(account_info_iter)?;
        let dest_info = next_account_info(account_info_iter)?;
        let token_a_mint_info = next_account_info(account_info_iter)?;
        let token_b_mint_info = next_account_info(account_info_iter)?;
        let token_a_program_info = next_account_info(account_info_iter)?;
        let token_b_program_info = next_account_info(account_info_iter)?;
        let pool_token_program_info = next_account_info(account_info_iter)?;

        let token_swap = SwapVersion::unpack(&swap_info.data.borrow())?;
        let calculator = &token_swap.swap_curve().calculator;
        if !calculator.allows_deposits() {
            return Err(SwapError::UnsupportedCurveOperation.into());
        }
        Self::check_accounts(
            token_swap.as_ref(),
            program_id,
            swap_info,
            authority_info,
            token_a_info,
            token_b_info,
            pool_mint_info,
            pool_token_program_info,
            Some(source_a_info),
            Some(source_b_info),
        )?;

        let token_a = Self::unpack_token_account(token_a_info, token_swap.token_program_id())?;
        let token_b = Self::unpack_token_account(token_b_info, token_swap.token_program_id())?;
        let pool_mint = Self::unpack_mint(pool_mint_info, token_swap.token_program_id())?;
        // Reserve exclusion X5 (the design plan): pool math
        // never sees the counters' tokens — LPs deposit against the
        // LP-owned reserves, not the raw vault.
        let lp_a = Self::lp_owned(token_a.amount, token_swap.protocol_fees_a())?;
        let lp_b = Self::lp_owned(token_b.amount, token_swap.protocol_fees_b())?;
        let current_pool_mint_supply = u128::from(pool_mint.supply);
        let (pool_token_amount, pool_mint_supply) = if current_pool_mint_supply > 0 {
            (u128::from(pool_token_amount), current_pool_mint_supply)
        } else {
            (calculator.new_pool_supply(), calculator.new_pool_supply())
        };

        let results = calculator
            .pool_tokens_to_trading_tokens(
                pool_token_amount,
                pool_mint_supply,
                u128::from(lp_a),
                u128::from(lp_b),
                RoundDirection::Ceiling,
            )
            .ok_or(SwapError::ZeroTradingTokens)?;
        let token_a_amount = to_u64(results.token_a_amount)?;
        if token_a_amount > maximum_token_a_amount {
            return Err(SwapError::ExceededSlippage.into());
        }
        if token_a_amount == 0 {
            return Err(SwapError::ZeroTradingTokens.into());
        }
        let token_b_amount = to_u64(results.token_b_amount)?;
        if token_b_amount > maximum_token_b_amount {
            return Err(SwapError::ExceededSlippage.into());
        }
        if token_b_amount == 0 {
            return Err(SwapError::ZeroTradingTokens.into());
        }

        let pool_token_amount = to_u64(pool_token_amount)?;

        Self::token_transfer(
            swap_info.key,
            token_a_program_info.clone(),
            source_a_info.clone(),
            token_a_mint_info.clone(),
            token_a_info.clone(),
            user_transfer_authority_info.clone(),
            token_swap.bump_seed(),
            token_a_amount,
            Self::unpack_mint(token_a_mint_info, token_swap.token_program_id())?.decimals,
        )?;
        Self::token_transfer(
            swap_info.key,
            token_b_program_info.clone(),
            source_b_info.clone(),
            token_b_mint_info.clone(),
            token_b_info.clone(),
            user_transfer_authority_info.clone(),
            token_swap.bump_seed(),
            token_b_amount,
            Self::unpack_mint(token_b_mint_info, token_swap.token_program_id())?.decimals,
        )?;
        Self::token_mint_to(
            swap_info.key,
            pool_token_program_info.clone(),
            pool_mint_info.clone(),
            dest_info.clone(),
            authority_info.clone(),
            token_swap.bump_seed(),
            pool_token_amount,
        )?;

        Ok(())
    }

    /// Processes an [WithdrawAllTokenTypes](enum.Instruction.html).
    pub fn process_withdraw_all_token_types(
        program_id: &Pubkey,
        pool_token_amount: u64,
        minimum_token_a_amount: u64,
        minimum_token_b_amount: u64,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let swap_info = next_account_info(account_info_iter)?;
        let authority_info = next_account_info(account_info_iter)?;
        let user_transfer_authority_info = next_account_info(account_info_iter)?;
        let pool_mint_info = next_account_info(account_info_iter)?;
        let source_info = next_account_info(account_info_iter)?;
        let token_a_info = next_account_info(account_info_iter)?;
        let token_b_info = next_account_info(account_info_iter)?;
        let dest_token_a_info = next_account_info(account_info_iter)?;
        let dest_token_b_info = next_account_info(account_info_iter)?;
        let token_a_mint_info = next_account_info(account_info_iter)?;
        let token_b_mint_info = next_account_info(account_info_iter)?;
        let pool_token_program_info = next_account_info(account_info_iter)?;
        let token_a_program_info = next_account_info(account_info_iter)?;
        let token_b_program_info = next_account_info(account_info_iter)?;

        let token_swap = SwapVersion::unpack(&swap_info.data.borrow())?;
        Self::check_accounts(
            token_swap.as_ref(),
            program_id,
            swap_info,
            authority_info,
            token_a_info,
            token_b_info,
            pool_mint_info,
            pool_token_program_info,
            Some(dest_token_a_info),
            Some(dest_token_b_info),
        )?;

        let token_a = Self::unpack_token_account(token_a_info, token_swap.token_program_id())?;
        let token_b = Self::unpack_token_account(token_b_info, token_swap.token_program_id())?;
        let pool_mint = Self::unpack_mint(pool_mint_info, token_swap.token_program_id())?;

        let calculator = &token_swap.swap_curve().calculator;

        // Reserve exclusions X6 (pro-rata) — the withdraw-fee LP-mint
        // machinery this replaces (`owner_withdraw_fee`, `:1058-1075` in the
        // plan's pre-slice cites) is deleted: production pins
        // owner_withdraw_fee to 0/0 (constraints.rs), so it shipped dead;
        // burn = full `pool_token_amount`, no fee deduction (D8).
        let pool_token_amount = u128::from(pool_token_amount);
        let lp_a = Self::lp_owned(token_a.amount, token_swap.protocol_fees_a())?;
        let lp_b = Self::lp_owned(token_b.amount, token_swap.protocol_fees_b())?;

        let results = calculator
            .pool_tokens_to_trading_tokens(
                pool_token_amount,
                u128::from(pool_mint.supply),
                u128::from(lp_a),
                u128::from(lp_b),
                RoundDirection::Floor,
            )
            .ok_or(SwapError::ZeroTradingTokens)?;
        let token_a_amount = to_u64(results.token_a_amount)?;
        // X7: clamp against the LP-owned reserve, never the raw vault.
        let token_a_amount = std::cmp::min(lp_a, token_a_amount);
        if token_a_amount < minimum_token_a_amount {
            return Err(SwapError::ExceededSlippage.into());
        }
        // X8: zero-guard reads the LP-owned reserve (pool math never
        // sees the counter's tokens; a counter-only side reads as genuinely
        // empty, so the LP can still withdraw the other side).
        if token_a_amount == 0 && lp_a != 0 {
            return Err(SwapError::ZeroTradingTokens.into());
        }
        let token_b_amount = to_u64(results.token_b_amount)?;
        // X9: clamp against the LP-owned reserve.
        let token_b_amount = std::cmp::min(lp_b, token_b_amount);
        if token_b_amount < minimum_token_b_amount {
            return Err(SwapError::ExceededSlippage.into());
        }
        // X10: zero-guard reads the LP-owned reserve.
        if token_b_amount == 0 && lp_b != 0 {
            return Err(SwapError::ZeroTradingTokens.into());
        }

        Self::token_burn(
            swap_info.key,
            pool_token_program_info.clone(),
            source_info.clone(),
            pool_mint_info.clone(),
            user_transfer_authority_info.clone(),
            token_swap.bump_seed(),
            to_u64(pool_token_amount)?,
        )?;

        if token_a_amount > 0 {
            Self::token_transfer(
                swap_info.key,
                token_a_program_info.clone(),
                token_a_info.clone(),
                token_a_mint_info.clone(),
                dest_token_a_info.clone(),
                authority_info.clone(),
                token_swap.bump_seed(),
                token_a_amount,
                Self::unpack_mint(token_a_mint_info, token_swap.token_program_id())?.decimals,
            )?;
        }
        if token_b_amount > 0 {
            Self::token_transfer(
                swap_info.key,
                token_b_program_info.clone(),
                token_b_info.clone(),
                token_b_mint_info.clone(),
                dest_token_b_info.clone(),
                authority_info.clone(),
                token_swap.bump_seed(),
                token_b_amount,
                Self::unpack_mint(token_b_mint_info, token_swap.token_program_id())?.decimals,
            )?;
        }
        Ok(())
    }

    /// Processes DepositSingleTokenTypeExactAmountIn
    pub fn process_deposit_single_token_type_exact_amount_in(
        program_id: &Pubkey,
        source_token_amount: u64,
        minimum_pool_token_amount: u64,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let swap_info = next_account_info(account_info_iter)?;
        let authority_info = next_account_info(account_info_iter)?;
        let user_transfer_authority_info = next_account_info(account_info_iter)?;
        let source_info = next_account_info(account_info_iter)?;
        let swap_token_a_info = next_account_info(account_info_iter)?;
        let swap_token_b_info = next_account_info(account_info_iter)?;
        let pool_mint_info = next_account_info(account_info_iter)?;
        let destination_info = next_account_info(account_info_iter)?;
        let source_token_mint_info = next_account_info(account_info_iter)?;
        let source_token_program_info = next_account_info(account_info_iter)?;
        let pool_token_program_info = next_account_info(account_info_iter)?;

        let token_swap = SwapVersion::unpack(&swap_info.data.borrow())?;
        let calculator = &token_swap.swap_curve().calculator;
        if !calculator.allows_deposits() {
            return Err(SwapError::UnsupportedCurveOperation.into());
        }
        let source_account =
            Self::unpack_token_account(source_info, token_swap.token_program_id())?;
        let swap_token_a =
            Self::unpack_token_account(swap_token_a_info, token_swap.token_program_id())?;
        let swap_token_b =
            Self::unpack_token_account(swap_token_b_info, token_swap.token_program_id())?;

        let trade_direction = if source_account.mint == swap_token_a.mint {
            TradeDirection::AtoB
        } else if source_account.mint == swap_token_b.mint {
            TradeDirection::BtoA
        } else {
            return Err(SwapError::IncorrectSwapAccount.into());
        };

        let (source_a_info, source_b_info) = match trade_direction {
            TradeDirection::AtoB => (Some(source_info), None),
            TradeDirection::BtoA => (None, Some(source_info)),
        };

        Self::check_accounts(
            token_swap.as_ref(),
            program_id,
            swap_info,
            authority_info,
            swap_token_a_info,
            swap_token_b_info,
            pool_mint_info,
            pool_token_program_info,
            source_a_info,
            source_b_info,
        )?;

        let pool_mint = Self::unpack_mint(pool_mint_info, token_swap.token_program_id())?;
        let pool_mint_supply = u128::from(pool_mint.supply);
        // Reserve exclusion X11: LP minted is computed from LP-owned reserves.
        let lp_a = Self::lp_owned(swap_token_a.amount, token_swap.protocol_fees_a())?;
        let lp_b = Self::lp_owned(swap_token_b.amount, token_swap.protocol_fees_b())?;
        let pool_token_amount = if pool_mint_supply > 0 {
            token_swap
                .swap_curve()
                .deposit_single_token_type(
                    u128::from(source_token_amount),
                    u128::from(lp_a),
                    u128::from(lp_b),
                    pool_mint_supply,
                    trade_direction,
                    token_swap.fees(),
                )
                .ok_or(SwapError::ZeroTradingTokens)?
        } else {
            calculator.new_pool_supply()
        };

        let pool_token_amount = to_u64(pool_token_amount)?;
        if pool_token_amount < minimum_pool_token_amount {
            return Err(SwapError::ExceededSlippage.into());
        }
        if pool_token_amount == 0 {
            return Err(SwapError::ZeroTradingTokens.into());
        }

        match trade_direction {
            TradeDirection::AtoB => {
                Self::token_transfer(
                    swap_info.key,
                    source_token_program_info.clone(),
                    source_info.clone(),
                    source_token_mint_info.clone(),
                    swap_token_a_info.clone(),
                    user_transfer_authority_info.clone(),
                    token_swap.bump_seed(),
                    source_token_amount,
                    Self::unpack_mint(source_token_mint_info, token_swap.token_program_id())?
                        .decimals,
                )?;
            }
            TradeDirection::BtoA => {
                Self::token_transfer(
                    swap_info.key,
                    source_token_program_info.clone(),
                    source_info.clone(),
                    source_token_mint_info.clone(),
                    swap_token_b_info.clone(),
                    user_transfer_authority_info.clone(),
                    token_swap.bump_seed(),
                    source_token_amount,
                    Self::unpack_mint(source_token_mint_info, token_swap.token_program_id())?
                        .decimals,
                )?;
            }
        }
        Self::token_mint_to(
            swap_info.key,
            pool_token_program_info.clone(),
            pool_mint_info.clone(),
            destination_info.clone(),
            authority_info.clone(),
            token_swap.bump_seed(),
            pool_token_amount,
        )?;

        Ok(())
    }

    /// Processes a
    /// [WithdrawSingleTokenTypeExactAmountOut](enum.Instruction.html).
    pub fn process_withdraw_single_token_type_exact_amount_out(
        program_id: &Pubkey,
        destination_token_amount: u64,
        maximum_pool_token_amount: u64,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
        let swap_info = next_account_info(account_info_iter)?;
        let authority_info = next_account_info(account_info_iter)?;
        let user_transfer_authority_info = next_account_info(account_info_iter)?;
        let pool_mint_info = next_account_info(account_info_iter)?;
        let source_info = next_account_info(account_info_iter)?;
        let swap_token_a_info = next_account_info(account_info_iter)?;
        let swap_token_b_info = next_account_info(account_info_iter)?;
        let destination_info = next_account_info(account_info_iter)?;
        let destination_token_mint_info = next_account_info(account_info_iter)?;
        let pool_token_program_info = next_account_info(account_info_iter)?;
        let destination_token_program_info = next_account_info(account_info_iter)?;

        let token_swap = SwapVersion::unpack(&swap_info.data.borrow())?;
        let destination_account =
            Self::unpack_token_account(destination_info, token_swap.token_program_id())?;
        let swap_token_a =
            Self::unpack_token_account(swap_token_a_info, token_swap.token_program_id())?;
        let swap_token_b =
            Self::unpack_token_account(swap_token_b_info, token_swap.token_program_id())?;

        let trade_direction = if destination_account.mint == swap_token_a.mint {
            TradeDirection::AtoB
        } else if destination_account.mint == swap_token_b.mint {
            TradeDirection::BtoA
        } else {
            return Err(SwapError::IncorrectSwapAccount.into());
        };

        let (destination_a_info, destination_b_info) = match trade_direction {
            TradeDirection::AtoB => (Some(destination_info), None),
            TradeDirection::BtoA => (None, Some(destination_info)),
        };
        Self::check_accounts(
            token_swap.as_ref(),
            program_id,
            swap_info,
            authority_info,
            swap_token_a_info,
            swap_token_b_info,
            pool_mint_info,
            pool_token_program_info,
            destination_a_info,
            destination_b_info,
        )?;

        let pool_mint = Self::unpack_mint(pool_mint_info, token_swap.token_program_id())?;
        let pool_mint_supply = u128::from(pool_mint.supply);
        // Reserve exclusion X12: LP burned is computed from LP-owned reserves.
        let lp_a = u128::from(Self::lp_owned(swap_token_a.amount, token_swap.protocol_fees_a())?);
        let lp_b = u128::from(Self::lp_owned(swap_token_b.amount, token_swap.protocol_fees_b())?);

        // Fund-drain / pool-brick fix: mirror withdraw_all's X7/X9 clamp.
        // Without this, the curve's `withdraw_single_token_type_exact_out`
        // silently saturates to `Some(pool_supply)` instead of `None` once
        // the requested exact-out reaches the withdrawn side's LP-owned
        // reserve (its `checked_sub` underflow falls back to 0 via
        // `unwrap_or_else`) — a full-supply LP holder could then request
        // an exact-out between the LP-owned reserve and the raw vault,
        // burn their whole position, and walk away funded by the
        // counter-owned protocol fees, bricking `lp_owned` on that side.
        // Clamp against the side the tokens actually LEAVE (the transfer
        // below is keyed on the same `trade_direction`), not the other side.
        let lp_out = match trade_direction {
            TradeDirection::AtoB => lp_a,
            TradeDirection::BtoA => lp_b,
        };
        if u128::from(destination_token_amount) > lp_out {
            return Err(SwapError::ExceededLpReserve.into());
        }

        // D9: the withdraw-fee LP-mint machinery is deleted (production
        // pins owner_withdraw_fee to 0/0 — it shipped dead); burn = the
        // curve-computed amount, no fee add.
        let pool_token_amount = token_swap
            .swap_curve()
            .withdraw_single_token_type_exact_out(
                u128::from(destination_token_amount),
                lp_a,
                lp_b,
                pool_mint_supply,
                trade_direction,
                token_swap.fees(),
            )
            .ok_or(SwapError::ZeroTradingTokens)?;

        if to_u64(pool_token_amount)? > maximum_pool_token_amount {
            return Err(SwapError::ExceededSlippage.into());
        }
        if pool_token_amount == 0 {
            return Err(SwapError::ZeroTradingTokens.into());
        }

        Self::token_burn(
            swap_info.key,
            pool_token_program_info.clone(),
            source_info.clone(),
            pool_mint_info.clone(),
            user_transfer_authority_info.clone(),
            token_swap.bump_seed(),
            to_u64(pool_token_amount)?,
        )?;

        match trade_direction {
            TradeDirection::AtoB => {
                Self::token_transfer(
                    swap_info.key,
                    destination_token_program_info.clone(),
                    swap_token_a_info.clone(),
                    destination_token_mint_info.clone(),
                    destination_info.clone(),
                    authority_info.clone(),
                    token_swap.bump_seed(),
                    destination_token_amount,
                    Self::unpack_mint(destination_token_mint_info, token_swap.token_program_id())?
                        .decimals,
                )?;
            }
            TradeDirection::BtoA => {
                Self::token_transfer(
                    swap_info.key,
                    destination_token_program_info.clone(),
                    swap_token_b_info.clone(),
                    destination_token_mint_info.clone(),
                    destination_info.clone(),
                    authority_info.clone(),
                    token_swap.bump_seed(),
                    destination_token_amount,
                    Self::unpack_mint(destination_token_mint_info, token_swap.token_program_id())?
                        .decimals,
                )?;
            }
        }

        Ok(())
    }

    /// Processes an [Instruction](enum.Instruction.html).
    pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], input: &[u8]) -> ProgramResult {
        Self::process_with_constraints(program_id, accounts, input, &SWAP_CONSTRAINTS)
    }

    /// Processes an instruction given extra constraint
    pub fn process_with_constraints(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        input: &[u8],
        swap_constraints: &Option<SwapConstraints>,
    ) -> ProgramResult {
        let instruction = SwapInstruction::unpack(input)?;
        match instruction {
            SwapInstruction::Initialize => {
                msg!("Instruction: Init (retired)");
                Err(SwapError::InstructionRetired.into())
            }
            SwapInstruction::Swap(Swap {
                amount_in,
                minimum_amount_out,
            }) => {
                msg!("Instruction: Swap");
                Self::process_swap(program_id, amount_in, minimum_amount_out, accounts)
            }
            SwapInstruction::DepositAllTokenTypes(DepositAllTokenTypes {
                pool_token_amount,
                maximum_token_a_amount,
                maximum_token_b_amount,
            }) => {
                msg!("Instruction: DepositAllTokenTypes");
                Self::process_deposit_all_token_types(
                    program_id,
                    pool_token_amount,
                    maximum_token_a_amount,
                    maximum_token_b_amount,
                    accounts,
                )
            }
            SwapInstruction::WithdrawAllTokenTypes(WithdrawAllTokenTypes {
                pool_token_amount,
                minimum_token_a_amount,
                minimum_token_b_amount,
            }) => {
                msg!("Instruction: WithdrawAllTokenTypes");
                Self::process_withdraw_all_token_types(
                    program_id,
                    pool_token_amount,
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                    accounts,
                )
            }
            SwapInstruction::DepositSingleTokenTypeExactAmountIn(
                DepositSingleTokenTypeExactAmountIn {
                    source_token_amount,
                    minimum_pool_token_amount,
                },
            ) => {
                msg!("Instruction: DepositSingleTokenTypeExactAmountIn");
                Self::process_deposit_single_token_type_exact_amount_in(
                    program_id,
                    source_token_amount,
                    minimum_pool_token_amount,
                    accounts,
                )
            }
            SwapInstruction::WithdrawSingleTokenTypeExactAmountOut(
                WithdrawSingleTokenTypeExactAmountOut {
                    destination_token_amount,
                    maximum_pool_token_amount,
                },
            ) => {
                msg!("Instruction: WithdrawSingleTokenTypeExactAmountOut");
                Self::process_withdraw_single_token_type_exact_amount_out(
                    program_id,
                    destination_token_amount,
                    maximum_pool_token_amount,
                    accounts,
                )
            }
            SwapInstruction::SwapExactOut(SwapExactOut {
                amount_out,
                maximum_amount_in,
            }) => {
                msg!("Instruction: SwapExactOut");
                Self::process_swap_exact_out(program_id, amount_out, maximum_amount_in, accounts)
            }
            SwapInstruction::CreatePool(CreatePool {
                fees,
                swap_curve,
                fee_bps,
                pool_bump,
                lp_bump,
            }) => {
                msg!("Instruction: CreatePool");
                Self::process_create_pool(
                    program_id,
                    fees,
                    swap_curve,
                    fee_bps,
                    pool_bump,
                    lp_bump,
                    accounts,
                    swap_constraints,
                )
            }
            SwapInstruction::InitializeConfig(InitializeConfig {
                admin,
                treasury,
                mode,
            }) => {
                msg!("Instruction: InitializeConfig");
                Self::process_initialize_config(program_id, admin, treasury, mode, accounts)
            }
            SwapInstruction::SetTreasury(SetTreasury { treasury }) => {
                msg!("Instruction: SetTreasury");
                Self::process_set_treasury(program_id, treasury, accounts)
            }
            SwapInstruction::TransferAdmin(TransferAdmin { pending_admin }) => {
                msg!("Instruction: TransferAdmin");
                Self::process_transfer_admin(program_id, pending_admin, accounts)
            }
            SwapInstruction::AcceptAdmin => {
                msg!("Instruction: AcceptAdmin");
                Self::process_accept_admin(program_id, accounts)
            }
            SwapInstruction::CollectProtocolFees => {
                msg!("Instruction: CollectProtocolFees");
                Self::process_collect_protocol_fees(program_id, accounts)
            }
            SwapInstruction::SetPoolCreation(SetPoolCreation { mode }) => {
                msg!("Instruction: SetPoolCreation");
                Self::process_set_pool_creation(program_id, mode, accounts)
            }
        }
    }
}

fn to_u64(val: u128) -> Result<u64, SwapError> {
    val.try_into().map_err(|_| SwapError::ConversionFailure)
}

fn invoke_signed_wrapper<T>(
    instruction: &Instruction,
    account_infos: &[AccountInfo],
    signers_seeds: &[&[&[u8]]],
) -> Result<(), ProgramError>
where
    T: 'static + PrintProgramError + DecodeError<T> + FromPrimitive + Error,
{
    invoke_signed(instruction, account_infos, signers_seeds).inspect_err(|err| {
        err.print::<T>();
    })
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{
            curve::{
                base::CurveType,
                calculator::{CurveCalculator, INITIAL_SWAP_POOL_AMOUNT},
                constant_price::ConstantPriceCurve,
                constant_product::ConstantProductCurve,
                offset::OffsetCurve,
            },
            config::MODE_ADMIN_ONLY,
            instruction::{
                accept_admin, collect_protocol_fees, deposit_all_token_types,
                deposit_single_token_type_exact_amount_in, initialize_config, set_pool_creation,
                set_treasury, swap, swap_exact_out, transfer_admin, withdraw_all_token_types,
                withdraw_single_token_type_exact_amount_out,
            },
        },
        solana_program::{
            clock::Clock, entrypoint::SUCCESS,
            instruction::{AccountMeta, Instruction},
            program_pack::Pack, program_stubs, rent::Rent, system_program,
        },
        solana_sdk::account::{
            create_account_for_test, create_is_signer_account_infos, Account as SolanaAccount,
        },
        spl_token_2022::{
            error::TokenError,
            extension::{
                transfer_fee::{instruction::initialize_transfer_fee_config, TransferFee},
                ExtensionType,
            },
            instruction::{
                approve, freeze_account, initialize_account,
                initialize_immutable_owner, initialize_mint, initialize_mint_close_authority,
                mint_to, set_authority, AuthorityType,
            },
        },
        std::{cell::RefCell, sync::Arc},
        test_case::test_case,
    };

    // Test program id for the swap program.
    const SWAP_PROGRAM_ID: Pubkey = Pubkey::new_from_array([2u8; 32]);

    // The pubkeys of the CURRENT outer (top-level) instruction's accounts —
    // the rule the runtime actually enforces for `invoke`/`invoke_signed`
    // ("the invoked program must be present in the outer transaction"),
    // replacing the old "some account_info looks like a token program"
    // mimic check (see the design plan). Populated by
    // `do_process_instruction_with_fee_constraints` before dispatch. Tests
    // run one-per-thread (no #[tokio::test] / thread pool here), so there is
    // no cross-test leakage; a direct `invoke_signed` call with no outer
    // context (e.g. `test_token_program_id_error`) sees an empty set and is
    // refused, exactly like today.
    std::thread_local! {
        static OUTER_ACCOUNT_KEYS: RefCell<Vec<Pubkey>> = RefCell::new(Vec::new());
    }

    /// Host-side mimic of `SystemInstruction::CreateAccount` — the only system
    /// instruction anything in this repo invokes (fail loud if that changes).
    /// Manual parse, no bincode dep: `[u32 LE tag==0][u64 LE lamports][u64 LE
    /// space][32B owner]`. The one line of real divergence from the on-chain
    /// system program: "allocate(space)" becomes "assert pre-sized(space)" —
    /// a host `AccountInfo` can't realloc, so the harness must hand a shell of
    /// exactly the requested size (the pre-sizing contract).
    fn test_system_create_account(data: &[u8], accounts: &[AccountInfo]) -> ProgramResult {
        if accounts.len() != 2 {
            return Err(ProgramError::InvalidInstructionData);
        }
        if data.len() != 52 || u32::from_le_bytes(data[0..4].try_into().unwrap()) != 0 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let lamports = u64::from_le_bytes(data[4..12].try_into().unwrap());
        let space = u64::from_le_bytes(data[12..20].try_into().unwrap());
        let owner = Pubkey::new_from_array(data[20..52].try_into().unwrap());

        let funder = &accounts[0];
        let new = &accounts[1];

        // Fidelity-only: unreachable through CreatePool today (the program
        // checks the payer's signature at :435-437 before any CPI, and `new`
        // is always seed-marked signer by the loop below) — kept for
        // system-program fidelity. No mutant claims this line; see
        // the design plan ("honest non-mutants").
        if !funder.is_signer || !new.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // The stub cannot silently "re-create" a live account: refuse if it
        // isn't a fresh, unowned, zero-lamport shell (M4 in
        // the design plan).
        if *new.owner != system_program::id() || new.lamports() != 0 {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        // The pre-sizing contract itself: any mismatch is refused, never
        // papered over.
        if new.data_len() != space as usize {
            return Err(ProgramError::AccountDataTooSmall);
        }
        // No conjured lamports.
        if funder.lamports() < lamports {
            return Err(ProgramError::InsufficientFunds);
        }

        **funder.try_borrow_mut_lamports()? -= lamports;
        **new.try_borrow_mut_lamports()? += lamports;
        new.assign(&owner);
        Ok(())
    }

    /// Host-side mimic of `SystemInstruction::Transfer`:
    /// the grief-proof creation helper's lamport top-up step). 12-byte data:
    /// `[u32 LE tag==2][u64 LE lamports]`.
    fn test_system_transfer(data: &[u8], accounts: &[AccountInfo]) -> ProgramResult {
        if accounts.len() != 2 || data.len() != 12 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let amount = u64::from_le_bytes(data[4..12].try_into().unwrap());
        let from = &accounts[0];
        let to = &accounts[1];
        // M target: skip this and `test_stub_transfer_requires_signer`
        // reddens.
        if !from.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *from.owner != system_program::id() || from.data_len() != 0 {
            return Err(ProgramError::InvalidAccountData);
        }
        if from.lamports() < amount {
            return Err(ProgramError::InsufficientFunds);
        }
        **from.try_borrow_mut_lamports()? -= amount;
        **to.try_borrow_mut_lamports()? += amount;
        Ok(())
    }

    /// Host-side mimic of `SystemInstruction::Allocate`. 12-byte
    /// data: `[u32 LE tag==8][u64 LE space]`. Host contract: `data_len() ==
    /// space` (a host `AccountInfo` can't realloc — same pre-sizing
    /// divergence as `test_system_create_account`'s).
    fn test_system_allocate(data: &[u8], accounts: &[AccountInfo]) -> ProgramResult {
        if accounts.len() != 1 || data.len() != 12 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let space = u64::from_le_bytes(data[4..12].try_into().unwrap());
        let account = &accounts[0];
        if !account.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        // Same "already spoken for" vocabulary `test_system_create_account`
        // uses for the analogous condition — a target not system-owned can
        // never be freshly allocated into, on the host mimic or on-chain.
        if *account.owner != system_program::id() {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        // M target: skip this and the pre-funded-grief test's sizing
        // arm reddens.
        if account.data_len() != space as usize {
            return Err(ProgramError::AccountDataTooSmall);
        }
        Ok(())
    }

    /// Host-side mimic of `SystemInstruction::Assign`. 36-byte
    /// data: `[u32 LE tag==1][32B owner]`.
    fn test_system_assign(data: &[u8], accounts: &[AccountInfo]) -> ProgramResult {
        if accounts.len() != 1 || data.len() != 36 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let owner = Pubkey::new_from_array(data[4..36].try_into().unwrap());
        let account = &accounts[0];
        if !account.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if *account.owner != system_program::id() {
            return Err(ProgramError::InvalidAccountData);
        }
        account.assign(&owner);
        Ok(())
    }

    /// Dispatches on the u32 LE discriminant to the system instructions this
    /// crate actually invokes (CreateAccount pre-v2; Transfer/Allocate/
    /// Assign added by the grief-proof creation). Anything else fails
    /// loud — fidelity over completeness; extending the set this crate
    /// invokes must extend this dispatcher deliberately, never fall through.
    fn test_system_instruction(data: &[u8], accounts: &[AccountInfo]) -> ProgramResult {
        if data.len() < 4 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let tag = u32::from_le_bytes(data[0..4].try_into().unwrap());
        match tag {
            0 => test_system_create_account(data, accounts),
            1 => test_system_assign(data, accounts),
            2 => test_system_transfer(data, accounts),
            8 => test_system_allocate(data, accounts),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }

    struct TestSyscallStubs {}
    impl program_stubs::SyscallStubs for TestSyscallStubs {
        fn sol_invoke_signed(
            &self,
            instruction: &Instruction,
            account_infos: &[AccountInfo],
            signers_seeds: &[&[&[u8]]],
        ) -> ProgramResult {
            msg!("TestSyscallStubs::sol_invoke_signed()");

            // The rule the runtime actually enforces: the invoked program
            // must be among the accounts of the OUTER instruction. This
            // deliberately REPLACES the old token-presence mimic check,
            // which was stricter than the runtime — it refused a call shape
            // (a minimal-slice token CPI with no token-program account in
            // ITS OWN slice, resolved instead from the transaction) that the
            // deployed program executes daily. A direct `invoke_signed` with
            // no outer context still fails here, same error code as before.
            if !OUTER_ACCOUNT_KEYS.with(|k| k.borrow().contains(&instruction.program_id)) {
                return Err(ProgramError::InvalidAccountData);
            }

            let mut new_account_infos = vec![];
            for meta in instruction.accounts.iter() {
                for account_info in account_infos.iter() {
                    if meta.pubkey == *account_info.key {
                        let mut new_account_info = account_info.clone();
                        for seeds in signers_seeds.iter() {
                            let signer =
                                Pubkey::create_program_address(seeds, &SWAP_PROGRAM_ID).unwrap();
                            if *account_info.key == signer {
                                new_account_info.is_signer = true;
                            }
                        }
                        new_account_infos.push(new_account_info);
                    }
                }
            }

            if instruction.program_id == system_program::id() {
                test_system_instruction(&instruction.data, &new_account_infos)
            } else if instruction.program_id == spl_token::id() {
                spl_token::processor::Processor::process(
                    &instruction.program_id,
                    &new_account_infos,
                    &instruction.data,
                )
            } else if instruction.program_id == spl_token_2022::id() {
                spl_token_2022::processor::Processor::process(
                    &instruction.program_id,
                    &new_account_infos,
                    &instruction.data,
                )
            } else {
                Err(ProgramError::IncorrectProgramId)
            }
        }

        fn sol_get_clock_sysvar(&self, var_addr: *mut u8) -> u64 {
            unsafe {
                *(var_addr as *mut _ as *mut Clock) = Clock::default();
            }
            SUCCESS
        }

        // `Rent::default()` (NOT `Rent::free()`) is mandatory: the existing
        // balance helpers (`mint_minimum_balance`/`account_minimum_balance`)
        // already assume it, and a zero rent would make the skip-lamport-
        // transfer mutant undetectable (spl-token's rent-exemption check
        // would pass on 0 lamports either way). Tests that read the rent
        // SYSVAR ACCOUNT directly (`create_account_for_test(&Rent::free())`)
        // are unaffected — this stub only answers the SYSCALL.
        fn sol_get_rent_sysvar(&self, var_addr: *mut u8) -> u64 {
            unsafe {
                *(var_addr as *mut _ as *mut Rent) = Rent::default();
            }
            SUCCESS
        }
    }

    fn test_syscall_stubs() {
        use std::sync::Once;
        static ONCE: Once = Once::new();

        ONCE.call_once(|| {
            program_stubs::set_syscall_stubs(Box::new(TestSyscallStubs {}));
        });
    }

    /// Fixture for `InitializeConfig`'s adversarial surface — a
    /// fabricated 45-byte ProgramData shell at the loader-derived address
    /// (flag=1, authority=`upgrade_authority_key`) plus a system-owned,
    /// zero-lamport config shell pre-sized to `ProtocolConfig::LEN`.
    /// `init_config` runs the REAL tag-8 instruction through
    /// `do_process_instruction` (tests use the deployed path, not hand-
    /// packed state) — every consumer that needs a live config calls this.
    struct ConfigFixture {
        upgrade_authority_key: Pubkey,
        upgrade_authority_account: SolanaAccount,
        config_key: Pubkey,
        config_account: SolanaAccount,
        programdata_key: Pubkey,
        programdata_account: SolanaAccount,
    }

    impl ConfigFixture {
        fn new() -> Self {
            let upgrade_authority_key = Pubkey::new_unique();
            let upgrade_authority_account = SolanaAccount::new(0, 0, &system_program::id());

            let (config_key, _bump) =
                Pubkey::find_program_address(&[b"config"], &SWAP_PROGRAM_ID);
            let config_account =
                SolanaAccount::new(0, ProtocolConfig::LEN, &system_program::id());

            let (programdata_key, _bump) = Pubkey::find_program_address(
                &[SWAP_PROGRAM_ID.as_ref()],
                &bpf_loader_upgradeable::id(),
            );
            let mut programdata_account =
                SolanaAccount::new(1, 45, &bpf_loader_upgradeable::id());
            programdata_account.data[0..4].copy_from_slice(&3u32.to_le_bytes()); // ProgramData
            programdata_account.data[12] = 1; // Some(authority)
            programdata_account.data[13..45].copy_from_slice(upgrade_authority_key.as_ref());

            ConfigFixture {
                upgrade_authority_key,
                upgrade_authority_account,
                config_key,
                config_account,
                programdata_key,
                programdata_account,
            }
        }

        /// Runs the real tag-8 `InitializeConfig` through
        /// `do_process_instruction`.
        fn init_config(
            &mut self,
            payer_key: &Pubkey,
            payer_account: &mut SolanaAccount,
            admin: Pubkey,
            treasury: Pubkey,
            mode: u8,
        ) -> ProgramResult {
            let ix = initialize_config(
                &SWAP_PROGRAM_ID,
                payer_key,
                &self.upgrade_authority_key,
                &self.config_key,
                &self.programdata_key,
                InitializeConfig {
                    admin,
                    treasury,
                    mode,
                },
            )
            .unwrap();
            let mut system_program_dummy = SolanaAccount::default();
            do_process_instruction(
                ix,
                vec![
                    payer_account,
                    &mut self.upgrade_authority_account,
                    &mut self.config_account,
                    &mut self.programdata_account,
                    &mut system_program_dummy,
                ],
            )
        }
    }

    #[derive(Default)]
    struct SwapTransferFees {
        pool_token: TransferFee,
        token_a: TransferFee,
        token_b: TransferFee,
    }

    struct SwapAccountInfo {
        bump_seed: u8,
        authority_key: Pubkey,
        fees: Fees,
        transfer_fees: SwapTransferFees,
        swap_curve: SwapCurve,
        swap_key: Pubkey,
        swap_account: SolanaAccount,
        pool_mint_key: Pubkey,
        pool_mint_account: SolanaAccount,
        pool_token_key: Pubkey,
        pool_token_account: SolanaAccount,
        token_a_key: Pubkey,
        token_a_account: SolanaAccount,
        token_a_mint_key: Pubkey,
        token_a_mint_account: SolanaAccount,
        token_b_key: Pubkey,
        token_b_account: SolanaAccount,
        token_b_mint_key: Pubkey,
        token_b_mint_account: SolanaAccount,
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
        // v2 (tag-7 CreatePool) fields — see `new`/`initialize_swap` below.
        fee_bps: u16,
        pool_bump: u8,
        lp_bump: u8,
        payer_key: Pubkey,
        payer_account: SolanaAccount,
        // Every SwapAccountInfo carries a REAL, already-
        // initialized config (mode 1 = permissionless) so all pre-v2
        // tests keep today's behavior with no other change.
        config_key: Pubkey,
        config_account: SolanaAccount,
        admin_key: Pubkey,
        treasury_key: Pubkey,
    }

    impl SwapAccountInfo {
        /// v2-native: derives the real CreatePool (tag 7) PDAs + shells.
        #[allow(clippy::too_many_arguments)]
        pub fn new(
            user_key: &Pubkey,
            fees: Fees,
            transfer_fees: SwapTransferFees,
            swap_curve: SwapCurve,
            token_a_amount: u64,
            token_b_amount: u64,
            pool_token_program_id: &Pubkey,
            token_a_program_id: &Pubkey,
            token_b_program_id: &Pubkey,
        ) -> Self {
            let (token_a_mint_key, mut token_a_mint_account) =
                create_mint(token_a_program_id, user_key, None, None, &transfer_fees.token_a);
            let (token_b_mint_key, mut token_b_mint_account) =
                create_mint(token_b_program_id, user_key, None, None, &transfer_fees.token_b);

            // fee_bps is UNBOUND at HEAD (processor.rs `:444-451` uses it
            // only for PDA-seed derivation, never validated against `fees`)
            // — this formula already satisfies Phase 2 item 8's eventual
            // bind for 10000-denominated fixtures. 0-denominator terms
            // contribute 0.
            let trade_term = if fees.trade_fee_denominator == 0 {
                0
            } else {
                fees.trade_fee_numerator * 10000 / fees.trade_fee_denominator
            };
            let owner_term = if fees.owner_trade_fee_denominator == 0 {
                0
            } else {
                fees.owner_trade_fee_numerator * 10000 / fees.owner_trade_fee_denominator
            };
            let fee_bps = (trade_term + owner_term) as u16;

            let (swap_key, pool_bump) = Pubkey::find_program_address(
                &[
                    b"cp_pool",
                    token_a_mint_key.as_ref(),
                    token_b_mint_key.as_ref(),
                    &fee_bps.to_le_bytes(),
                ],
                &SWAP_PROGRAM_ID,
            );
            // Same derivation Swap/Deposit/Withdraw use ([pool]) — field
            // semantics unchanged from v1.
            let (authority_key, bump_seed) =
                Pubkey::find_program_address(&[&swap_key.to_bytes()[..]], &SWAP_PROGRAM_ID);
            let (pool_mint_key, lp_bump) =
                Pubkey::find_program_address(&[b"cp_lp", swap_key.as_ref()], &SWAP_PROGRAM_ID);
            let (pool_token_key, _dest_bump) =
                Pubkey::find_program_address(&[b"cp_dest", swap_key.as_ref()], &SWAP_PROGRAM_ID);

            // Shells per the pre-sizing contract: system-owned, 0
            // lamports, zero-filled at the EXACT size the program will
            // request — sizes read from the program's own space constants,
            // never hardcoded numbers. NOTE the owner change on the pool
            // shell: v1 pre-owned it (`&SWAP_PROGRAM_ID`); v2 must be
            // system-owned so the CreatePool branch's already-initialized
            // refusal doesn't trip on the fixture's own setup.
            let swap_account = SolanaAccount::new(0, SwapVersion::LATEST_LEN, &system_program::id());
            let pool_mint_account = SolanaAccount::new(0, Mint::LEN, &system_program::id());
            let pool_token_account = SolanaAccount::new(0, Account::LEN, &system_program::id());

            // Vaults: caller-funded, owned by the pool authority — identical
            // to v1 (CreatePool takes caller-funded vaults, same as Initialize).
            let (token_a_key, token_a_account) = mint_token(
                token_a_program_id,
                &token_a_mint_key,
                &mut token_a_mint_account,
                user_key,
                &authority_key,
                token_a_amount,
            );
            let (token_b_key, token_b_account) = mint_token(
                token_b_program_id,
                &token_b_mint_key,
                &mut token_b_mint_account,
                user_key,
                &authority_key,
                token_b_amount,
            );

            // cp_dest's owner is the PAYER (processor.rs `:527`) — payer ==
            // user_key, so the initial-LP-owner semantics every existing
            // test relies on (user_key holds the destination) are preserved.
            let payer_key = *user_key;
            let mut payer_account = SolanaAccount::new(10_000_000_000, 0, &system_program::id());

            let admin_key = Pubkey::new_unique();
            let treasury_key = Pubkey::new_unique();
            let mut config_fixture = ConfigFixture::new();
            config_fixture
                .init_config(
                    &payer_key,
                    &mut payer_account,
                    admin_key,
                    treasury_key,
                    MODE_PERMISSIONLESS,
                )
                .unwrap();
            let config_key = config_fixture.config_key;
            let config_account = config_fixture.config_account;

            SwapAccountInfo {
                bump_seed,
                authority_key,
                fees,
                transfer_fees,
                swap_curve,
                swap_key,
                swap_account,
                pool_mint_key,
                pool_mint_account,
                pool_token_key,
                pool_token_account,
                token_a_key,
                token_a_account,
                token_a_mint_key,
                token_a_mint_account,
                token_b_key,
                token_b_account,
                token_b_mint_key,
                token_b_mint_account,
                pool_token_program_id: *pool_token_program_id,
                token_a_program_id: *token_a_program_id,
                token_b_program_id: *token_b_program_id,
                fee_bps,
                pool_bump,
                lp_bump,
                payer_key,
                payer_account,
                config_key,
                config_account,
                admin_key,
                treasury_key,
            }
        }

        /// Routes through `&None` (not the compiled-in `SWAP_CONSTRAINTS`) —
        /// Constraints are consumed only at creation, so passing
        /// the set explicitly makes the whole behavior suite lane-independent.
        /// In the default build `&None == &SWAP_CONSTRAINTS`, so the default
        /// lane is bit-for-bit the same as today. Signature preserved.
        pub fn initialize_swap(&mut self) -> ProgramResult {
            self.create_pool_with_constraints(&None)
        }

        // NOTE on the constraint-lane mutant target: this pass-through has
        // exactly one caller (`initialize_swap` → `&None`), so mutating THIS
        // method to ignore `swap_constraints` survives the suite — it is a
        // no-op today. The constraint lane's real teeth are in the free
        // `run_create_pool` helper, where R8/R9 inject a `Some(..)` set and
        // the pool-PDA fee-owner (#86) reddens when the constraint is applied
        // or ignored. Mutate there, not here.
        fn create_pool_with_constraints(
            &mut self,
            swap_constraints: &Option<SwapConstraints>,
        ) -> ProgramResult {
            let ix = create_pool_ix(
                &self.payer_key,
                &self.swap_key,
                &self.authority_key,
                &self.token_a_mint_key,
                &self.token_b_mint_key,
                &self.token_a_key,
                &self.token_b_key,
                &self.pool_mint_key,
                &self.pool_token_key,
                &self.pool_token_program_id,
                self.fee_bps,
                self.pool_bump,
                self.lp_bump,
                self.fees.clone(),
                self.swap_curve.clone(),
                &self.config_key,
            );
            let mut authority_dummy = SolanaAccount::default();
            let mut mint_a_dummy = self.token_a_mint_account.clone();
            let mut mint_b_dummy = self.token_b_mint_account.clone();
            let mut token_program_dummy = SolanaAccount::default();
            let mut system_program_dummy = SolanaAccount::default();
            do_process_instruction_with_fee_constraints(
                ix,
                vec![
                    &mut self.payer_account,
                    &mut self.swap_account,
                    &mut authority_dummy,
                    &mut mint_a_dummy,
                    &mut mint_b_dummy,
                    &mut self.token_a_account,
                    &mut self.token_b_account,
                    &mut self.pool_mint_account,
                    &mut self.pool_token_account,
                    &mut token_program_dummy,
                    &mut system_program_dummy,
                    &mut self.config_account,
                ],
                swap_constraints,
            )
        }

        pub fn setup_token_accounts(
            &mut self,
            mint_owner: &Pubkey,
            account_owner: &Pubkey,
            a_amount: u64,
            b_amount: u64,
            pool_amount: u64,
        ) -> (
            Pubkey,
            SolanaAccount,
            Pubkey,
            SolanaAccount,
            Pubkey,
            SolanaAccount,
        ) {
            let (token_a_key, token_a_account) = mint_token(
                &self.token_a_program_id,
                &self.token_a_mint_key,
                &mut self.token_a_mint_account,
                mint_owner,
                account_owner,
                a_amount,
            );
            let (token_b_key, token_b_account) = mint_token(
                &self.token_b_program_id,
                &self.token_b_mint_key,
                &mut self.token_b_mint_account,
                mint_owner,
                account_owner,
                b_amount,
            );
            // Under v2, the pool mint is a system-owned shell until
            // `initialize_swap()` runs; the five pre-init "swap not
            // initialized" negatives call this leg BEFORE that, and
            // `mint_token`'s `initialize_account` would panic against
            // `self.pool_mint_key` (not yet created). The returned account
            // still needs to be a REAL initialized token account, not an
            // inert zeroed shell — this test helper's own `withdraw_*`
            // methods `approve()` it via a real SPL CPI before ever
            // dispatching to the swap program, so a zeroed shell would fail
            // there instead of at the swap-state unpack the pre-init callers
            // actually assert on. Use a disposable throwaway mint instead of
            // the not-yet-existing pool mint — behavior-neutral for every
            // post-init caller.
            let (pool_key, pool_account) = if self.pool_mint_account.owner == system_program::id() {
                let (dummy_mint_key, mut dummy_mint_account) = create_mint(
                    &self.pool_token_program_id,
                    &self.authority_key,
                    None,
                    None,
                    &TransferFee::default(),
                );
                mint_token(
                    &self.pool_token_program_id,
                    &dummy_mint_key,
                    &mut dummy_mint_account,
                    &self.authority_key,
                    account_owner,
                    pool_amount,
                )
            } else {
                mint_token(
                    &self.pool_token_program_id,
                    &self.pool_mint_key,
                    &mut self.pool_mint_account,
                    &self.authority_key,
                    account_owner,
                    pool_amount,
                )
            };
            (
                token_a_key,
                token_a_account,
                token_b_key,
                token_b_account,
                pool_key,
                pool_account,
            )
        }

        fn get_swap_key(&self, mint_key: &Pubkey) -> &Pubkey {
            if *mint_key == self.token_a_mint_key {
                &self.token_a_key
            } else if *mint_key == self.token_b_mint_key {
                &self.token_b_key
            } else {
                panic!("Could not find matching swap token account");
            }
        }

        fn get_token_program_id(&self, account_key: &Pubkey) -> &Pubkey {
            if *account_key == self.token_a_key {
                &self.token_a_program_id
            } else if *account_key == self.token_b_key {
                &self.token_b_program_id
            } else {
                panic!("Could not find matching swap token account");
            }
        }

        fn get_token_mint(&self, account_key: &Pubkey) -> (Pubkey, SolanaAccount) {
            if *account_key == self.token_a_key {
                (self.token_a_mint_key, self.token_a_mint_account.clone())
            } else if *account_key == self.token_b_key {
                (self.token_b_mint_key, self.token_b_mint_account.clone())
            } else {
                panic!("Could not find matching swap token account");
            }
        }

        fn get_token_account(&self, account_key: &Pubkey) -> &SolanaAccount {
            if *account_key == self.token_a_key {
                &self.token_a_account
            } else if *account_key == self.token_b_key {
                &self.token_b_account
            } else {
                panic!("Could not find matching swap token account");
            }
        }

        fn set_token_account(&mut self, account_key: &Pubkey, account: SolanaAccount) {
            if *account_key == self.token_a_key {
                self.token_a_account = account;
                return;
            } else if *account_key == self.token_b_key {
                self.token_b_account = account;
                return;
            }
            panic!("Could not find matching swap token account");
        }

        #[allow(clippy::too_many_arguments)]
        pub fn swap(
            &mut self,
            user_key: &Pubkey,
            user_source_key: &Pubkey,
            user_source_account: &mut SolanaAccount,
            swap_source_key: &Pubkey,
            swap_destination_key: &Pubkey,
            user_destination_key: &Pubkey,
            user_destination_account: &mut SolanaAccount,
            amount_in: u64,
            minimum_amount_out: u64,
        ) -> ProgramResult {
            let user_transfer_key = Pubkey::new_unique();
            let source_token_program_id = self.get_token_program_id(swap_source_key);
            let destination_token_program_id = self.get_token_program_id(swap_destination_key);
            // approve moving from user source account
            do_process_instruction(
                approve(
                    source_token_program_id,
                    user_source_key,
                    &user_transfer_key,
                    user_key,
                    &[],
                    amount_in,
                )
                .unwrap(),
                vec![
                    user_source_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
            .unwrap();

            let (source_mint_key, mut source_mint_account) = self.get_token_mint(swap_source_key);
            let (destination_mint_key, mut destination_mint_account) =
                self.get_token_mint(swap_destination_key);
            let mut swap_source_account = self.get_token_account(swap_source_key).clone();
            let mut swap_destination_account = self.get_token_account(swap_destination_key).clone();

            // perform the swap
            do_process_instruction(
                swap(
                    &SWAP_PROGRAM_ID,
                    source_token_program_id,
                    destination_token_program_id,
                    &self.pool_token_program_id,
                    &self.swap_key,
                    &self.authority_key,
                    &user_transfer_key,
                    user_source_key,
                    swap_source_key,
                    swap_destination_key,
                    user_destination_key,
                    &self.pool_mint_key,
                    &source_mint_key,
                    &destination_mint_key,
                    Swap {
                        amount_in,
                        minimum_amount_out,
                    },
                )
                .unwrap(),
                vec![
                    &mut self.swap_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    user_source_account,
                    &mut swap_source_account,
                    &mut swap_destination_account,
                    user_destination_account,
                    &mut self.pool_mint_account,
                    &mut source_mint_account,
                    &mut destination_mint_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )?;

            self.set_token_account(swap_source_key, swap_source_account);
            self.set_token_account(swap_destination_key, swap_destination_account);

            Ok(())
        }

        #[allow(clippy::too_many_arguments)]
        pub fn swap_exact_out(
            &mut self,
            user_key: &Pubkey,
            user_source_key: &Pubkey,
            user_source_account: &mut SolanaAccount,
            swap_source_key: &Pubkey,
            swap_destination_key: &Pubkey,
            user_destination_key: &Pubkey,
            user_destination_account: &mut SolanaAccount,
            amount_out: u64,
            maximum_amount_in: u64,
        ) -> ProgramResult {
            let user_transfer_key = Pubkey::new_unique();
            let source_token_program_id = self.get_token_program_id(swap_source_key);
            let destination_token_program_id = self.get_token_program_id(swap_destination_key);
            // approve moving up to the maximum from user source account
            do_process_instruction(
                approve(
                    source_token_program_id,
                    user_source_key,
                    &user_transfer_key,
                    user_key,
                    &[],
                    maximum_amount_in,
                )
                .unwrap(),
                vec![
                    user_source_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
            .unwrap();

            let (source_mint_key, mut source_mint_account) = self.get_token_mint(swap_source_key);
            let (destination_mint_key, mut destination_mint_account) =
                self.get_token_mint(swap_destination_key);
            let mut swap_source_account = self.get_token_account(swap_source_key).clone();
            let mut swap_destination_account = self.get_token_account(swap_destination_key).clone();

            do_process_instruction(
                swap_exact_out(
                    &SWAP_PROGRAM_ID,
                    source_token_program_id,
                    destination_token_program_id,
                    &self.pool_token_program_id,
                    &self.swap_key,
                    &self.authority_key,
                    &user_transfer_key,
                    user_source_key,
                    swap_source_key,
                    swap_destination_key,
                    user_destination_key,
                    &self.pool_mint_key,
                    &source_mint_key,
                    &destination_mint_key,
                    SwapExactOut {
                        amount_out,
                        maximum_amount_in,
                    },
                )
                .unwrap(),
                vec![
                    &mut self.swap_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    user_source_account,
                    &mut swap_source_account,
                    &mut swap_destination_account,
                    user_destination_account,
                    &mut self.pool_mint_account,
                    &mut source_mint_account,
                    &mut destination_mint_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )?;

            self.set_token_account(swap_source_key, swap_source_account);
            self.set_token_account(swap_destination_key, swap_destination_account);

            Ok(())
        }

        #[allow(clippy::too_many_arguments)]
        pub fn deposit_all_token_types(
            &mut self,
            depositor_key: &Pubkey,
            depositor_token_a_key: &Pubkey,
            depositor_token_a_account: &mut SolanaAccount,
            depositor_token_b_key: &Pubkey,
            depositor_token_b_account: &mut SolanaAccount,
            depositor_pool_key: &Pubkey,
            depositor_pool_account: &mut SolanaAccount,
            pool_token_amount: u64,
            maximum_token_a_amount: u64,
            maximum_token_b_amount: u64,
        ) -> ProgramResult {
            let user_transfer_authority = Pubkey::new_unique();
            let token_a_program_id = depositor_token_a_account.owner;
            do_process_instruction(
                approve(
                    &token_a_program_id,
                    depositor_token_a_key,
                    &user_transfer_authority,
                    depositor_key,
                    &[],
                    maximum_token_a_amount,
                )
                .unwrap(),
                vec![
                    depositor_token_a_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
            .unwrap();

            let token_b_program_id = depositor_token_b_account.owner;
            do_process_instruction(
                approve(
                    &token_b_program_id,
                    depositor_token_b_key,
                    &user_transfer_authority,
                    depositor_key,
                    &[],
                    maximum_token_b_amount,
                )
                .unwrap(),
                vec![
                    depositor_token_b_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
            .unwrap();

            let pool_token_program_id = depositor_pool_account.owner;
            do_process_instruction(
                deposit_all_token_types(
                    &SWAP_PROGRAM_ID,
                    &token_a_program_id,
                    &token_b_program_id,
                    &pool_token_program_id,
                    &self.swap_key,
                    &self.authority_key,
                    &user_transfer_authority,
                    depositor_token_a_key,
                    depositor_token_b_key,
                    &self.token_a_key,
                    &self.token_b_key,
                    &self.pool_mint_key,
                    depositor_pool_key,
                    &self.token_a_mint_key,
                    &self.token_b_mint_key,
                    DepositAllTokenTypes {
                        pool_token_amount,
                        maximum_token_a_amount,
                        maximum_token_b_amount,
                    },
                )
                .unwrap(),
                vec![
                    &mut self.swap_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    depositor_token_a_account,
                    depositor_token_b_account,
                    &mut self.token_a_account,
                    &mut self.token_b_account,
                    &mut self.pool_mint_account,
                    depositor_pool_account,
                    &mut self.token_a_mint_account,
                    &mut self.token_b_mint_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
        }

        #[allow(clippy::too_many_arguments)]
        pub fn withdraw_all_token_types(
            &mut self,
            user_key: &Pubkey,
            pool_key: &Pubkey,
            pool_account: &mut SolanaAccount,
            token_a_key: &Pubkey,
            token_a_account: &mut SolanaAccount,
            token_b_key: &Pubkey,
            token_b_account: &mut SolanaAccount,
            pool_token_amount: u64,
            minimum_token_a_amount: u64,
            minimum_token_b_amount: u64,
        ) -> ProgramResult {
            let user_transfer_authority_key = Pubkey::new_unique();
            let pool_token_program_id = pool_account.owner;
            // approve user transfer authority to take out pool tokens
            do_process_instruction(
                approve(
                    &pool_token_program_id,
                    pool_key,
                    &user_transfer_authority_key,
                    user_key,
                    &[],
                    pool_token_amount,
                )
                .unwrap(),
                vec![
                    pool_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
            .unwrap();

            // withdraw token a and b correctly
            let token_a_program_id = token_a_account.owner;
            let token_b_program_id = token_b_account.owner;
            do_process_instruction(
                withdraw_all_token_types(
                    &SWAP_PROGRAM_ID,
                    &pool_token_program_id,
                    &token_a_program_id,
                    &token_b_program_id,
                    &self.swap_key,
                    &self.authority_key,
                    &user_transfer_authority_key,
                    &self.pool_mint_key,
                    pool_key,
                    &self.token_a_key,
                    &self.token_b_key,
                    token_a_key,
                    token_b_key,
                    &self.token_a_mint_key,
                    &self.token_b_mint_key,
                    WithdrawAllTokenTypes {
                        pool_token_amount,
                        minimum_token_a_amount,
                        minimum_token_b_amount,
                    },
                )
                .unwrap(),
                vec![
                    &mut self.swap_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    &mut self.pool_mint_account,
                    pool_account,
                    &mut self.token_a_account,
                    &mut self.token_b_account,
                    token_a_account,
                    token_b_account,
                    &mut self.token_a_mint_account,
                    &mut self.token_b_mint_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
        }

        #[allow(clippy::too_many_arguments)]
        pub fn deposit_single_token_type_exact_amount_in(
            &mut self,
            depositor_key: &Pubkey,
            deposit_account_key: &Pubkey,
            deposit_token_account: &mut SolanaAccount,
            deposit_pool_key: &Pubkey,
            deposit_pool_account: &mut SolanaAccount,
            source_token_amount: u64,
            minimum_pool_token_amount: u64,
        ) -> ProgramResult {
            let user_transfer_authority_key = Pubkey::new_unique();
            let source_token_program_id = deposit_token_account.owner;
            do_process_instruction(
                approve(
                    &source_token_program_id,
                    deposit_account_key,
                    &user_transfer_authority_key,
                    depositor_key,
                    &[],
                    source_token_amount,
                )
                .unwrap(),
                vec![
                    deposit_token_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
            .unwrap();

            let source_mint_key =
                StateWithExtensions::<Account>::unpack(&deposit_token_account.data)
                    .unwrap()
                    .base
                    .mint;
            let swap_source_key = self.get_swap_key(&source_mint_key);
            let (source_mint_key, mut source_mint_account) = self.get_token_mint(swap_source_key);

            let pool_token_program_id = deposit_pool_account.owner;
            do_process_instruction(
                deposit_single_token_type_exact_amount_in(
                    &SWAP_PROGRAM_ID,
                    &source_token_program_id,
                    &pool_token_program_id,
                    &self.swap_key,
                    &self.authority_key,
                    &user_transfer_authority_key,
                    deposit_account_key,
                    &self.token_a_key,
                    &self.token_b_key,
                    &self.pool_mint_key,
                    deposit_pool_key,
                    &source_mint_key,
                    DepositSingleTokenTypeExactAmountIn {
                        source_token_amount,
                        minimum_pool_token_amount,
                    },
                )
                .unwrap(),
                vec![
                    &mut self.swap_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    deposit_token_account,
                    &mut self.token_a_account,
                    &mut self.token_b_account,
                    &mut self.pool_mint_account,
                    deposit_pool_account,
                    &mut source_mint_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
        }

        #[allow(clippy::too_many_arguments)]
        pub fn withdraw_single_token_type_exact_amount_out(
            &mut self,
            user_key: &Pubkey,
            pool_key: &Pubkey,
            pool_account: &mut SolanaAccount,
            destination_key: &Pubkey,
            destination_account: &mut SolanaAccount,
            destination_token_amount: u64,
            maximum_pool_token_amount: u64,
        ) -> ProgramResult {
            let user_transfer_authority_key = Pubkey::new_unique();
            let pool_token_program_id = pool_account.owner;
            // approve user transfer authority to take out pool tokens
            do_process_instruction(
                approve(
                    &pool_token_program_id,
                    pool_key,
                    &user_transfer_authority_key,
                    user_key,
                    &[],
                    maximum_pool_token_amount,
                )
                .unwrap(),
                vec![
                    pool_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
            .unwrap();

            let destination_mint_key =
                StateWithExtensions::<Account>::unpack(&destination_account.data)
                    .unwrap()
                    .base
                    .mint;
            let swap_destination_key = self.get_swap_key(&destination_mint_key);
            let (destination_mint_key, mut destination_mint_account) =
                self.get_token_mint(swap_destination_key);

            let destination_token_program_id = destination_account.owner;
            do_process_instruction(
                withdraw_single_token_type_exact_amount_out(
                    &SWAP_PROGRAM_ID,
                    &pool_token_program_id,
                    &destination_token_program_id,
                    &self.swap_key,
                    &self.authority_key,
                    &user_transfer_authority_key,
                    &self.pool_mint_key,
                    pool_key,
                    &self.token_a_key,
                    &self.token_b_key,
                    destination_key,
                    &destination_mint_key,
                    WithdrawSingleTokenTypeExactAmountOut {
                        destination_token_amount,
                        maximum_pool_token_amount,
                    },
                )
                .unwrap(),
                vec![
                    &mut self.swap_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    &mut self.pool_mint_account,
                    pool_account,
                    &mut self.token_a_account,
                    &mut self.token_b_account,
                    destination_account,
                    &mut destination_mint_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
            )
        }
    }

    /// Seeds `protocol_fees_a`/`protocol_fees_b` directly in packed swap
    /// state, AND mints the matching extra tokens into the vaults via raw
    /// state surgery (no CPI, no mint-authority needed — `Account::LEN` is
    /// the shared base layout both spl-token and spl-token-2022 use, same
    /// convention `StateWithExtensions::<Account>` already relies on
    /// throughout this file). Exclusion correctness is tested ORTHOGONALLY
    /// to accrual correctness: these counters are seeded, never
    /// swap-produced.
    fn seed_protocol_fees(accounts: &mut SwapAccountInfo, fee_a: u64, fee_b: u64) {
        if fee_a > 0 {
            let mut token_a =
                Account::unpack_from_slice(&accounts.token_a_account.data[..Account::LEN])
                    .unwrap();
            token_a.amount = token_a.amount.checked_add(fee_a).unwrap();
            token_a.pack_into_slice(&mut accounts.token_a_account.data[..Account::LEN]);
        }
        if fee_b > 0 {
            let mut token_b =
                Account::unpack_from_slice(&accounts.token_b_account.data[..Account::LEN])
                    .unwrap();
            token_b.amount = token_b.amount.checked_add(fee_b).unwrap();
            token_b.pack_into_slice(&mut accounts.token_b_account.data[..Account::LEN]);
        }
        let mut data = accounts.swap_account.data.clone();
        let mut v2 = SwapV2::unpack_from_slice(&data[1..]).unwrap();
        v2.protocol_fees_a = v2.protocol_fees_a.checked_add(fee_a).unwrap();
        v2.protocol_fees_b = v2.protocol_fees_b.checked_add(fee_b).unwrap();
        v2.pack_into_slice(&mut data[1..]);
        accounts.swap_account.data = data;
    }

    fn mint_minimum_balance() -> u64 {
        Rent::default().minimum_balance(spl_token::state::Mint::get_packed_len())
    }

    fn account_minimum_balance() -> u64 {
        Rent::default().minimum_balance(spl_token::state::Account::get_packed_len())
    }

    fn do_process_instruction_with_fee_constraints(
        instruction: Instruction,
        accounts: Vec<&mut SolanaAccount>,
        swap_constraints: &Option<SwapConstraints>,
    ) -> ProgramResult {
        test_syscall_stubs();

        // Populate the outer-instruction account set BEFORE dispatch —
        // this is what `sol_invoke_signed` checks a nested CPI's program_id
        // against. Tests run one-per-thread, so the last populate always
        // matches "accounts present in the current transaction"; no
        // cross-test leakage.
        OUTER_ACCOUNT_KEYS.with(|k| {
            *k.borrow_mut() = instruction.accounts.iter().map(|m| m.pubkey).collect();
        });

        // approximate the logic in the actual runtime which runs the instruction
        // and only updates accounts if the instruction is successful
        let mut account_clones = accounts.iter().map(|x| (*x).clone()).collect::<Vec<_>>();
        let mut meta = instruction
            .accounts
            .iter()
            .zip(account_clones.iter_mut())
            .map(|(account_meta, account)| (&account_meta.pubkey, account_meta.is_signer, account))
            .collect::<Vec<_>>();
        let mut account_infos = create_is_signer_account_infos(&mut meta);
        let res = if instruction.program_id == SWAP_PROGRAM_ID {
            Processor::process_with_constraints(
                &instruction.program_id,
                &account_infos,
                &instruction.data,
                swap_constraints,
            )
        } else if instruction.program_id == spl_token::id() {
            spl_token::processor::Processor::process(
                &instruction.program_id,
                &account_infos,
                &instruction.data,
            )
        } else if instruction.program_id == spl_token_2022::id() {
            spl_token_2022::processor::Processor::process(
                &instruction.program_id,
                &account_infos,
                &instruction.data,
            )
        } else {
            Err(ProgramError::IncorrectProgramId)
        };

        if res.is_ok() {
            let mut account_metas = instruction
                .accounts
                .iter()
                .zip(accounts)
                .map(|(account_meta, account)| (&account_meta.pubkey, account))
                .collect::<Vec<_>>();
            for account_info in account_infos.iter_mut() {
                for account_meta in account_metas.iter_mut() {
                    if account_info.key == account_meta.0 {
                        let account = &mut account_meta.1;
                        account.owner = *account_info.owner;
                        account.lamports = **account_info.lamports.borrow();
                        account.data = account_info.data.borrow().to_vec();
                    }
                }
            }
        }
        res
    }

    fn do_process_instruction(
        instruction: Instruction,
        accounts: Vec<&mut SolanaAccount>,
    ) -> ProgramResult {
        do_process_instruction_with_fee_constraints(instruction, accounts, &SWAP_CONSTRAINTS)
    }

    fn mint_token(
        program_id: &Pubkey,
        mint_key: &Pubkey,
        mint_account: &mut SolanaAccount,
        mint_authority_key: &Pubkey,
        account_owner_key: &Pubkey,
        amount: u64,
    ) -> (Pubkey, SolanaAccount) {
        let account_key = Pubkey::new_unique();
        let space = if *program_id == spl_token_2022::id() {
            ExtensionType::try_calculate_account_len::<Account>(&[
                ExtensionType::ImmutableOwner,
                ExtensionType::TransferFeeAmount,
            ])
            .unwrap()
        } else {
            Account::get_packed_len()
        };
        let minimum_balance = Rent::default().minimum_balance(space);
        let mut account_account = SolanaAccount::new(minimum_balance, space, program_id);
        let mut mint_authority_account = SolanaAccount::default();
        let mut rent_sysvar_account = create_account_for_test(&Rent::free());

        // no-ops in normal token, so we're good to run it either way
        do_process_instruction(
            initialize_immutable_owner(program_id, &account_key).unwrap(),
            vec![&mut account_account],
        )
        .unwrap();

        do_process_instruction(
            initialize_account(program_id, &account_key, mint_key, account_owner_key).unwrap(),
            vec![
                &mut account_account,
                mint_account,
                &mut mint_authority_account,
                &mut rent_sysvar_account,
            ],
        )
        .unwrap();

        if amount > 0 {
            do_process_instruction(
                mint_to(
                    program_id,
                    mint_key,
                    &account_key,
                    mint_authority_key,
                    &[],
                    amount,
                )
                .unwrap(),
                vec![
                    mint_account,
                    &mut account_account,
                    &mut mint_authority_account,
                ],
            )
            .unwrap();
        }

        (account_key, account_account)
    }

    fn create_mint(
        program_id: &Pubkey,
        authority_key: &Pubkey,
        freeze_authority: Option<&Pubkey>,
        close_authority: Option<&Pubkey>,
        fees: &TransferFee,
    ) -> (Pubkey, SolanaAccount) {
        let mint_key = Pubkey::new_unique();
        let space = if *program_id == spl_token_2022::id() {
            if close_authority.is_some() {
                ExtensionType::try_calculate_account_len::<Mint>(&[
                    ExtensionType::MintCloseAuthority,
                    ExtensionType::TransferFeeConfig,
                ])
                .unwrap()
            } else {
                ExtensionType::try_calculate_account_len::<Mint>(&[
                    ExtensionType::TransferFeeConfig,
                ])
                .unwrap()
            }
        } else {
            Mint::get_packed_len()
        };
        let minimum_balance = Rent::default().minimum_balance(space);
        let mut mint_account = SolanaAccount::new(minimum_balance, space, program_id);
        let mut rent_sysvar_account = create_account_for_test(&Rent::free());

        if *program_id == spl_token_2022::id() {
            if close_authority.is_some() {
                do_process_instruction(
                    initialize_mint_close_authority(program_id, &mint_key, close_authority)
                        .unwrap(),
                    vec![&mut mint_account],
                )
                .unwrap();
            }
            do_process_instruction(
                initialize_transfer_fee_config(
                    program_id,
                    &mint_key,
                    freeze_authority,
                    freeze_authority,
                    fees.transfer_fee_basis_points.into(),
                    fees.maximum_fee.into(),
                )
                .unwrap(),
                vec![&mut mint_account],
            )
            .unwrap();
        }
        do_process_instruction(
            initialize_mint(program_id, &mint_key, authority_key, freeze_authority, 2).unwrap(),
            vec![&mut mint_account, &mut rent_sysvar_account],
        )
        .unwrap();

        (mint_key, mint_account)
    }

    #[test_case(spl_token::id(); "token")]
    #[test_case(spl_token_2022::id(); "token-2022")]
    fn test_token_program_id_error(token_program_id: Pubkey) {
        test_syscall_stubs();
        let swap_key = Pubkey::new_unique();
        let (authority_key, bump_seed) =
            Pubkey::find_program_address(&[&swap_key.to_bytes()[..]], &SWAP_PROGRAM_ID);
        // Real, correctly-authorized accounts (not empty shells): this is
        // what makes the outer-account-set check the ONLY thing standing
        // between this call and success — with real accounts, an
        // `InvalidAccountData` from downstream unpack (e.g. an empty mint
        // buffer) can't coincidentally masquerade as the check's refusal
        // and hide a dropped check (M7 in the design plan).
        let (mint_key, mut mint_account) = create_mint(
            &token_program_id,
            &authority_key,
            None,
            None,
            &TransferFee::default(),
        );
        let (destination_key, destination_account) = mint_token(
            &token_program_id,
            &mint_key,
            &mut mint_account,
            &authority_key,
            &Pubkey::new_unique(),
            0,
        );
        let mut mint = (mint_key, mint_account);
        let mut destination = (destination_key, destination_account);
        let mut authority = (authority_key, SolanaAccount::default());
        let swap_bytes = swap_key.to_bytes();
        let authority_signature_seeds = [&swap_bytes[..32], &[bump_seed]];
        let signers = &[&authority_signature_seeds[..]];
        let ix = mint_to(
            &token_program_id,
            &mint.0,
            &destination.0,
            &authority.0,
            &[],
            10,
        )
        .unwrap();
        let mint = (&mut mint).into();
        let destination = (&mut destination).into();
        let authority = (&mut authority).into();

        // No outer `do_process_instruction*` dispatch precedes this call —
        // OUTER_ACCOUNT_KEYS carries whatever the last top-level dispatch
        // (inside `create_mint`/`mint_token` above) left behind, which never
        // includes `token_program_id` — so the refusal below is the
        // outer-account-set check, not a setup accident. This is the
        // pinning test for that rule: a direct `invoke_signed` with
        // no outer context still fails, same error code as before the
        // restructure.
        let err = invoke_signed(&ix, &[mint, destination, authority], signers).unwrap_err();
        assert_eq!(err, ProgramError::InvalidAccountData);
    }

    #[test_case(spl_token::id(); "token")]
    #[test_case(spl_token_2022::id(); "token-2022")]
    fn test_token_error(token_program_id: Pubkey) {
        test_syscall_stubs();
        let swap_key = Pubkey::new_unique();
        let mut mint = (
            Pubkey::new_unique(),
            SolanaAccount::new(
                mint_minimum_balance(),
                spl_token::state::Mint::get_packed_len(),
                &token_program_id,
            ),
        );
        let mut destination = (
            Pubkey::new_unique(),
            SolanaAccount::new(
                account_minimum_balance(),
                spl_token::state::Account::get_packed_len(),
                &token_program_id,
            ),
        );
        let mut token_program = (token_program_id, SolanaAccount::default());
        let (authority_key, bump_seed) =
            Pubkey::find_program_address(&[&swap_key.to_bytes()[..]], &SWAP_PROGRAM_ID);
        let mut authority = (authority_key, SolanaAccount::default());
        let swap_bytes = swap_key.to_bytes();
        let authority_signature_seeds = [&swap_bytes[..32], &[bump_seed]];
        let signers = &[&authority_signature_seeds[..]];
        let mut rent_sysvar = (
            Pubkey::new_unique(),
            create_account_for_test(&Rent::default()),
        );
        do_process_instruction(
            initialize_mint(
                &token_program.0,
                &mint.0,
                &authority.0,
                Some(&authority.0),
                2,
            )
            .unwrap(),
            vec![&mut mint.1, &mut rent_sysvar.1],
        )
        .unwrap();
        do_process_instruction(
            initialize_account(&token_program.0, &destination.0, &mint.0, &authority.0).unwrap(),
            vec![
                &mut destination.1,
                &mut mint.1,
                &mut authority.1,
                &mut rent_sysvar.1,
                &mut token_program.1,
            ],
        )
        .unwrap();
        do_process_instruction(
            freeze_account(&token_program.0, &destination.0, &mint.0, &authority.0, &[]).unwrap(),
            vec![
                &mut destination.1,
                &mut mint.1,
                &mut authority.1,
                &mut token_program.1,
            ],
        )
        .unwrap();
        let ix = mint_to(
            &token_program.0,
            &mint.0,
            &destination.0,
            &authority.0,
            &[],
            10,
        )
        .unwrap();
        // This call simulates a nested CPI in isolation, with no enclosing
        // `do_process_instruction*` dispatch to populate the outer-account
        // set — declare the token program present in the (simulated)
        // outer transaction, same as every real Rome-dex instruction that
        // CPIs into it (Swap/Deposit/Withdraw all carry the token program as
        // a top-level account meta).
        OUTER_ACCOUNT_KEYS.with(|k| *k.borrow_mut() = vec![token_program.0]);
        let mint_info = (&mut mint).into();
        let destination_info = (&mut destination).into();
        let authority_info = (&mut authority).into();
        let token_program_info = (&mut token_program).into();

        let err = invoke_signed_wrapper::<TokenError>(
            &ix,
            &[
                mint_info,
                destination_info,
                authority_info,
                token_program_info,
            ],
            signers,
        )
        .unwrap_err();
        assert_eq!(err, ProgramError::Custom(TokenError::AccountFrozen as u32));
    }


    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_deposit(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let user_key = Pubkey::new_unique();
        let depositor_key = Pubkey::new_unique();
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 2;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 10;
        let owner_withdraw_fee_numerator = 1;
        let owner_withdraw_fee_denominator = 5;
        let host_fee_numerator = 20;
        let host_fee_denominator = 100;

        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_a_amount = 1000;
        let token_b_amount = 9000;
        let curve_type = CurveType::ConstantProduct;
        let swap_curve = SwapCurve {
            curve_type,
            calculator: Arc::new(ConstantProductCurve {}),
        };

        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        // depositing 10% of the current pool amount in token A and B means
        // that our pool tokens will be worth 1 / 10 of the current pool amount
        let pool_amount = INITIAL_SWAP_POOL_AMOUNT / 10;
        let deposit_a = token_a_amount / 10;
        let deposit_b = token_b_amount / 10;

        // swap not initialized
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            assert_eq!(
                Err(ProgramError::UninitializedAccount),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );
        }

        accounts.initialize_swap().unwrap();

        // wrong owner for swap account
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let old_swap_account = accounts.swap_account;
            let mut wrong_swap_account = old_swap_account.clone();
            wrong_swap_account.owner = pool_token_program_id;
            accounts.swap_account = wrong_swap_account;
            assert_eq!(
                Err(ProgramError::IncorrectProgramId),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );
            accounts.swap_account = old_swap_account;
        }

        // wrong bump seed for authority_key
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let old_authority = accounts.authority_key;
            let (bad_authority_key, _bump_seed) = Pubkey::find_program_address(
                &[&accounts.swap_key.to_bytes()[..]],
                &pool_token_program_id,
            );
            accounts.authority_key = bad_authority_key;
            assert_eq!(
                Err(SwapError::InvalidProgramAddress.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );
            accounts.authority_key = old_authority;
        }

        // not enough token A
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &depositor_key,
                deposit_a / 2,
                deposit_b,
                0,
            );
            assert_eq!(
                Err(TokenError::InsufficientFunds.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );
        }

        // not enough token B
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &depositor_key,
                deposit_a,
                deposit_b / 2,
                0,
            );
            assert_eq!(
                Err(TokenError::InsufficientFunds.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );
        }

        // wrong swap token accounts
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let expected_error: ProgramError = if token_a_account.owner == token_b_account.owner {
                TokenError::MintMismatch.into()
            } else {
                ProgramError::InvalidAccountData
            };
            assert_eq!(
                Err(expected_error),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_b_key,
                    &mut token_b_account,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );
        }

        // wrong pool token account
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                mut _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let (
                wrong_token_key,
                mut wrong_token_account,
                _token_b_key,
                mut _token_b_account,
                _pool_key,
                pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let expected_error: ProgramError = if token_a_account.owner == pool_account.owner {
                TokenError::MintMismatch.into()
            } else {
                SwapError::IncorrectTokenProgramId.into()
            };
            assert_eq!(
                Err(expected_error),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &wrong_token_key,
                    &mut wrong_token_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );
        }

        // no approval
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let user_transfer_authority_key = Pubkey::new_unique();
            assert_eq!(
                Err(TokenError::OwnerMismatch.into()),
                do_process_instruction(
                    deposit_all_token_types(
                        &SWAP_PROGRAM_ID,
                        &token_a_program_id,
                        &token_b_program_id,
                        &pool_token_program_id,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &user_transfer_authority_key,
                        &token_a_key,
                        &token_b_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &accounts.pool_mint_key,
                        &pool_key,
                        &accounts.token_a_mint_key,
                        &accounts.token_b_mint_key,
                        DepositAllTokenTypes {
                            pool_token_amount: pool_amount.try_into().unwrap(),
                            maximum_token_a_amount: deposit_a,
                            maximum_token_b_amount: deposit_b,
                        },
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut token_a_account,
                        &mut token_b_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut accounts.pool_mint_account,
                        &mut pool_account,
                        &mut accounts.token_a_mint_account,
                        &mut accounts.token_b_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                )
            );
        }

        // wrong token program id
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let wrong_key = Pubkey::new_unique();
            assert_eq!(
                Err(SwapError::IncorrectTokenProgramId.into()),
                do_process_instruction(
                    deposit_all_token_types(
                        &SWAP_PROGRAM_ID,
                        &wrong_key,
                        &wrong_key,
                        &wrong_key,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &accounts.authority_key,
                        &token_a_key,
                        &token_b_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &accounts.pool_mint_key,
                        &pool_key,
                        &accounts.token_a_mint_key,
                        &accounts.token_b_mint_key,
                        DepositAllTokenTypes {
                            pool_token_amount: pool_amount.try_into().unwrap(),
                            maximum_token_a_amount: deposit_a,
                            maximum_token_b_amount: deposit_b,
                        },
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut token_a_account,
                        &mut token_b_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut accounts.pool_mint_account,
                        &mut pool_account,
                        &mut accounts.token_a_mint_account,
                        &mut accounts.token_b_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                )
            );
        }

        // wrong swap token accounts
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);

            let old_a_key = accounts.token_a_key;
            let old_a_account = accounts.token_a_account;

            accounts.token_a_key = token_a_key;
            accounts.token_a_account = token_a_account.clone();

            // wrong swap token a account
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );

            accounts.token_a_key = old_a_key;
            accounts.token_a_account = old_a_account;

            let old_b_key = accounts.token_b_key;
            let old_b_account = accounts.token_b_account;

            accounts.token_b_key = token_b_key;
            accounts.token_b_account = token_b_account.clone();

            // wrong swap token b account
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );

            accounts.token_b_key = old_b_key;
            accounts.token_b_account = old_b_account;
        }

        // wrong mint
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let (pool_mint_key, pool_mint_account) = create_mint(
                &pool_token_program_id,
                &accounts.authority_key,
                None,
                None,
                &TransferFee::default(),
            );
            let old_pool_key = accounts.pool_mint_key;
            let old_pool_account = accounts.pool_mint_account;
            accounts.pool_mint_key = pool_mint_key;
            accounts.pool_mint_account = pool_mint_account;

            assert_eq!(
                Err(SwapError::IncorrectPoolMint.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );

            accounts.pool_mint_key = old_pool_key;
            accounts.pool_mint_account = old_pool_account;
        }

        // deposit 1 pool token fails because it equates to 0 swap tokens
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            assert_eq!(
                Err(SwapError::ZeroTradingTokens.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    1,
                    deposit_a,
                    deposit_b,
                )
            );
        }

        // slippage exceeded
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            // maximum A amount in too low
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a / 10,
                    deposit_b,
                )
            );
            // maximum B amount in too low
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b / 10,
                )
            );
        }

        // invalid input: can't use swap pool tokens as source
        {
            let (
                _token_a_key,
                _token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let swap_token_a_key = accounts.token_a_key;
            let mut swap_token_a_account = accounts.get_token_account(&swap_token_a_key).clone();
            let swap_token_b_key = accounts.token_b_key;
            let mut swap_token_b_account = accounts.get_token_account(&swap_token_b_key).clone();
            let authority_key = accounts.authority_key;
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.deposit_all_token_types(
                    &authority_key,
                    &swap_token_a_key,
                    &mut swap_token_a_account,
                    &swap_token_b_key,
                    &mut swap_token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
            );
        }

        // correctly deposit
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            accounts
                .deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount.try_into().unwrap(),
                    deposit_a,
                    deposit_b,
                )
                .unwrap();

            let swap_token_a =
                StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
            assert_eq!(swap_token_a.base.amount, deposit_a + token_a_amount);
            let swap_token_b =
                StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
            assert_eq!(swap_token_b.base.amount, deposit_b + token_b_amount);
            let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
            assert_eq!(token_a.base.amount, 0);
            let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
            assert_eq!(token_b.base.amount, 0);
            let pool_account = StateWithExtensions::<Account>::unpack(&pool_account.data).unwrap();
            let swap_pool_account =
                StateWithExtensions::<Account>::unpack(&accounts.pool_token_account.data).unwrap();
            let pool_mint =
                StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
            assert_eq!(
                pool_mint.base.supply,
                pool_account.base.amount + swap_pool_account.base.amount
            );
        }
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_withdraw(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let user_key = Pubkey::new_unique();
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 2;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 10;
        let owner_withdraw_fee_numerator = 1;
        let owner_withdraw_fee_denominator = 5;
        let host_fee_numerator = 7;
        let host_fee_denominator = 100;

        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_a_amount = 1000;
        let token_b_amount = 2000;
        let curve_type = CurveType::ConstantProduct;
        let swap_curve = SwapCurve {
            curve_type,
            calculator: Arc::new(ConstantProductCurve {}),
        };

        let withdrawer_key = Pubkey::new_unique();
        let initial_a = token_a_amount / 10;
        let initial_b = token_b_amount / 10;
        let initial_pool = swap_curve.calculator.new_pool_supply() / 10;
        let withdraw_amount = initial_pool / 4;
        let minimum_token_a_amount = initial_a / 40;
        let minimum_token_b_amount = initial_b / 40;

        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        // swap not initialized
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &withdrawer_key, initial_a, initial_b, 0);
            assert_eq!(
                Err(ProgramError::UninitializedAccount),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );
        }

        accounts.initialize_swap().unwrap();

        // wrong owner for swap account
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &withdrawer_key, initial_a, initial_b, 0);
            let old_swap_account = accounts.swap_account;
            let mut wrong_swap_account = old_swap_account.clone();
            wrong_swap_account.owner = pool_token_program_id;
            accounts.swap_account = wrong_swap_account;
            assert_eq!(
                Err(ProgramError::IncorrectProgramId),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );
            accounts.swap_account = old_swap_account;
        }

        // wrong bump seed for authority_key
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &withdrawer_key, initial_a, initial_b, 0);
            let old_authority = accounts.authority_key;
            let (bad_authority_key, _bump_seed) = Pubkey::find_program_address(
                &[&accounts.swap_key.to_bytes()[..]],
                &pool_token_program_id,
            );
            accounts.authority_key = bad_authority_key;
            assert_eq!(
                Err(SwapError::InvalidProgramAddress.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );
            accounts.authority_key = old_authority;
        }

        // not enough pool tokens
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                to_u64(withdraw_amount).unwrap() / 2u64,
            );
            assert_eq!(
                Err(TokenError::InsufficientFunds.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount / 2,
                    minimum_token_b_amount / 2,
                )
            );
        }

        // wrong token a / b accounts
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                withdraw_amount.try_into().unwrap(),
            );
            let expected_error: ProgramError = if token_a_account.owner == token_b_account.owner {
                TokenError::MintMismatch.into()
            } else {
                ProgramError::InvalidAccountData
            };
            assert_eq!(
                Err(expected_error),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_b_key,
                    &mut token_b_account,
                    &token_a_key,
                    &mut token_a_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );
        }

        // wrong pool token account
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                withdraw_amount.try_into().unwrap(),
            );
            let (
                wrong_token_a_key,
                mut wrong_token_a_account,
                _token_b_key,
                _token_b_account,
                _pool_key,
                pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                withdraw_amount.try_into().unwrap(),
                initial_b,
                withdraw_amount.try_into().unwrap(),
            );
            let expected_error: ProgramError = if token_a_account.owner == pool_account.owner {
                TokenError::MintMismatch.into()
            } else {
                SwapError::IncorrectTokenProgramId.into()
            };
            assert_eq!(
                Err(expected_error),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &wrong_token_a_key,
                    &mut wrong_token_a_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );
        }

        // no approval
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                0,
                0,
                withdraw_amount.try_into().unwrap(),
            );
            let user_transfer_authority_key = Pubkey::new_unique();
            assert_eq!(
                Err(TokenError::OwnerMismatch.into()),
                do_process_instruction(
                    withdraw_all_token_types(
                        &SWAP_PROGRAM_ID,
                        &pool_token_program_id,
                        &token_a_program_id,
                        &token_b_program_id,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &user_transfer_authority_key,
                        &accounts.pool_mint_key,
                        &pool_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &token_a_key,
                        &token_b_key,
                        &accounts.token_a_mint_key,
                        &accounts.token_b_mint_key,
                        WithdrawAllTokenTypes {
                            pool_token_amount: withdraw_amount.try_into().unwrap(),
                            minimum_token_a_amount,
                            minimum_token_b_amount,
                        }
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut accounts.pool_mint_account,
                        &mut pool_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut token_a_account,
                        &mut token_b_account,
                        &mut accounts.token_a_mint_account,
                        &mut accounts.token_b_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                )
            );
        }

        // wrong token program id
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                withdraw_amount.try_into().unwrap(),
            );
            let wrong_key = Pubkey::new_unique();
            assert_eq!(
                Err(SwapError::IncorrectTokenProgramId.into()),
                do_process_instruction(
                    withdraw_all_token_types(
                        &SWAP_PROGRAM_ID,
                        &wrong_key,
                        &wrong_key,
                        &wrong_key,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &accounts.authority_key,
                        &accounts.pool_mint_key,
                        &pool_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &token_a_key,
                        &token_b_key,
                        &accounts.token_a_mint_key,
                        &accounts.token_b_mint_key,
                        WithdrawAllTokenTypes {
                            pool_token_amount: withdraw_amount.try_into().unwrap(),
                            minimum_token_a_amount,
                            minimum_token_b_amount,
                        },
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut accounts.pool_mint_account,
                        &mut pool_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut token_a_account,
                        &mut token_b_account,
                        &mut accounts.token_a_mint_account,
                        &mut accounts.token_b_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                )
            );
        }

        // wrong swap token accounts
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );

            let old_a_key = accounts.token_a_key;
            let old_a_account = accounts.token_a_account;

            accounts.token_a_key = token_a_key;
            accounts.token_a_account = token_a_account.clone();

            // wrong swap token a account
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );

            accounts.token_a_key = old_a_key;
            accounts.token_a_account = old_a_account;

            let old_b_key = accounts.token_b_key;
            let old_b_account = accounts.token_b_account;

            accounts.token_b_key = token_b_key;
            accounts.token_b_account = token_b_account.clone();

            // wrong swap token b account
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );

            accounts.token_b_key = old_b_key;
            accounts.token_b_account = old_b_account;
        }

        // wrong mint
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );
            let (pool_mint_key, pool_mint_account) = create_mint(
                &pool_token_program_id,
                &accounts.authority_key,
                None,
                None,
                &TransferFee::default(),
            );
            let old_pool_key = accounts.pool_mint_key;
            let old_pool_account = accounts.pool_mint_account;
            accounts.pool_mint_key = pool_mint_key;
            accounts.pool_mint_account = pool_mint_account;

            assert_eq!(
                Err(SwapError::IncorrectPoolMint.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );

            accounts.pool_mint_key = old_pool_key;
            accounts.pool_mint_account = old_pool_account;
        }

        // withdrawing 1 pool token fails because it equates to 0 output tokens
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );
            assert_eq!(
                Err(SwapError::ZeroTradingTokens.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    1,
                    0,
                    0,
                )
            );
        }

        // slippage exceeded
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );
            // minimum A amount out too high
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount * 10,
                    minimum_token_b_amount,
                )
            );
            // minimum B amount out too high
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount * 10,
                )
            );
        }

        // invalid input: can't use swap pool tokens as destination
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );
            let swap_token_a_key = accounts.token_a_key;
            let mut swap_token_a_account = accounts.get_token_account(&swap_token_a_key).clone();
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &swap_token_a_key,
                    &mut swap_token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );
            let swap_token_b_key = accounts.token_b_key;
            let mut swap_token_b_account = accounts.get_token_account(&swap_token_b_key).clone();
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &swap_token_b_key,
                    &mut swap_token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
            );
        }

        // correct withdrawal
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );

            accounts
                .withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    withdraw_amount.try_into().unwrap(),
                    minimum_token_a_amount,
                    minimum_token_b_amount,
                )
                .unwrap();

            let swap_token_a =
                StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
            let swap_token_b =
                StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
            let pool_mint =
                StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
            // D8: the withdraw-fee LP-mint machinery is deleted — burn is
            // the full `withdraw_amount`, no fee deduction, no fee account.
            let results = accounts
                .swap_curve
                .calculator
                .pool_tokens_to_trading_tokens(
                    withdraw_amount,
                    pool_mint.base.supply.into(),
                    swap_token_a.base.amount.into(),
                    swap_token_b.base.amount.into(),
                    RoundDirection::Floor,
                )
                .unwrap();
            assert_eq!(
                swap_token_a.base.amount,
                token_a_amount - to_u64(results.token_a_amount).unwrap()
            );
            assert_eq!(
                swap_token_b.base.amount,
                token_b_amount - to_u64(results.token_b_amount).unwrap()
            );
            let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
            assert_eq!(
                token_a.base.amount,
                initial_a + to_u64(results.token_a_amount).unwrap()
            );
            let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
            assert_eq!(
                token_b.base.amount,
                initial_b + to_u64(results.token_b_amount).unwrap()
            );
            let pool_account = StateWithExtensions::<Account>::unpack(&pool_account.data).unwrap();
            assert_eq!(
                pool_account.base.amount,
                to_u64(initial_pool - withdraw_amount).unwrap()
            );
        }
        // "correct withdrawal from fee account" relocated to
        // `test_withdraw_from_fee_account_tag0` — under tag 7 the fee
        // account's owner is the pool PDA, not `user_key`.
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_deposit_one_exact_in(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let user_key = Pubkey::new_unique();
        let depositor_key = Pubkey::new_unique();
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 2;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 10;
        let owner_withdraw_fee_numerator = 1;
        let owner_withdraw_fee_denominator = 5;
        let host_fee_numerator = 20;
        let host_fee_denominator = 100;

        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_a_amount = 1000;
        let token_b_amount = 9000;
        let curve_type = CurveType::ConstantProduct;
        let swap_curve = SwapCurve {
            curve_type,
            calculator: Arc::new(ConstantProductCurve {}),
        };

        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        let deposit_a = token_a_amount / 10;
        let deposit_b = token_b_amount / 10;
        let pool_amount = to_u64(INITIAL_SWAP_POOL_AMOUNT / 100).unwrap();

        // swap not initialized
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            assert_eq!(
                Err(ProgramError::UninitializedAccount),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    pool_amount,
                )
            );
        }

        accounts.initialize_swap().unwrap();

        // wrong owner for swap account
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let old_swap_account = accounts.swap_account;
            let mut wrong_swap_account = old_swap_account.clone();
            wrong_swap_account.owner = pool_token_program_id;
            accounts.swap_account = wrong_swap_account;
            assert_eq!(
                Err(ProgramError::IncorrectProgramId),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    pool_amount,
                )
            );
            accounts.swap_account = old_swap_account;
        }

        // wrong bump seed for authority_key
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let old_authority = accounts.authority_key;
            let (bad_authority_key, _bump_seed) = Pubkey::find_program_address(
                &[&accounts.swap_key.to_bytes()[..]],
                &pool_token_program_id,
            );
            accounts.authority_key = bad_authority_key;
            assert_eq!(
                Err(SwapError::InvalidProgramAddress.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    pool_amount,
                )
            );
            accounts.authority_key = old_authority;
        }

        // not enough token A / B
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &depositor_key,
                deposit_a / 2,
                deposit_b / 2,
                0,
            );
            assert_eq!(
                Err(TokenError::InsufficientFunds.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    0,
                )
            );
            assert_eq!(
                Err(TokenError::InsufficientFunds.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_b,
                    0,
                )
            );
        }

        // wrong pool token account
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let expected_error: ProgramError = if token_b_account.owner == pool_account.owner {
                TokenError::MintMismatch.into()
            } else {
                SwapError::IncorrectTokenProgramId.into()
            };
            assert_eq!(
                Err(expected_error),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    deposit_a,
                    pool_amount,
                )
            );
        }

        // no approval
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let user_transfer_authority_key = Pubkey::new_unique();
            assert_eq!(
                Err(TokenError::OwnerMismatch.into()),
                do_process_instruction(
                    deposit_single_token_type_exact_amount_in(
                        &SWAP_PROGRAM_ID,
                        &token_a_program_id,
                        &pool_token_program_id,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &user_transfer_authority_key,
                        &token_a_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &accounts.pool_mint_key,
                        &pool_key,
                        &accounts.token_a_mint_key,
                        DepositSingleTokenTypeExactAmountIn {
                            source_token_amount: deposit_a,
                            minimum_pool_token_amount: pool_amount,
                        },
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut token_a_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut accounts.pool_mint_account,
                        &mut pool_account,
                        &mut accounts.token_a_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                )
            );
        }

        // wrong token program id
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let wrong_key = Pubkey::new_unique();
            assert_eq!(
                Err(SwapError::IncorrectTokenProgramId.into()),
                do_process_instruction(
                    deposit_single_token_type_exact_amount_in(
                        &SWAP_PROGRAM_ID,
                        &wrong_key,
                        &wrong_key,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &accounts.authority_key,
                        &token_a_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &accounts.pool_mint_key,
                        &pool_key,
                        &accounts.token_a_mint_key,
                        DepositSingleTokenTypeExactAmountIn {
                            source_token_amount: deposit_a,
                            minimum_pool_token_amount: pool_amount,
                        },
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut token_a_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut accounts.pool_mint_account,
                        &mut pool_account,
                        &mut accounts.token_a_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                )
            );
        }

        // wrong swap token accounts
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);

            let old_a_key = accounts.token_a_key;
            let old_a_account = accounts.token_a_account;

            accounts.token_a_key = token_a_key;
            accounts.token_a_account = token_a_account.clone();

            // wrong swap token a account
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    pool_amount,
                )
            );

            accounts.token_a_key = old_a_key;
            accounts.token_a_account = old_a_account;

            let old_b_key = accounts.token_b_key;
            let old_b_account = accounts.token_b_account;

            accounts.token_b_key = token_b_key;
            accounts.token_b_account = token_b_account;

            // wrong swap token b account
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    pool_amount,
                )
            );

            accounts.token_b_key = old_b_key;
            accounts.token_b_account = old_b_account;
        }

        // wrong mint
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let (pool_mint_key, pool_mint_account) = create_mint(
                &pool_token_program_id,
                &accounts.authority_key,
                None,
                None,
                &TransferFee::default(),
            );
            let old_pool_key = accounts.pool_mint_key;
            let old_pool_account = accounts.pool_mint_account;
            accounts.pool_mint_key = pool_mint_key;
            accounts.pool_mint_account = pool_mint_account;

            assert_eq!(
                Err(SwapError::IncorrectPoolMint.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    pool_amount,
                )
            );

            accounts.pool_mint_key = old_pool_key;
            accounts.pool_mint_account = old_pool_account;
        }

        // slippage exceeded
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            // minimum pool amount too high
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a / 10,
                    pool_amount,
                )
            );
            // minimum pool amount too high
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_b / 10,
                    pool_amount,
                )
            );
        }

        // invalid input: can't use swap pool tokens as source
        {
            let (
                _token_a_key,
                _token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            let swap_token_a_key = accounts.token_a_key;
            let mut swap_token_a_account = accounts.get_token_account(&swap_token_a_key).clone();
            let swap_token_b_key = accounts.token_b_key;
            let mut swap_token_b_account = accounts.get_token_account(&swap_token_b_key).clone();
            let authority_key = accounts.authority_key;
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &authority_key,
                    &swap_token_a_key,
                    &mut swap_token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    pool_amount,
                )
            );
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.deposit_single_token_type_exact_amount_in(
                    &authority_key,
                    &swap_token_b_key,
                    &mut swap_token_b_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_b,
                    pool_amount,
                )
            );
        }

        // correctly deposit
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &depositor_key, deposit_a, deposit_b, 0);
            accounts
                .deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_a,
                    pool_amount,
                )
                .unwrap();

            let swap_token_a =
                StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
            assert_eq!(swap_token_a.base.amount, deposit_a + token_a_amount);

            let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
            assert_eq!(token_a.base.amount, 0);

            accounts
                .deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_b,
                    pool_amount,
                )
                .unwrap();
            let swap_token_b =
                StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
            assert_eq!(swap_token_b.base.amount, deposit_b + token_b_amount);

            let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
            assert_eq!(token_b.base.amount, 0);

            let pool_account = StateWithExtensions::<Account>::unpack(&pool_account.data).unwrap();
            let swap_pool_account =
                StateWithExtensions::<Account>::unpack(&accounts.pool_token_account.data).unwrap();
            let pool_mint =
                StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
            assert_eq!(
                pool_mint.base.supply,
                pool_account.base.amount + swap_pool_account.base.amount
            );
        }
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_withdraw_one_exact_out(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let user_key = Pubkey::new_unique();
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 2;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 10;
        let owner_withdraw_fee_numerator = 1;
        let owner_withdraw_fee_denominator = 5;
        let host_fee_numerator = 7;
        let host_fee_denominator = 100;

        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_a_amount = 100_000;
        let token_b_amount = 200_000;
        let curve_type = CurveType::ConstantProduct;
        let swap_curve = SwapCurve {
            curve_type,
            calculator: Arc::new(ConstantProductCurve {}),
        };

        let withdrawer_key = Pubkey::new_unique();
        let initial_a = token_a_amount / 10;
        let initial_b = token_b_amount / 10;
        let initial_pool = swap_curve.calculator.new_pool_supply() / 10;
        let maximum_pool_token_amount = to_u64(initial_pool / 4).unwrap();
        let destination_a_amount = initial_a / 40;
        let destination_b_amount = initial_b / 40;

        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        // swap not initialized
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &withdrawer_key, initial_a, initial_b, 0);
            assert_eq!(
                Err(ProgramError::UninitializedAccount),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    destination_a_amount,
                    maximum_pool_token_amount,
                )
            );
        }

        accounts.initialize_swap().unwrap();

        // wrong owner for swap account
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &withdrawer_key, initial_a, initial_b, 0);
            let old_swap_account = accounts.swap_account;
            let mut wrong_swap_account = old_swap_account.clone();
            wrong_swap_account.owner = pool_token_program_id;
            accounts.swap_account = wrong_swap_account;
            assert_eq!(
                Err(ProgramError::IncorrectProgramId),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    destination_a_amount,
                    maximum_pool_token_amount,
                )
            );
            accounts.swap_account = old_swap_account;
        }

        // wrong bump seed for authority_key
        {
            let (
                _token_a_key,
                _token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &withdrawer_key, initial_a, initial_b, 0);
            let old_authority = accounts.authority_key;
            let (bad_authority_key, _bump_seed) = Pubkey::find_program_address(
                &[&accounts.swap_key.to_bytes()[..]],
                &pool_token_program_id,
            );
            accounts.authority_key = bad_authority_key;
            assert_eq!(
                Err(SwapError::InvalidProgramAddress.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_b_key,
                    &mut token_b_account,
                    destination_b_amount,
                    maximum_pool_token_amount,
                )
            );
            accounts.authority_key = old_authority;
        }

        // not enough pool tokens
        {
            let (
                _token_a_key,
                _token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                maximum_pool_token_amount / 1000,
            );
            assert_eq!(
                Err(TokenError::InsufficientFunds.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_b_key,
                    &mut token_b_account,
                    destination_b_amount,
                    maximum_pool_token_amount,
                )
            );
        }

        // wrong pool token account
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                maximum_pool_token_amount,
                initial_b,
                maximum_pool_token_amount,
            );
            let expected_error: ProgramError = if token_a_account.owner == pool_account.owner {
                TokenError::MintMismatch.into()
            } else {
                SwapError::IncorrectTokenProgramId.into()
            };
            assert_eq!(
                Err(expected_error),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    destination_b_amount,
                    maximum_pool_token_amount,
                )
            );
        }

        // no approval
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                0,
                0,
                maximum_pool_token_amount,
            );
            let user_transfer_authority_key = Pubkey::new_unique();
            assert_eq!(
                Err(TokenError::OwnerMismatch.into()),
                do_process_instruction(
                    withdraw_single_token_type_exact_amount_out(
                        &SWAP_PROGRAM_ID,
                        &pool_token_program_id,
                        &token_a_program_id,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &user_transfer_authority_key,
                        &accounts.pool_mint_key,
                        &pool_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &token_a_key,
                        &accounts.token_a_mint_key,
                        WithdrawSingleTokenTypeExactAmountOut {
                            destination_token_amount: destination_a_amount,
                            maximum_pool_token_amount,
                        }
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut accounts.pool_mint_account,
                        &mut pool_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut token_a_account,
                        &mut accounts.token_a_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                )
            );
        }

        // wrong token program id
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                maximum_pool_token_amount,
            );
            let wrong_key = Pubkey::new_unique();
            assert_eq!(
                Err(SwapError::IncorrectTokenProgramId.into()),
                do_process_instruction(
                    withdraw_single_token_type_exact_amount_out(
                        &SWAP_PROGRAM_ID,
                        &wrong_key,
                        &wrong_key,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &accounts.authority_key,
                        &accounts.pool_mint_key,
                        &pool_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &token_a_key,
                        &accounts.token_a_mint_key,
                        WithdrawSingleTokenTypeExactAmountOut {
                            destination_token_amount: destination_a_amount,
                            maximum_pool_token_amount,
                        }
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut accounts.pool_mint_account,
                        &mut pool_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut token_a_account,
                        &mut accounts.token_a_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                )
            );
        }

        // wrong swap token accounts
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );

            let old_a_key = accounts.token_a_key;
            let old_a_account = accounts.token_a_account;

            accounts.token_a_key = token_a_key;
            accounts.token_a_account = token_a_account.clone();

            // wrong swap token a account
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    destination_a_amount,
                    maximum_pool_token_amount,
                )
            );

            accounts.token_a_key = old_a_key;
            accounts.token_a_account = old_a_account;

            let old_b_key = accounts.token_b_key;
            let old_b_account = accounts.token_b_account;

            accounts.token_b_key = token_b_key;
            accounts.token_b_account = token_b_account.clone();

            // wrong swap token b account
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_b_key,
                    &mut token_b_account,
                    destination_b_amount,
                    maximum_pool_token_amount,
                )
            );

            accounts.token_b_key = old_b_key;
            accounts.token_b_account = old_b_account;
        }

        // wrong mint
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );
            let (pool_mint_key, pool_mint_account) = create_mint(
                &pool_token_program_id,
                &accounts.authority_key,
                None,
                None,
                &TransferFee::default(),
            );
            let old_pool_key = accounts.pool_mint_key;
            let old_pool_account = accounts.pool_mint_account;
            accounts.pool_mint_key = pool_mint_key;
            accounts.pool_mint_account = pool_mint_account;

            assert_eq!(
                Err(SwapError::IncorrectPoolMint.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    destination_a_amount,
                    maximum_pool_token_amount,
                )
            );

            accounts.pool_mint_key = old_pool_key;
            accounts.pool_mint_account = old_pool_account;
        }

        // slippage exceeded
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                maximum_pool_token_amount,
            );

            // maximum pool token amount too low
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    destination_a_amount,
                    maximum_pool_token_amount / 1000,
                )
            );
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_b_key,
                    &mut token_b_account,
                    destination_b_amount,
                    maximum_pool_token_amount / 1000,
                )
            );
        }

        // invalid input: can't use swap pool tokens as destination
        {
            let (
                _token_a_key,
                _token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                maximum_pool_token_amount,
            );
            let swap_token_a_key = accounts.token_a_key;
            let mut swap_token_a_account = accounts.get_token_account(&swap_token_a_key).clone();
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &swap_token_a_key,
                    &mut swap_token_a_account,
                    destination_a_amount,
                    maximum_pool_token_amount,
                )
            );
            let swap_token_b_key = accounts.token_b_key;
            let mut swap_token_b_account = accounts.get_token_account(&swap_token_b_key).clone();
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &swap_token_b_key,
                    &mut swap_token_b_account,
                    destination_b_amount,
                    maximum_pool_token_amount,
                )
            );
        }

        // correct withdrawal
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(
                &user_key,
                &withdrawer_key,
                initial_a,
                initial_b,
                initial_pool.try_into().unwrap(),
            );

            let swap_token_a =
                StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
            let swap_token_b =
                StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
            let pool_mint =
                StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();

            let pool_token_amount = accounts
                .swap_curve
                .withdraw_single_token_type_exact_out(
                    destination_a_amount.into(),
                    swap_token_a.base.amount.into(),
                    swap_token_b.base.amount.into(),
                    pool_mint.base.supply.into(),
                    TradeDirection::AtoB,
                    &accounts.fees,
                )
                .unwrap();
            // D9: the withdraw-fee LP-mint machinery is deleted — burn is
            // exactly `pool_token_amount` (the curve-computed amount), no
            // fee add, no fee account.

            accounts
                .withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    destination_a_amount,
                    maximum_pool_token_amount,
                )
                .unwrap();

            let swap_token_a =
                StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();

            assert_eq!(
                swap_token_a.base.amount,
                token_a_amount - destination_a_amount
            );
            let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
            assert_eq!(token_a.base.amount, initial_a + destination_a_amount);

            let pool_account = StateWithExtensions::<Account>::unpack(&pool_account.data).unwrap();
            assert_eq!(
                pool_account.base.amount,
                to_u64(initial_pool - pool_token_amount).unwrap()
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn check_valid_swap_curve(
        fees: Fees,
        transfer_fees: SwapTransferFees,
        curve_type: CurveType,
        calculator: Arc<dyn CurveCalculator + Send + Sync>,
        token_a_amount: u64,
        token_b_amount: u64,
        pool_token_program_id: &Pubkey,
        token_a_program_id: &Pubkey,
        token_b_program_id: &Pubkey,
    ) {
        let user_key = Pubkey::new_unique();
        let swapper_key = Pubkey::new_unique();

        let swap_curve = SwapCurve {
            curve_type,
            calculator,
        };

        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees.clone(),
            transfer_fees,
            swap_curve.clone(),
            token_a_amount,
            token_b_amount,
            pool_token_program_id,
            token_a_program_id,
            token_b_program_id,
        );
        let initial_a = token_a_amount / 5;
        let initial_b = token_b_amount / 5;
        accounts.initialize_swap().unwrap();

        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;

        let (
            token_a_key,
            mut token_a_account,
            token_b_key,
            mut token_b_account,
            _pool_key,
            _pool_account,
        ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
        // swap one way
        let a_to_b_amount = initial_a / 10;
        let minimum_token_b_amount = 0;
        accounts
            .swap(
                &swapper_key,
                &token_a_key,
                &mut token_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &token_b_key,
                &mut token_b_account,
                a_to_b_amount,
                minimum_token_b_amount,
            )
            .unwrap();

        // tweak values based on transfer fees assessed
        let token_a_fee = accounts
            .transfer_fees
            .token_a
            .calculate_fee(a_to_b_amount)
            .unwrap();
        let actual_a_to_b_amount = a_to_b_amount - token_a_fee;
        let results = swap_curve
            .swap(
                actual_a_to_b_amount.into(),
                token_a_amount.into(),
                token_b_amount.into(),
                TradeDirection::AtoB,
                &fees,
            )
            .unwrap();

        let swap_token_a =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
        let token_a_amount = swap_token_a.base.amount;
        assert_eq!(
            token_a_amount,
            TryInto::<u64>::try_into(results.new_swap_source_amount).unwrap()
        );
        let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
        assert_eq!(token_a.base.amount, initial_a - a_to_b_amount);

        let swap_token_b =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
        let token_b_amount = swap_token_b.base.amount;
        assert_eq!(
            token_b_amount,
            TryInto::<u64>::try_into(results.new_swap_destination_amount).unwrap()
        );
        let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
        assert_eq!(
            token_b.base.amount,
            initial_b + to_u64(results.destination_amount_swapped).unwrap()
        );

        // Accrual: the owner-fee slice is a SwapV2 counter,
        // not an LP-minted reconversion — the counter equals `owner_fee`
        // token units directly.
        let first_fee = to_u64(results.owner_fee).unwrap();
        let swap_state = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        assert_eq!(swap_state.protocol_fees_a(), first_fee);
        assert_eq!(swap_state.protocol_fees_b(), 0);

        let first_swap_amount = results.destination_amount_swapped;

        // swap the other way
        let b_to_a_amount = initial_b / 10;
        let minimum_a_amount = 0;
        accounts
            .swap(
                &swapper_key,
                &token_b_key,
                &mut token_b_account,
                &swap_token_b_key,
                &swap_token_a_key,
                &token_a_key,
                &mut token_a_account,
                b_to_a_amount,
                minimum_a_amount,
            )
            .unwrap();

        // X1-X4: the second swap's mirror must read LP-OWNED reserves —
        // side A already holds `first_fee` protocol-owned tokens the pool
        // math must not see.
        let lp_owned_a = token_a_amount - first_fee;
        let mut results = swap_curve
            .swap(
                b_to_a_amount.into(),
                token_b_amount.into(),
                lp_owned_a.into(),
                TradeDirection::BtoA,
                &fees,
            )
            .unwrap();
        // tweak values based on transfer fees assessed
        let token_a_fee = accounts
            .transfer_fees
            .token_a
            .calculate_fee(results.destination_amount_swapped.try_into().unwrap())
            .unwrap();
        results.destination_amount_swapped -= token_a_fee as u128;

        // vault == new_swap_destination_amount (LP-owned) + the counter
        // still sitting in the vault (the exclusion invariant).
        let swap_token_a =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
        let token_a_amount = swap_token_a.base.amount;
        assert_eq!(
            token_a_amount,
            TryInto::<u64>::try_into(results.new_swap_destination_amount).unwrap() + first_fee
        );
        let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
        assert_eq!(
            token_a.base.amount,
            initial_a - a_to_b_amount + to_u64(results.destination_amount_swapped).unwrap()
        );

        let swap_token_b =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
        let token_b_amount = swap_token_b.base.amount;
        assert_eq!(
            token_b_amount,
            TryInto::<u64>::try_into(results.new_swap_source_amount).unwrap()
        );
        let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
        assert_eq!(
            token_b.base.amount,
            initial_b + to_u64(first_swap_amount).unwrap()
                - to_u64(results.source_amount_swapped).unwrap()
        );

        // Second swap accrues to protocol_fees_b; protocol_fees_a is
        // untouched by a BtoA swap.
        let second_fee = to_u64(results.owner_fee).unwrap();
        let swap_state = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        assert_eq!(swap_state.protocol_fees_a(), first_fee);
        assert_eq!(swap_state.protocol_fees_b(), second_fee);
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_valid_swap_curve_all_fees(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        // All fees
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 10;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 30;
        let owner_withdraw_fee_numerator = 1;
        let owner_withdraw_fee_denominator = 30;
        let host_fee_numerator = 20;
        let host_fee_denominator = 100;
        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_a_amount = 10_000_000_000;
        let token_b_amount = 50_000_000_000;

        check_valid_swap_curve(
            fees.clone(),
            SwapTransferFees::default(),
            CurveType::ConstantProduct,
            Arc::new(ConstantProductCurve {}),
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );
        let token_b_price = 1;
        check_valid_swap_curve(
            fees.clone(),
            SwapTransferFees::default(),
            CurveType::ConstantPrice,
            Arc::new(ConstantPriceCurve { token_b_price }),
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );
        let token_b_offset = 10_000_000_000;
        check_valid_swap_curve(
            fees,
            SwapTransferFees::default(),
            CurveType::Offset,
            Arc::new(OffsetCurve { token_b_offset }),
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_valid_swap_curve_trade_fee_only(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 10;
        let owner_trade_fee_numerator = 0;
        let owner_trade_fee_denominator = 0;
        let owner_withdraw_fee_numerator = 0;
        let owner_withdraw_fee_denominator = 0;
        let host_fee_numerator = 0;
        let host_fee_denominator = 0;
        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_a_amount = 10_000_000_000;
        let token_b_amount = 50_000_000_000;

        check_valid_swap_curve(
            fees.clone(),
            SwapTransferFees::default(),
            CurveType::ConstantProduct,
            Arc::new(ConstantProductCurve {}),
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );
        let token_b_price = 10_000;
        check_valid_swap_curve(
            fees.clone(),
            SwapTransferFees::default(),
            CurveType::ConstantPrice,
            Arc::new(ConstantPriceCurve { token_b_price }),
            token_a_amount,
            token_b_amount / token_b_price,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );
        let token_b_offset = 1;
        check_valid_swap_curve(
            fees,
            SwapTransferFees::default(),
            CurveType::Offset,
            Arc::new(OffsetCurve { token_b_offset }),
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_invalid_swap(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let user_key = Pubkey::new_unique();
        let swapper_key = Pubkey::new_unique();
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 4;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 10;
        let owner_withdraw_fee_numerator = 1;
        let owner_withdraw_fee_denominator = 5;
        let host_fee_numerator = 9;
        let host_fee_denominator = 100;
        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_a_amount = 1000;
        let token_b_amount = 5000;
        let curve_type = CurveType::ConstantProduct;
        let swap_curve = SwapCurve {
            curve_type,
            calculator: Arc::new(ConstantProductCurve {}),
        };
        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        let initial_a = token_a_amount / 5;
        let initial_b = token_b_amount / 5;
        let minimum_token_b_amount = initial_b / 2;

        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;

        // swap not initialized
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            // Under v2, the pool shell is system-owned pre-`initialize_swap()`
            // (the pre-sizing contract requires it) — `process_swap`'s
            // own `swap_info.owner != program_id` check (processor.rs `:637-639`)
            // fires before ever reaching `SwapVersion::unpack`, so this is
            // IncorrectProgramId, not UninitializedAccount (which was a v1
            // artifact of the pool always being pre-owned by the program).
            assert_eq!(
                Err(ProgramError::IncorrectProgramId),
                accounts.swap(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &token_b_key,
                    &mut token_b_account,
                    initial_a,
                    minimum_token_b_amount,
                )
            );
        }

        accounts.initialize_swap().unwrap();

        // wrong swap account program id
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            let old_swap_account = accounts.swap_account;
            let mut wrong_swap_account = old_swap_account.clone();
            wrong_swap_account.owner = pool_token_program_id;
            accounts.swap_account = wrong_swap_account;
            assert_eq!(
                Err(ProgramError::IncorrectProgramId),
                accounts.swap(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &token_b_key,
                    &mut token_b_account,
                    initial_a,
                    minimum_token_b_amount,
                )
            );
            accounts.swap_account = old_swap_account;
        }

        // wrong bump seed
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            let old_authority = accounts.authority_key;
            let (bad_authority_key, _bump_seed) = Pubkey::find_program_address(
                &[&accounts.swap_key.to_bytes()[..]],
                &pool_token_program_id,
            );
            accounts.authority_key = bad_authority_key;
            assert_eq!(
                Err(SwapError::InvalidProgramAddress.into()),
                accounts.swap(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &token_b_key,
                    &mut token_b_account,
                    initial_a,
                    minimum_token_b_amount,
                )
            );
            accounts.authority_key = old_authority;
        }

        // wrong token program id
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            let wrong_program_id = Pubkey::new_unique();
            assert_eq!(
                Err(SwapError::IncorrectTokenProgramId.into()),
                do_process_instruction(
                    swap(
                        &SWAP_PROGRAM_ID,
                        &wrong_program_id,
                        &wrong_program_id,
                        &wrong_program_id,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &accounts.authority_key,
                        &token_a_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &token_b_key,
                        &accounts.pool_mint_key,
                        &accounts.token_a_mint_key,
                        &accounts.token_b_mint_key,
                        Swap {
                            amount_in: initial_a,
                            minimum_amount_out: minimum_token_b_amount,
                        },
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut token_a_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut token_b_account,
                        &mut accounts.pool_mint_account,
                        &mut accounts.token_a_mint_account,
                        &mut accounts.token_b_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                ),
            );
        }

        // not enough token a to swap
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            assert_eq!(
                Err(TokenError::InsufficientFunds.into()),
                accounts.swap(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &token_b_key,
                    &mut token_b_account,
                    initial_a * 2,
                    minimum_token_b_amount * 2,
                )
            );
        }

        // wrong swap token A / B accounts
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            let user_transfer_key = Pubkey::new_unique();
            assert_eq!(
                Err(SwapError::IncorrectSwapAccount.into()),
                do_process_instruction(
                    swap(
                        &SWAP_PROGRAM_ID,
                        &token_a_program_id,
                        &token_b_program_id,
                        &pool_token_program_id,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &user_transfer_key,
                        &token_a_key,
                        &token_a_key,
                        &token_b_key,
                        &token_b_key,
                        &accounts.pool_mint_key,
                        &accounts.token_a_mint_key,
                        &accounts.token_b_mint_key,
                        Swap {
                            amount_in: initial_a,
                            minimum_amount_out: minimum_token_b_amount,
                        },
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut token_a_account.clone(),
                        &mut token_a_account,
                        &mut token_b_account.clone(),
                        &mut token_b_account,
                        &mut accounts.pool_mint_account,
                        &mut accounts.token_a_mint_account,
                        &mut accounts.token_b_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                ),
            );
        }

        // wrong user token A / B accounts
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            assert_eq!(
                Err(TokenError::MintMismatch.into()),
                accounts.swap(
                    &swapper_key,
                    &token_b_key,
                    &mut token_b_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &token_a_key,
                    &mut token_a_account,
                    initial_a,
                    minimum_token_b_amount,
                )
            );
        }

        // swap from a to a
        {
            let (
                token_a_key,
                mut token_a_account,
                _token_b_key,
                _token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.swap(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account.clone(),
                    &swap_token_a_key,
                    &swap_token_a_key,
                    &token_a_key,
                    &mut token_a_account,
                    initial_a,
                    minimum_token_b_amount,
                )
            );
        }

        // incorrect mint provided
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            let (pool_mint_key, pool_mint_account) = create_mint(
                &pool_token_program_id,
                &accounts.authority_key,
                None,
                None,
                &TransferFee::default(),
            );
            let old_pool_key = accounts.pool_mint_key;
            let old_pool_account = accounts.pool_mint_account;
            accounts.pool_mint_key = pool_mint_key;
            accounts.pool_mint_account = pool_mint_account;

            assert_eq!(
                Err(SwapError::IncorrectPoolMint.into()),
                accounts.swap(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &token_b_key,
                    &mut token_b_account,
                    initial_a,
                    minimum_token_b_amount,
                )
            );

            accounts.pool_mint_key = old_pool_key;
            accounts.pool_mint_account = old_pool_account;
        }

        // no approval
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            let user_transfer_key = Pubkey::new_unique();
            assert_eq!(
                Err(TokenError::OwnerMismatch.into()),
                do_process_instruction(
                    swap(
                        &SWAP_PROGRAM_ID,
                        &token_a_program_id,
                        &token_b_program_id,
                        &pool_token_program_id,
                        &accounts.swap_key,
                        &accounts.authority_key,
                        &user_transfer_key,
                        &token_a_key,
                        &accounts.token_a_key,
                        &accounts.token_b_key,
                        &token_b_key,
                        &accounts.pool_mint_key,
                        &accounts.token_a_mint_key,
                        &accounts.token_b_mint_key,
                        Swap {
                            amount_in: initial_a,
                            minimum_amount_out: minimum_token_b_amount,
                        },
                    )
                    .unwrap(),
                    vec![
                        &mut accounts.swap_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut token_a_account,
                        &mut accounts.token_a_account,
                        &mut accounts.token_b_account,
                        &mut token_b_account,
                        &mut accounts.pool_mint_account,
                        &mut accounts.token_a_mint_account,
                        &mut accounts.token_b_mint_account,
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                        &mut SolanaAccount::default(),
                    ],
                ),
            );
        }

        // output token value 0
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            assert_eq!(
                Err(SwapError::ZeroTradingTokens.into()),
                accounts.swap(
                    &swapper_key,
                    &token_b_key,
                    &mut token_b_account,
                    &swap_token_b_key,
                    &swap_token_a_key,
                    &token_a_key,
                    &mut token_a_account,
                    1,
                    1,
                )
            );
        }

        // slippage exceeded: minimum out amount too high
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            assert_eq!(
                Err(SwapError::ExceededSlippage.into()),
                accounts.swap(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &token_b_key,
                    &mut token_b_account,
                    initial_a,
                    minimum_token_b_amount * 2,
                )
            );
        }

        // invalid input: can't use swap pool as user source / dest
        {
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            let mut swap_token_a_account = accounts.get_token_account(&swap_token_a_key).clone();
            let authority_key = accounts.authority_key;
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.swap(
                    &authority_key,
                    &swap_token_a_key,
                    &mut swap_token_a_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &token_b_key,
                    &mut token_b_account,
                    initial_a,
                    minimum_token_b_amount,
                )
            );
            let mut swap_token_b_account = accounts.get_token_account(&swap_token_b_key).clone();
            assert_eq!(
                Err(SwapError::InvalidInput.into()),
                accounts.swap(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account,
                    &swap_token_a_key,
                    &swap_token_b_key,
                    &swap_token_b_key,
                    &mut swap_token_b_account,
                    initial_a,
                    minimum_token_b_amount,
                )
            );
        }

        // still correct: constraint specified, no host fee account
        {
            let authority_key = accounts.authority_key;
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                _pool_key,
                _pool_account,
            ) = accounts.setup_token_accounts(&user_key, &authority_key, initial_a, initial_b, 0);
            let fees = Fees {
                trade_fee_numerator,
                trade_fee_denominator,
                owner_trade_fee_numerator,
                owner_trade_fee_denominator,
                owner_withdraw_fee_numerator,
                owner_withdraw_fee_denominator,
                host_fee_numerator,
                host_fee_denominator,
            };
            let constraints = Some(SwapConstraints {
                valid_curve_types: &[],
                fees: &fees,
            });
            do_process_instruction_with_fee_constraints(
                swap(
                    &SWAP_PROGRAM_ID,
                    &token_a_program_id,
                    &token_b_program_id,
                    &pool_token_program_id,
                    &accounts.swap_key,
                    &accounts.authority_key,
                    &accounts.authority_key,
                    &token_a_key,
                    &accounts.token_a_key,
                    &accounts.token_b_key,
                    &token_b_key,
                    &accounts.pool_mint_key,
                    &accounts.token_a_mint_key,
                    &accounts.token_b_mint_key,
                    Swap {
                        amount_in: initial_a,
                        minimum_amount_out: minimum_token_b_amount,
                    },
                )
                .unwrap(),
                vec![
                    &mut accounts.swap_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    &mut token_a_account,
                    &mut accounts.token_a_account,
                    &mut accounts.token_b_account,
                    &mut token_b_account,
                    &mut accounts.pool_mint_account,
                    &mut accounts.token_a_mint_account,
                    &mut accounts.token_b_mint_account,
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                    &mut SolanaAccount::default(),
                ],
                &constraints,
            )
            .unwrap();
        }

        // "invalid mint for host fee account" deleted: the
        // host-fee machinery and its optional trailing account no longer
        // exist — production pins host_fee to 0/0, so it shipped dead.
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_overdraw_offset_curve(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 10;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 30;
        let owner_withdraw_fee_numerator = 1;
        let owner_withdraw_fee_denominator = 30;
        let host_fee_numerator = 10;
        let host_fee_denominator = 100;

        let token_a_amount = 1_000_000_000;
        let token_b_amount = 0;
        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_b_offset = 2_000_000;
        let swap_curve = SwapCurve {
            curve_type: CurveType::Offset,
            calculator: Arc::new(OffsetCurve { token_b_offset }),
        };
        let user_key = Pubkey::new_unique();
        let swapper_key = Pubkey::new_unique();

        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        accounts.initialize_swap().unwrap();

        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;
        let initial_a = 500_000;
        let initial_b = 1_000;

        let (
            token_a_key,
            mut token_a_account,
            token_b_key,
            mut token_b_account,
            _pool_key,
            _pool_account,
        ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);

        // swap a to b way, fails, there's no liquidity
        let a_to_b_amount = initial_a;
        let minimum_token_b_amount = 0;

        assert_eq!(
            Err(SwapError::ZeroTradingTokens.into()),
            accounts.swap(
                &swapper_key,
                &token_a_key,
                &mut token_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &token_b_key,
                &mut token_b_account,
                a_to_b_amount,
                minimum_token_b_amount,
            )
        );

        // swap b to a, succeeds at offset price
        let b_to_a_amount = initial_b;
        let minimum_token_a_amount = 0;
        accounts
            .swap(
                &swapper_key,
                &token_b_key,
                &mut token_b_account,
                &swap_token_b_key,
                &swap_token_a_key,
                &token_a_key,
                &mut token_a_account,
                b_to_a_amount,
                minimum_token_a_amount,
            )
            .unwrap();

        // try a to b again, succeeds due to new liquidity
        accounts
            .swap(
                &swapper_key,
                &token_a_key,
                &mut token_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &token_b_key,
                &mut token_b_account,
                a_to_b_amount,
                minimum_token_b_amount,
            )
            .unwrap();

        // try a to b again, fails due to no more liquidity
        assert_eq!(
            Err(SwapError::ZeroTradingTokens.into()),
            accounts.swap(
                &swapper_key,
                &token_a_key,
                &mut token_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &token_b_key,
                &mut token_b_account,
                a_to_b_amount,
                minimum_token_b_amount,
            )
        );

        // Try to deposit, fails because deposits are not allowed for offset
        // curve swaps
        {
            let initial_a = 100;
            let initial_b = 100;
            let pool_amount = 100;
            let (
                token_a_key,
                mut token_a_account,
                token_b_key,
                mut token_b_account,
                pool_key,
                mut pool_account,
            ) = accounts.setup_token_accounts(&user_key, &swapper_key, initial_a, initial_b, 0);
            assert_eq!(
                Err(SwapError::UnsupportedCurveOperation.into()),
                accounts.deposit_all_token_types(
                    &swapper_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    pool_amount,
                    initial_a,
                    initial_b,
                )
            );
        }
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_withdraw_all_offset_curve(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 10;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 30;
        let owner_withdraw_fee_numerator = 0;
        let owner_withdraw_fee_denominator = 30;
        let host_fee_numerator = 10;
        let host_fee_denominator = 100;

        let token_a_amount = 1_000_000_000;
        let token_b_amount = 10;
        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_b_offset = 2_000_000;
        let swap_curve = SwapCurve {
            curve_type: CurveType::Offset,
            calculator: Arc::new(OffsetCurve { token_b_offset }),
        };
        let total_pool = swap_curve.calculator.new_pool_supply();
        let user_key = Pubkey::new_unique();
        let withdrawer_key = Pubkey::new_unique();

        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        accounts.initialize_swap().unwrap();

        let (
            token_a_key,
            mut token_a_account,
            token_b_key,
            mut token_b_account,
            _pool_key,
            _pool_account,
        ) = accounts.setup_token_accounts(&user_key, &withdrawer_key, 0, 0, 0);

        let pool_key = accounts.pool_token_key;
        let mut pool_account = accounts.pool_token_account.clone();

        // WithdrawAllTokenTypes takes all tokens for A and B.
        // The curve's calculation for token B will say to transfer
        // `token_b_offset + token_b_amount`, but only `token_b_amount` will be
        // moved.
        accounts
            .withdraw_all_token_types(
                &user_key,
                &pool_key,
                &mut pool_account,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                total_pool.try_into().unwrap(),
                0,
                0,
            )
            .unwrap();

        let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
        assert_eq!(token_a.base.amount, token_a_amount);
        let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
        assert_eq!(token_b.base.amount, token_b_amount);
        let swap_token_a =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
        assert_eq!(swap_token_a.base.amount, 0);
        let swap_token_b =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
        assert_eq!(swap_token_b.base.amount, 0);
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_withdraw_all_constant_price_curve(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 10;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 30;
        let owner_withdraw_fee_numerator = 0;
        let owner_withdraw_fee_denominator = 30;
        let host_fee_numerator = 10;
        let host_fee_denominator = 100;

        // initialize "unbalanced", so that withdrawing all will have some issues
        // A: 1_000_000_000
        // B: 2_000_000_000 (1_000 * 2_000_000)
        let swap_token_a_amount = 1_000_000_000;
        let swap_token_b_amount = 1_000;
        let token_b_price = 2_000_000;
        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let swap_curve = SwapCurve {
            curve_type: CurveType::ConstantPrice,
            calculator: Arc::new(ConstantPriceCurve { token_b_price }),
        };
        let total_pool = swap_curve.calculator.new_pool_supply();
        let user_key = Pubkey::new_unique();
        let withdrawer_key = Pubkey::new_unique();

        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            swap_token_a_amount,
            swap_token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        accounts.initialize_swap().unwrap();

        let (
            token_a_key,
            mut token_a_account,
            token_b_key,
            mut token_b_account,
            _pool_key,
            _pool_account,
        ) = accounts.setup_token_accounts(&user_key, &withdrawer_key, 0, 0, 0);

        let pool_key = accounts.pool_token_key;
        let mut pool_account = accounts.pool_token_account.clone();

        // WithdrawAllTokenTypes will not take all token A and B, since their
        // ratio is unbalanced.  It will try to take 1_500_000_000 worth of
        // each token, which means 1_500_000_000 token A, and 750 token B.
        // With no slippage, this will leave 250 token B in the pool.
        assert_eq!(
            Err(SwapError::ExceededSlippage.into()),
            accounts.withdraw_all_token_types(
                &user_key,
                &pool_key,
                &mut pool_account,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                total_pool.try_into().unwrap(),
                swap_token_a_amount,
                swap_token_b_amount,
            )
        );

        accounts
            .withdraw_all_token_types(
                &user_key,
                &pool_key,
                &mut pool_account,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                total_pool.try_into().unwrap(),
                0,
                0,
            )
            .unwrap();

        let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
        assert_eq!(token_a.base.amount, swap_token_a_amount);
        let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
        assert_eq!(token_b.base.amount, 750);
        let swap_token_a =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
        assert_eq!(swap_token_a.base.amount, 0);
        let swap_token_b =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
        assert_eq!(swap_token_b.base.amount, 250);

        // deposit now, not enough to cover the tokens already in there
        let token_b_amount = 10;
        let token_a_amount = token_b_amount * token_b_price;
        let (
            token_a_key,
            mut token_a_account,
            token_b_key,
            mut token_b_account,
            pool_key,
            mut pool_account,
        ) = accounts.setup_token_accounts(
            &user_key,
            &withdrawer_key,
            token_a_amount,
            token_b_amount,
            0,
        );

        assert_eq!(
            Err(SwapError::ExceededSlippage.into()),
            accounts.deposit_all_token_types(
                &withdrawer_key,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                &pool_key,
                &mut pool_account,
                1, // doesn't matter
                token_a_amount,
                token_b_amount,
            )
        );

        // deposit enough tokens, success!
        let token_b_amount = 125;
        let token_a_amount = token_b_amount * token_b_price;
        let (
            token_a_key,
            mut token_a_account,
            token_b_key,
            mut token_b_account,
            pool_key,
            mut pool_account,
        ) = accounts.setup_token_accounts(
            &user_key,
            &withdrawer_key,
            token_a_amount,
            token_b_amount,
            0,
        );

        accounts
            .deposit_all_token_types(
                &withdrawer_key,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                &pool_key,
                &mut pool_account,
                1, // doesn't matter
                token_a_amount,
                token_b_amount,
            )
            .unwrap();
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_deposits_allowed_single_token(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 10;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 30;
        let owner_withdraw_fee_numerator = 0;
        let owner_withdraw_fee_denominator = 30;
        let host_fee_numerator = 10;
        let host_fee_denominator = 100;

        let token_a_amount = 1_000_000;
        let token_b_amount = 0;
        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_b_offset = 2_000_000;
        let swap_curve = SwapCurve {
            curve_type: CurveType::Offset,
            calculator: Arc::new(OffsetCurve { token_b_offset }),
        };
        let creator_key = Pubkey::new_unique();
        let depositor_key = Pubkey::new_unique();

        let mut accounts = SwapAccountInfo::new(
            &creator_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );

        accounts.initialize_swap().unwrap();

        let initial_a = 1_000_000;
        let initial_b = 2_000_000;
        let (
            _depositor_token_a_key,
            _depositor_token_a_account,
            depositor_token_b_key,
            mut depositor_token_b_account,
            depositor_pool_key,
            mut depositor_pool_account,
        ) = accounts.setup_token_accounts(&creator_key, &depositor_key, initial_a, initial_b, 0);

        assert_eq!(
            Err(SwapError::UnsupportedCurveOperation.into()),
            accounts.deposit_single_token_type_exact_amount_in(
                &depositor_key,
                &depositor_token_b_key,
                &mut depositor_token_b_account,
                &depositor_pool_key,
                &mut depositor_pool_account,
                initial_b,
                0,
            )
        );
    }

    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_swap_curve_with_transfer_fees(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        // All fees
        let trade_fee_numerator = 1;
        let trade_fee_denominator = 10;
        let owner_trade_fee_numerator = 1;
        let owner_trade_fee_denominator = 30;
        let owner_withdraw_fee_numerator = 1;
        let owner_withdraw_fee_denominator = 30;
        let host_fee_numerator = 20;
        let host_fee_denominator = 100;
        let fees = Fees {
            trade_fee_numerator,
            trade_fee_denominator,
            owner_trade_fee_numerator,
            owner_trade_fee_denominator,
            owner_withdraw_fee_numerator,
            owner_withdraw_fee_denominator,
            host_fee_numerator,
            host_fee_denominator,
        };

        let token_a_amount = 10_000_000_000;
        let token_b_amount = 50_000_000_000;

        check_valid_swap_curve(
            fees,
            SwapTransferFees {
                pool_token: TransferFee::default(),
                token_a: TransferFee {
                    epoch: 0.into(),
                    transfer_fee_basis_points: 100.into(),
                    maximum_fee: 1_000_000_000.into(),
                },
                token_b: TransferFee::default(),
            },
            CurveType::ConstantProduct,
            Arc::new(ConstantProductCurve {}),
            token_a_amount,
            token_b_amount,
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );
    }

    #[test]
    fn test_valid_swap_exact_out() {
        let user_key = Pubkey::new_unique();
        let swapper_key = Pubkey::new_unique();
        let token_a_amount = 100_000;
        let token_b_amount = 100_000;
        let fees = Fees::default();
        let pid = spl_token::id();
        let curve = SwapCurve {
            curve_type: CurveType::ConstantProduct,
            calculator: Arc::new(ConstantProductCurve {}),
        };
        let amount_out = 1_000u64;
        let expected = curve
            .swap_for_exact_out(
                amount_out.into(),
                token_a_amount.into(),
                token_b_amount.into(),
                TradeDirection::AtoB,
                &fees,
            )
            .unwrap();
        let expected_in = to_u64(expected.source_amount_swapped).unwrap();

        // ---- happy path: swapper receives EXACTLY amount_out ----
        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees.clone(),
            SwapTransferFees {
                pool_token: TransferFee::default(),
                token_a: TransferFee::default(),
                token_b: TransferFee::default(),
            },
            curve.clone(),
            token_a_amount,
            token_b_amount,
            &pid,
            &pid,
            &pid,
        );
        accounts.initialize_swap().unwrap();
        let swap_a = accounts.token_a_key;
        let swap_b = accounts.token_b_key;
        let (a_key, mut a_acct, b_key, mut b_acct, _p, _pa) =
            accounts.setup_token_accounts(&user_key, &swapper_key, 10_000, 0, 0);

        accounts
            .swap_exact_out(
                &swapper_key,
                &a_key,
                &mut a_acct,
                &swap_a,
                &swap_b,
                &b_key,
                &mut b_acct,
                amount_out,
                expected_in, // generous cap == exact required input
            )
            .unwrap();

        // exact output delivered
        let ub = StateWithExtensions::<Account>::unpack(&b_acct.data).unwrap();
        assert_eq!(ub.base.amount, amount_out);
        // exactly the required input paid
        let ua = StateWithExtensions::<Account>::unpack(&a_acct.data).unwrap();
        assert_eq!(ua.base.amount, 10_000 - expected_in);
        // pool reserves match the curve result
        let pa = StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
        assert_eq!(u128::from(pa.base.amount), expected.new_swap_source_amount);
        let pb = StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
        assert_eq!(u128::from(pb.base.amount), expected.new_swap_destination_amount);

        // ---- slippage guard: a max_in below the required input reverts ----
        let mut accounts2 = SwapAccountInfo::new(
            &user_key,
            fees.clone(),
            SwapTransferFees {
                pool_token: TransferFee::default(),
                token_a: TransferFee::default(),
                token_b: TransferFee::default(),
            },
            curve,
            token_a_amount,
            token_b_amount,
            &pid,
            &pid,
            &pid,
        );
        accounts2.initialize_swap().unwrap();
        let swap_a2 = accounts2.token_a_key;
        let swap_b2 = accounts2.token_b_key;
        let (a2, mut a2_acct, b2, mut b2_acct, _p2, _pa2) =
            accounts2.setup_token_accounts(&user_key, &swapper_key, 10_000, 0, 0);
        let err = accounts2
            .swap_exact_out(
                &swapper_key,
                &a2,
                &mut a2_acct,
                &swap_a2,
                &swap_b2,
                &b2,
                &mut b2_acct,
                amount_out,
                expected_in - 1, // too low
            )
            .unwrap_err();
        assert_eq!(err, SwapError::ExceededSlippage.into());
    }

    // -----------------------------------------------------------------------
    // The fee-owner rework: CreatePool (tag 7)
    // test-truth. R1-R10 below are RED-FIRST per the design plan — each
    // has a named expected error at HEAD (before the stub/helper work lands)
    // and a named mutant that must flip it red again later.
    // -----------------------------------------------------------------------

    /// Builds a tag-7 `CreatePool` instruction. Metas match
    /// `process_create_pool`'s account order exactly: payer(w+s), pool(w),
    /// authority(r), mint_a(r), mint_b(r), vault_a(w), vault_b(w),
    /// lp_mint(w), dest(w), token_program(r), system(r). 11 accounts — no
    /// fee slot (D6: the cp_fee LP account no longer exists).
    #[allow(clippy::too_many_arguments)]
    /// `config` is appended at index 11, readonly — indices 0-10
    /// are untouched from the pre-v2 shape.
    #[allow(clippy::too_many_arguments)]
    fn create_pool_ix(
        payer: &Pubkey,
        pool: &Pubkey,
        authority: &Pubkey,
        mint_a: &Pubkey,
        mint_b: &Pubkey,
        vault_a: &Pubkey,
        vault_b: &Pubkey,
        lp_mint: &Pubkey,
        dest: &Pubkey,
        token_program_id: &Pubkey,
        fee_bps: u16,
        pool_bump: u8,
        lp_bump: u8,
        fees: Fees,
        swap_curve: SwapCurve,
        config: &Pubkey,
    ) -> Instruction {
        let data = SwapInstruction::CreatePool(CreatePool {
            fees,
            swap_curve,
            fee_bps,
            pool_bump,
            lp_bump,
        })
        .pack();
        let accounts = vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*pool, false),
            AccountMeta::new_readonly(*authority, false),
            AccountMeta::new_readonly(*mint_a, false),
            AccountMeta::new_readonly(*mint_b, false),
            AccountMeta::new(*vault_a, false),
            AccountMeta::new(*vault_b, false),
            AccountMeta::new(*lp_mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*token_program_id, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(*config, false),
        ];
        Instruction {
            program_id: SWAP_PROGRAM_ID,
            accounts,
            data,
        }
    }

    /// Real-tier fees, matching `constraints::production_tests::tier` (not
    /// reachable from this module — duplicated here at test scope): trade_num
    /// and owner_num over a fixed 10000 denominator, zero withdraw/host fee.
    fn tier_fees(trade_num: u64, owner_num: u64) -> Fees {
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

    /// A minimal tag-7 fixture: two funded mints (their own token programs,
    /// mirroring `SwapAccountInfo::new`'s 4 combos) + vaults owned by the pool
    /// authority, a funded payer, and system-owned zero-lamport shells for
    /// pool/lp_mint/fee/dest sized exactly per the program's own space
    /// constants (the pre-sizing contract) — never hardcoded numbers.
    struct CreatePoolFixture {
        payer_key: Pubkey,
        payer_account: SolanaAccount,
        pool_key: Pubkey,
        pool_account: SolanaAccount,
        authority_key: Pubkey,
        mint_a_key: Pubkey,
        mint_a_account: SolanaAccount,
        mint_b_key: Pubkey,
        mint_b_account: SolanaAccount,
        vault_a_key: Pubkey,
        vault_a_account: SolanaAccount,
        vault_b_key: Pubkey,
        vault_b_account: SolanaAccount,
        lp_mint_key: Pubkey,
        lp_mint_account: SolanaAccount,
        dest_key: Pubkey,
        dest_account: SolanaAccount,
        pool_token_program_id: Pubkey,
        fee_bps: u16,
        pool_bump: u8,
        lp_bump: u8,
        fees: Fees,
        swap_curve: SwapCurve,
        // Real, already-initialized config (mode 1).
        config_key: Pubkey,
        config_account: SolanaAccount,
        admin_key: Pubkey,
        treasury_key: Pubkey,
    }

    impl CreatePoolFixture {
        #[allow(clippy::too_many_arguments)]
        fn new(
            pool_token_program_id: &Pubkey,
            token_a_program_id: &Pubkey,
            token_b_program_id: &Pubkey,
            token_a_amount: u64,
            token_b_amount: u64,
            fee_bps: u16,
            fees: Fees,
            swap_curve: SwapCurve,
        ) -> Self {
            let payer_key = Pubkey::new_unique();
            let mut payer_account = SolanaAccount::new(10_000_000_000, 0, &system_program::id());

            let admin_key = Pubkey::new_unique();
            let treasury_key = Pubkey::new_unique();
            let mut config_fixture = ConfigFixture::new();
            config_fixture
                .init_config(
                    &payer_key,
                    &mut payer_account,
                    admin_key,
                    treasury_key,
                    MODE_PERMISSIONLESS,
                )
                .unwrap();
            let config_key = config_fixture.config_key;
            let config_account = config_fixture.config_account;

            let (mint_a_key, mut mint_a_account) =
                create_mint(token_a_program_id, &payer_key, None, None, &TransferFee::default());
            let (mint_b_key, mut mint_b_account) =
                create_mint(token_b_program_id, &payer_key, None, None, &TransferFee::default());

            let (pool_key, pool_bump) = Pubkey::find_program_address(
                &[
                    b"cp_pool",
                    mint_a_key.as_ref(),
                    mint_b_key.as_ref(),
                    &fee_bps.to_le_bytes(),
                ],
                &SWAP_PROGRAM_ID,
            );
            let (authority_key, _bump) =
                Pubkey::find_program_address(&[pool_key.as_ref()], &SWAP_PROGRAM_ID);
            let (lp_mint_key, lp_bump) =
                Pubkey::find_program_address(&[b"cp_lp", pool_key.as_ref()], &SWAP_PROGRAM_ID);
            let (dest_key, _dest_bump) =
                Pubkey::find_program_address(&[b"cp_dest", pool_key.as_ref()], &SWAP_PROGRAM_ID);

            let pool_account = SolanaAccount::new(0, SwapVersion::LATEST_LEN, &system_program::id());
            let lp_mint_account = SolanaAccount::new(0, Mint::LEN, &system_program::id());
            let dest_account = SolanaAccount::new(0, Account::LEN, &system_program::id());

            let (vault_a_key, vault_a_account) = mint_token(
                token_a_program_id,
                &mint_a_key,
                &mut mint_a_account,
                &payer_key,
                &authority_key,
                token_a_amount,
            );
            let (vault_b_key, vault_b_account) = mint_token(
                token_b_program_id,
                &mint_b_key,
                &mut mint_b_account,
                &payer_key,
                &authority_key,
                token_b_amount,
            );

            CreatePoolFixture {
                payer_key,
                payer_account,
                pool_key,
                pool_account,
                authority_key,
                mint_a_key,
                mint_a_account,
                mint_b_key,
                mint_b_account,
                vault_a_key,
                vault_a_account,
                vault_b_key,
                vault_b_account,
                lp_mint_key,
                lp_mint_account,
                dest_key,
                dest_account,
                pool_token_program_id: *pool_token_program_id,
                fee_bps,
                pool_bump,
                lp_bump,
                fees,
                swap_curve,
                config_key,
                config_account,
                admin_key,
                treasury_key,
            }
        }
    }

    /// Runs the fixture's CreatePool instruction through
    /// `do_process_instruction_with_fee_constraints`, so callers choose the
    /// constraint set explicitly (the behavior-lane split) instead of
    /// picking up whatever `SWAP_CONSTRAINTS` the build happens to compile in.
    /// Mutations are written back into `fixture`'s own account fields on
    /// success (same clone-and-copy-back semantics as every other test here),
    /// so callers can assert on `fixture.pool_account` etc. afterward.
    fn run_create_pool(
        fixture: &mut CreatePoolFixture,
        constraints: &Option<SwapConstraints>,
    ) -> ProgramResult {
        let ix = create_pool_ix(
            &fixture.payer_key,
            &fixture.pool_key,
            &fixture.authority_key,
            &fixture.mint_a_key,
            &fixture.mint_b_key,
            &fixture.vault_a_key,
            &fixture.vault_b_key,
            &fixture.lp_mint_key,
            &fixture.dest_key,
            &fixture.pool_token_program_id,
            fixture.fee_bps,
            fixture.pool_bump,
            fixture.lp_bump,
            fixture.fees.clone(),
            fixture.swap_curve.clone(),
            &fixture.config_key,
        );
        let mut authority_dummy = SolanaAccount::default();
        let mut mint_a_dummy = fixture.mint_a_account.clone();
        let mut mint_b_dummy = fixture.mint_b_account.clone();
        let mut token_program_dummy = SolanaAccount::default();
        let mut system_program_dummy = SolanaAccount::default();
        do_process_instruction_with_fee_constraints(
            ix,
            vec![
                &mut fixture.payer_account,
                &mut fixture.pool_account,
                &mut authority_dummy,
                &mut mint_a_dummy,
                &mut mint_b_dummy,
                &mut fixture.vault_a_account,
                &mut fixture.vault_b_account,
                &mut fixture.lp_mint_account,
                &mut fixture.dest_account,
                &mut token_program_dummy,
                &mut system_program_dummy,
                &mut fixture.config_account,
            ],
            constraints,
        )
    }

    /// The behavior-lane fixture used by R1-R7 and the two green-at-HEAD
    /// guards: arbitrary (non-tier) fees, ConstantProduct curve, fee_bps
    /// derived from those fees per the reference formula (unbound at HEAD — pure PDA
    /// seed material; Phase 2 item 8 binds it).
    fn behavior_fixture(
        pool_token_program_id: &Pubkey,
        token_a_program_id: &Pubkey,
        token_b_program_id: &Pubkey,
    ) -> CreatePoolFixture {
        let fees = Fees {
            trade_fee_numerator: 1,
            trade_fee_denominator: 2,
            owner_trade_fee_numerator: 1,
            owner_trade_fee_denominator: 10,
            owner_withdraw_fee_numerator: 1,
            owner_withdraw_fee_denominator: 5,
            host_fee_numerator: 20,
            host_fee_denominator: 100,
        };
        let swap_curve = SwapCurve {
            curve_type: CurveType::ConstantProduct,
            calculator: Arc::new(ConstantProductCurve {}),
        };
        let fee_bps = (10000 / 2 + 10000 / 10) as u16; // 6000, per the reference formula
        CreatePoolFixture::new(
            pool_token_program_id,
            token_a_program_id,
            token_b_program_id,
            1_000_000,
            2_000_000,
            fee_bps,
            fees,
            swap_curve,
        )
    }

    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_create_pool_success(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        let mut fx = behavior_fixture(
            &pool_token_program_id,
            &token_a_program_id,
            &token_b_program_id,
        );
        let payer_before = fx.payer_account.lamports;

        // R1: at HEAD this dies with UnsupportedSysvar — Rent::get()
        // (processor.rs :466) runs before any CPI, and the default
        // sol_get_rent_sysvar stub is unimplemented. Any OTHER error here
        // means the plan's model of HEAD is wrong.
        run_create_pool(&mut fx, &None).unwrap();

        // ---- Anti-decorative assertions (only reached once green) ----
        let swap_state = SwapVersion::unpack(&fx.pool_account.data).unwrap();
        assert!(swap_state.is_initialized());
        // `bump_seed()` is the AUTHORITY PDA's bump (`find_program_address([pool])`,
        // matched independently here), not the pool PDA's own bump.
        let (_, expected_authority_bump) =
            Pubkey::find_program_address(&[fx.pool_key.as_ref()], &SWAP_PROGRAM_ID);
        assert_eq!(swap_state.bump_seed(), expected_authority_bump);
        assert_eq!(*swap_state.token_a_account(), fx.vault_a_key);
        assert_eq!(*swap_state.token_b_account(), fx.vault_b_key);
        // State fields equal INDEPENDENTLY re-derived PDAs, not just whatever
        // key the fixture happened to hold (catches M6-style mis-derivation).
        let (expected_lp, _) =
            Pubkey::find_program_address(&[b"cp_lp", fx.pool_key.as_ref()], &SWAP_PROGRAM_ID);
        assert_eq!(*swap_state.pool_mint(), expected_lp);
        assert_eq!(swap_state.pool_mint(), &fx.lp_mint_key);
        // No fee LP account exists (D6) — protocol fees are counters,
        // structurally zero at creation (the EXEMPT site).
        assert_eq!(swap_state.protocol_fees_a(), 0);
        assert_eq!(swap_state.protocol_fees_b(), 0);

        // Destination holds the initial LP supply, owned by the PAYER.
        let dest = StateWithExtensions::<Account>::unpack(&fx.dest_account.data).unwrap();
        assert_eq!(dest.base.owner, fx.payer_key);
        assert!(dest.base.amount > 0);
        let lp_mint = StateWithExtensions::<Mint>::unpack(&fx.lp_mint_account.data).unwrap();
        assert_eq!(lp_mint.base.supply, dest.base.amount);

        // Account owners: program / token-program / token-program.
        assert_eq!(fx.pool_account.owner, SWAP_PROGRAM_ID);
        assert_eq!(fx.lp_mint_account.owner, pool_token_program_id);
        assert_eq!(fx.dest_account.owner, pool_token_program_id);

        // Lamport conservation: payer lost exactly the rent for the 3
        // accounts it funded (computed via Rent::default()).
        let rent = Rent::default();
        let expected_spend = rent.minimum_balance(SwapVersion::LATEST_LEN)
            + rent.minimum_balance(Mint::LEN)
            + rent.minimum_balance(Account::LEN);
        assert_eq!(payer_before - fx.payer_account.lamports, expected_spend);
        assert_eq!(fx.pool_account.lamports, rent.minimum_balance(SwapVersion::LATEST_LEN));
        assert_eq!(fx.lp_mint_account.lamports, rent.minimum_balance(Mint::LEN));
        assert_eq!(fx.dest_account.lamports, rent.minimum_balance(Account::LEN));
    }

    /// Ported to the tag-7 lane: the constructable subset of
    /// the now-deleted `test_initialize`'s validation surface — the vault
    /// (token_a/token_b)-shaped cases, which the CALLER still supplies to
    /// CreatePool. The pool-mint/fee/dest substitution surface is NOT
    /// ported: CreatePool creates those three accounts itself
    /// (`process_create_pool` :486-561), so a caller can never hand it a
    /// bad one — unconstructable through tag 7 by construction.
    #[test_case(spl_token::id(), spl_token::id(), spl_token::id(); "all-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token_2022::id(); "all-token-2022")]
    #[test_case(spl_token::id(), spl_token_2022::id(), spl_token_2022::id(); "mixed-pool-token")]
    #[test_case(spl_token_2022::id(), spl_token_2022::id(), spl_token::id(); "mixed-pool-token-2022")]
    fn test_create_pool_input_validation(
        pool_token_program_id: Pubkey,
        token_a_program_id: Pubkey,
        token_b_program_id: Pubkey,
    ) {
        // uninitialized vault A / B -> ExpectedAccount
        for side_a in [true, false] {
            let mut fx = behavior_fixture(&pool_token_program_id, &token_a_program_id, &token_b_program_id);
            let program_id = if side_a { token_a_program_id } else { token_b_program_id };
            let empty = SolanaAccount::new(0, 0, &program_id);
            if side_a {
                fx.vault_a_account = empty;
            } else {
                fx.vault_b_account = empty;
            }
            let err = run_create_pool(&mut fx, &None).unwrap_err();
            assert_eq!(err, SwapError::ExpectedAccount.into());
        }

        // vault A / B owner is not the pool authority -> InvalidOwner
        for side_a in [true, false] {
            let mut fx = behavior_fixture(&pool_token_program_id, &token_a_program_id, &token_b_program_id);
            if side_a {
                let (_key, account) = mint_token(
                    &token_a_program_id,
                    &fx.mint_a_key,
                    &mut fx.mint_a_account,
                    &fx.payer_key,
                    &fx.payer_key,
                    0,
                );
                fx.vault_a_account = account;
            } else {
                let (_key, account) = mint_token(
                    &token_b_program_id,
                    &fx.mint_b_key,
                    &mut fx.mint_b_account,
                    &fx.payer_key,
                    &fx.payer_key,
                    0,
                );
                fx.vault_b_account = account;
            }
            let err = run_create_pool(&mut fx, &None).unwrap_err();
            assert_eq!(err, SwapError::InvalidOwner.into());
        }

        // vault A / B owned by wrong token program -> IncorrectTokenProgramId
        for side_a in [true, false] {
            let mut fx = behavior_fixture(&pool_token_program_id, &token_a_program_id, &token_b_program_id);
            if side_a {
                let (_key, mut account) = mint_token(
                    &token_a_program_id,
                    &fx.mint_a_key,
                    &mut fx.mint_a_account,
                    &fx.payer_key,
                    &fx.authority_key,
                    1_000_000,
                );
                account.owner = SWAP_PROGRAM_ID;
                fx.vault_a_account = account;
            } else {
                let (_key, mut account) = mint_token(
                    &token_b_program_id,
                    &fx.mint_b_key,
                    &mut fx.mint_b_account,
                    &fx.payer_key,
                    &fx.authority_key,
                    2_000_000,
                );
                account.owner = SWAP_PROGRAM_ID;
                fx.vault_b_account = account;
            }
            let err = run_create_pool(&mut fx, &None).unwrap_err();
            assert_eq!(err, SwapError::IncorrectTokenProgramId.into());
        }

        // vault A / B is delegated -> InvalidDelegate
        for side_a in [true, false] {
            let mut fx = behavior_fixture(&pool_token_program_id, &token_a_program_id, &token_b_program_id);
            if side_a {
                do_process_instruction(
                    approve(&token_a_program_id, &fx.vault_a_key, &fx.payer_key, &fx.authority_key, &[], 1)
                        .unwrap(),
                    vec![&mut fx.vault_a_account, &mut SolanaAccount::default(), &mut SolanaAccount::default()],
                )
                .unwrap();
            } else {
                do_process_instruction(
                    approve(&token_b_program_id, &fx.vault_b_key, &fx.payer_key, &fx.authority_key, &[], 1)
                        .unwrap(),
                    vec![&mut fx.vault_b_account, &mut SolanaAccount::default(), &mut SolanaAccount::default()],
                )
                .unwrap();
            }
            let err = run_create_pool(&mut fx, &None).unwrap_err();
            assert_eq!(err, SwapError::InvalidDelegate.into());
        }

        // vault A / B has a close authority -> InvalidCloseAuthority
        for side_a in [true, false] {
            let mut fx = behavior_fixture(&pool_token_program_id, &token_a_program_id, &token_b_program_id);
            if side_a {
                do_process_instruction(
                    set_authority(
                        &token_a_program_id,
                        &fx.vault_a_key,
                        Some(&fx.payer_key),
                        AuthorityType::CloseAccount,
                        &fx.authority_key,
                        &[],
                    )
                    .unwrap(),
                    vec![&mut fx.vault_a_account, &mut SolanaAccount::default()],
                )
                .unwrap();
            } else {
                do_process_instruction(
                    set_authority(
                        &token_b_program_id,
                        &fx.vault_b_key,
                        Some(&fx.payer_key),
                        AuthorityType::CloseAccount,
                        &fx.authority_key,
                        &[],
                    )
                    .unwrap(),
                    vec![&mut fx.vault_b_account, &mut SolanaAccount::default()],
                )
                .unwrap();
            }
            let err = run_create_pool(&mut fx, &None).unwrap_err();
            assert_eq!(err, SwapError::InvalidCloseAuthority.into());
        }

        // vault A and vault B hold the SAME mint -> RepeatedMint
        {
            let mut fx = behavior_fixture(&pool_token_program_id, &token_a_program_id, &token_b_program_id);
            let (_key, repeat_account) = mint_token(
                &token_a_program_id,
                &fx.mint_a_key,
                &mut fx.mint_a_account,
                &fx.payer_key,
                &fx.authority_key,
                10,
            );
            fx.vault_b_account = repeat_account;
            let err = run_create_pool(&mut fx, &None).unwrap_err();
            assert_eq!(err, SwapError::RepeatedMint.into());
        }

        // wrong pool-token-program id on the ix -> IncorrectProgramId (the
        // CPI dispatch refusal, ported from test_initialize's "wrong token
        // program id" block — there the substituted program sat on the
        // (deleted) Initialize ix; here it sits on CreatePool's own
        // `initialize_mint2`/`initialize_account3` CPIs).
        {
            let mut fx = behavior_fixture(&pool_token_program_id, &token_a_program_id, &token_b_program_id);
            let wrong_program_id = Pubkey::new_unique();
            let ix = create_pool_ix(
                &fx.payer_key,
                &fx.pool_key,
                &fx.authority_key,
                &fx.mint_a_key,
                &fx.mint_b_key,
                &fx.vault_a_key,
                &fx.vault_b_key,
                &fx.lp_mint_key,
                &fx.dest_key,
                &wrong_program_id,
                fx.fee_bps,
                fx.pool_bump,
                fx.lp_bump,
                fx.fees.clone(),
                fx.swap_curve.clone(),
                &fx.config_key,
            );
            let mut authority_dummy = SolanaAccount::default();
            let mut mint_a_dummy = fx.mint_a_account.clone();
            let mut mint_b_dummy = fx.mint_b_account.clone();
            let mut token_program_dummy = SolanaAccount::default();
            let mut system_program_dummy = SolanaAccount::default();
            let err = do_process_instruction_with_fee_constraints(
                ix,
                vec![
                    &mut fx.payer_account,
                    &mut fx.pool_account,
                    &mut authority_dummy,
                    &mut mint_a_dummy,
                    &mut mint_b_dummy,
                    &mut fx.vault_a_account,
                    &mut fx.vault_b_account,
                    &mut fx.lp_mint_account,
                    &mut fx.dest_account,
                    &mut token_program_dummy,
                    &mut system_program_dummy,
                    &mut fx.config_account,
                ],
                &None,
            )
            .unwrap_err();
            assert_eq!(err, ProgramError::IncorrectProgramId);
        }
    }

    /// Ported to the tag-7 lane: invalid curve parameters,
    /// default lane (no compiled-in constraints — `swap_curve.calculator
    /// .validate()` is the curve's OWN self-check, independent of
    /// `SwapConstraints::validate_curve`). fee_bps matches these fees'
    /// floor-rule bind (term(1,2) + term(1,10) == 6000) so the NEW fee_bps
    /// bind never masks the curve error this test targets.
    #[test]
    fn test_create_pool_invalid_flat_curve() {
        let fees = Fees {
            trade_fee_numerator: 1,
            trade_fee_denominator: 2,
            owner_trade_fee_numerator: 1,
            owner_trade_fee_denominator: 10,
            owner_withdraw_fee_numerator: 1,
            owner_withdraw_fee_denominator: 5,
            host_fee_numerator: 20,
            host_fee_denominator: 100,
        };
        let mut fx = CreatePoolFixture::new(
            &spl_token::id(),
            &spl_token::id(),
            &spl_token::id(),
            1_000_000,
            2_000_000,
            6000,
            fees,
            SwapCurve {
                curve_type: CurveType::ConstantPrice,
                calculator: Arc::new(ConstantPriceCurve { token_b_price: 0 }),
            },
        );
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::InvalidCurve.into());
    }

    #[test]
    fn test_create_pool_invalid_offset_curve() {
        let fees = Fees {
            trade_fee_numerator: 1,
            trade_fee_denominator: 2,
            owner_trade_fee_numerator: 1,
            owner_trade_fee_denominator: 10,
            owner_withdraw_fee_numerator: 1,
            owner_withdraw_fee_denominator: 5,
            host_fee_numerator: 20,
            host_fee_denominator: 100,
        };
        let mut fx = CreatePoolFixture::new(
            &spl_token::id(),
            &spl_token::id(),
            &spl_token::id(),
            1_000_000,
            2_000_000,
            6000,
            fees,
            SwapCurve {
                curve_type: CurveType::Offset,
                calculator: Arc::new(OffsetCurve { token_b_offset: 0 }),
            },
        );
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::InvalidCurve.into());
    }

    #[test]
    fn test_create_pool_wrong_lp_pda() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.lp_mint_key = Pubkey::new_unique(); // not the [b"cp_lp", pool] PDA
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        // R2: at HEAD this is UnsupportedSysvar — the LP PDA check
        // (processor.rs :487-493) sits after Rent::get() (:466).
        assert_eq!(err, SwapError::InvalidProgramAddress.into());
    }

    #[test]
    fn test_create_pool_already_in_use() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        // R3: at HEAD the FIRST create dies UnsupportedSysvar, so this
        // .unwrap() is the red (the test can't reach its real assertion).
        run_create_pool(&mut fx, &None).unwrap();
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::AlreadyInUse.into());
    }

    #[test]
    fn test_create_pool_refuses_missized_shell() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.pool_account =
            SolanaAccount::new(0, SwapVersion::LATEST_LEN - 1, &system_program::id());
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        // R4: at HEAD this is UnsupportedSysvar (dies before the shell is
        // ever inspected); the staged red once only the rent stub is added
        // (no pre-sizing branch yet) is InvalidAccountData from the mimic check —
        // recorded in the work log, not asserted here.
        assert_eq!(err, ProgramError::AccountDataTooSmall);
    }

    #[test]
    fn test_create_pool_refuses_preowned_shell() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.pool_account = SolanaAccount::new(0, SwapVersion::LATEST_LEN, &SWAP_PROGRAM_ID);
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        // R5: at HEAD this is UnsupportedSysvar.
        assert_eq!(err, ProgramError::AccountAlreadyInitialized);
    }

    #[test]
    fn test_create_pool_insufficient_payer_funds() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.payer_account.lamports = 0;
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        // R6: at HEAD this is UnsupportedSysvar.
        assert_eq!(err, ProgramError::InsufficientFunds);
    }

    #[test]
    fn test_create_pool_delegates_shared_validation() {
        let mut fx = CreatePoolFixture::new(
            &spl_token::id(),
            &spl_token::id(),
            &spl_token::id(),
            0, // empty vault A — proves init_pool_state's shared
            2_000_000, // validate_supply is actually exercised via delegation.
            6000,
            Fees {
                trade_fee_numerator: 1,
                trade_fee_denominator: 2,
                owner_trade_fee_numerator: 1,
                owner_trade_fee_denominator: 10,
                owner_withdraw_fee_numerator: 1,
                owner_withdraw_fee_denominator: 5,
                host_fee_numerator: 20,
                host_fee_denominator: 100,
            },
            SwapCurve {
                curve_type: CurveType::ConstantProduct,
                calculator: Arc::new(ConstantProductCurve {}),
            },
        );
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        // R7: at HEAD this is UnsupportedSysvar.
        assert_eq!(err, SwapError::EmptySupply.into());
    }

    #[test]
    fn test_create_pool_tier_constraints_full_path() {
        // R8, updated in place: the pool-PDA-as-
        // fee-owner trick died with the compiled-in field itself. Constraint
        // set = { valid_curve_types, fees } only. Tier fees now succeed
        // unconditionally (no #86 collision needed) — the #86 pin lives in
        // `production_create_pool_succeeds`.

        // (a) tier fees, matching the constraint's fee floor exactly -> success.
        {
            let mut fx = CreatePoolFixture::new(
                &spl_token::id(),
                &spl_token::id(),
                &spl_token::id(),
                1_000_000,
                2_000_000,
                30, // a real production tier (0.30%), see constraints.rs
                tier_fees(25, 5),
                SwapCurve {
                    curve_type: CurveType::ConstantProduct,
                    calculator: Arc::new(ConstantProductCurve {}),
                },
            );
            let constraints = Some(SwapConstraints {
                valid_curve_types: &[CurveType::ConstantProduct],
                fees: &tier_fees(25, 5),
            });
            run_create_pool(&mut fx, &constraints).unwrap();
        }

        // (b) off-tier fees (below the tier floor) -> InvalidFee.
        {
            let mut fx = CreatePoolFixture::new(
                &spl_token::id(),
                &spl_token::id(),
                &spl_token::id(),
                1_000_000,
                2_000_000,
                15, // fee_bps rebound for tier_fees(10, 5): term(10)+term(5)=15
                tier_fees(10, 5), // trade_num=10 < the tier floor of 25
                SwapCurve {
                    curve_type: CurveType::ConstantProduct,
                    calculator: Arc::new(ConstantProductCurve {}),
                },
            );
            let constraints = Some(SwapConstraints {
                valid_curve_types: &[CurveType::ConstantProduct],
                fees: &tier_fees(25, 5),
            });
            let err = run_create_pool(&mut fx, &constraints).unwrap_err();
            assert_eq!(err, SwapError::InvalidFee.into());
        }

        // (c) Offset curve, tier fees ok -> UnsupportedCurveType.
        {
            let mut fx = CreatePoolFixture::new(
                &spl_token::id(),
                &spl_token::id(),
                &spl_token::id(),
                1_000_000,
                2_000_000,
                30,
                tier_fees(25, 5),
                SwapCurve {
                    curve_type: CurveType::Offset,
                    calculator: Arc::new(OffsetCurve {
                        token_b_offset: 1_000_000,
                    }),
                },
            );
            let constraints = Some(SwapConstraints {
                valid_curve_types: &[CurveType::ConstantProduct],
                fees: &tier_fees(25, 5),
            });
            let err = run_create_pool(&mut fx, &constraints).unwrap_err();
            assert_eq!(err, SwapError::UnsupportedCurveType.into());
        }
    }

    /// RA3 (RED SET A): reproduced as a test immediately
    /// before it is dissolved — tier fees through the COMPILED-IN production
    /// constraint set must succeed once the compiled-in fee-owner field is
    /// gone (Stage 1). RED at Stage 0: `InvalidOwner` at
    /// `processor.rs:359-367` (the only way a non-pool-PDA fee-owner value
    /// could pass is the #86 collision this fixture deliberately does NOT
    /// construct). Stage 1 replaces the old
    /// `production_create_pool_invalid_owner_issue_86` test with this one
    /// (1-for-1: the #86 pin flips from "fails" to "succeeds").
    #[cfg(feature = "production")]
    #[test]
    fn production_create_pool_succeeds() {
        let mut fx = CreatePoolFixture::new(
            &spl_token::id(),
            &spl_token::id(),
            &spl_token::id(),
            1_000_000,
            2_000_000,
            30, // tier_fees(25, 5) binds to fee_bps == 30
            tier_fees(25, 5),
            SwapCurve {
                curve_type: CurveType::ConstantProduct,
                calculator: Arc::new(ConstantProductCurve {}),
            },
        );
        run_create_pool(&mut fx, &SWAP_CONSTRAINTS).unwrap();
        let swap_state = SwapVersion::unpack(&fx.pool_account.data).unwrap();
        assert!(swap_state.is_initialized());
        assert_eq!(*swap_state.fees(), tier_fees(25, 5));
    }

    // Green-at-HEAD guards: both die at a program check that runs
    // BEFORE Rent::get(), so no rent stub is needed for these to pass today.
    // These two differ in how their guards are proven:
    //
    // - test_create_pool_wrong_pool_pda: the program's pool-PDA compare IS
    //   falsifiable in-harness. Mutant M9b (temporarily neuter that compare)
    //   was run and seen red. Note its red routes THROUGH the stub's
    //   funder-signer fidelity check: the mutant surfaces
    //   MissingRequiredSignature, which differs from this test's asserted
    //   InvalidProgramAddress, so the stub signer check is load-bearing for
    //   M9b's teeth (see the design plan).
    //
    // - test_create_pool_payer_not_signer: the program's payer-signer check
    //   (processor.rs, process_create_pool) is NOT falsifiable in this harness.
    //   Neutering it does NOT redden this test — the stub's own funder-signer
    //   fidelity check returns the identical MissingRequiredSignature and masks
    //   the program mutant. This is an observable-contract pin, not a decorative
    //   claim: on real Solana the system create_account CPI enforces the same
    //   refusal, so removing the program's redundant check is observationally
    //   invisible even on-chain. No honest harness change can isolate it; do
    //   not claim a mutant reddens this test.

    #[test]
    fn test_create_pool_wrong_pool_pda() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.pool_key = Pubkey::new_unique(); // not the [b"cp_pool", ...] PDA
        // Keep the authority PDA consistent with the substituted pool key so
        // the ADJACENT authority-PDA check (processor.rs :463-465) can't
        // also fire and produce the same InvalidProgramAddress by
        // coincidence — this isolates the pool-PDA compare itself (M9,
        // the design plan): removing just that check surfaces a
        // different error (MissingRequiredSignature, from the pool no
        // longer being seed-marked a signer for its own creation), which
        // this assertion would catch.
        fx.authority_key = Pubkey::find_program_address(&[fx.pool_key.as_ref()], &SWAP_PROGRAM_ID).0;
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::InvalidProgramAddress.into());
    }

    #[test]
    fn test_create_pool_payer_not_signer() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        let mut ix = create_pool_ix(
            &fx.payer_key,
            &fx.pool_key,
            &fx.authority_key,
            &fx.mint_a_key,
            &fx.mint_b_key,
            &fx.vault_a_key,
            &fx.vault_b_key,
            &fx.lp_mint_key,
            &fx.dest_key,
            &fx.pool_token_program_id,
            fx.fee_bps,
            fx.pool_bump,
            fx.lp_bump,
            fx.fees.clone(),
            fx.swap_curve.clone(),
            &fx.config_key,
        );
        ix.accounts[0].is_signer = false;
        let mut authority_dummy = SolanaAccount::default();
        let mut mint_a_dummy = fx.mint_a_account.clone();
        let mut mint_b_dummy = fx.mint_b_account.clone();
        let mut token_program_dummy = SolanaAccount::default();
        let mut system_program_dummy = SolanaAccount::default();
        let err = do_process_instruction_with_fee_constraints(
            ix,
            vec![
                &mut fx.payer_account,
                &mut fx.pool_account,
                &mut authority_dummy,
                &mut mint_a_dummy,
                &mut mint_b_dummy,
                &mut fx.vault_a_account,
                &mut fx.vault_b_account,
                &mut fx.lp_mint_account,
                &mut fx.dest_account,
                &mut token_program_dummy,
                &mut system_program_dummy,
                &mut fx.config_account,
            ],
            &None,
        )
        .unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    // -------------------------------------------------------------------
    // RED SET A, written and run at
    // Stage 0 before any behavior change. Each records the CURRENT (red)
    // behavior in its comment; the assertion is the FINAL (green) shape.
    // -------------------------------------------------------------------

    /// RA1: tag 0 must become a reserved unit variant returning the named
    /// error `InstructionRetired`, tags 1-7 staying byte-identical. Dispatch
    /// is a leading-byte match that returns immediately for tag 0 (never
    /// touching `accounts`), so an empty account slice suffices — this also
    /// means the test survives the deletion of `new_v1`/`initialize_swap_v1`
    /// (the tag-0-only test fixtures, dying alongside `Initialize` itself).
    /// STAGE 0 RED (recorded before this rewrite, evidence in the Stage 0
    /// commit): a fully-wired v1 fixture actually SUCCEEDED (`Ok(())`) —
    /// tag 0 dispatched a fully working `Initialize`.
    #[test]
    fn test_tag0_returns_instruction_retired() {
        let result = Processor::process_with_constraints(&SWAP_PROGRAM_ID, &[], &[0u8], &None);
        assert_eq!(result, Err(SwapError::InstructionRetired.into()));
    }

    /// RA2: `fee_bps` (the pool PDA seed) must be bound to the `fees`
    /// parameters — a CreatePool whose ix-carried `fee_bps` disagrees with
    /// its own `fees` must be refused, even though the pool PDA is ALSO
    /// derived from that same (wrong) `fee_bps` — so only the bind, never a
    /// PDA-mismatch check, can catch this. RED at Stage 0: `fee_bps` is
    /// unbound today (`processor.rs` uses it only as PDA seed material), so
    /// this succeeds — `.unwrap_err()` panics on the `Ok`.
    #[test]
    fn test_create_pool_fee_bps_mismatch() {
        let mut fx = CreatePoolFixture::new(
            &spl_token::id(),
            &spl_token::id(),
            &spl_token::id(),
            1_000_000,
            2_000_000,
            31, // tier_fees(25, 5) binds to fee_bps == 30, not 31
            tier_fees(25, 5),
            SwapCurve {
                curve_type: CurveType::ConstantProduct,
                calculator: Arc::new(ConstantProductCurve {}),
            },
        );
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::FeeBpsMismatch.into());
    }

    // -------------------------------------------------------------------
    // RED SET B — accrual/exclusion integration tests using
    // SEEDED counters (`seed_protocol_fees`), tested orthogonally to
    // accrual correctness (which `check_valid_swap_curve` and the
    // `test_withdraw`/`test_withdraw_one_exact_out` rewrites already pin
    // via swap-produced counters).
    // -------------------------------------------------------------------

    /// Returns the fixture AND the mint-authority key `SwapAccountInfo::new`
    /// used internally — callers need it to fund additional user accounts
    /// via `mint_token`/`setup_token_accounts` (the mint authority isn't a
    /// stored field on `SwapAccountInfo`).
    fn rb_fixture(token_a_amount: u64, token_b_amount: u64) -> (SwapAccountInfo, Pubkey) {
        let user_key = Pubkey::new_unique();
        let fees = Fees {
            trade_fee_numerator: 1,
            trade_fee_denominator: 10,
            owner_trade_fee_numerator: 1,
            owner_trade_fee_denominator: 10,
            owner_withdraw_fee_numerator: 0,
            owner_withdraw_fee_denominator: 0,
            host_fee_numerator: 0,
            host_fee_denominator: 0,
        };
        let swap_curve = SwapCurve {
            curve_type: CurveType::ConstantProduct,
            calculator: Arc::new(ConstantProductCurve {}),
        };
        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &spl_token::id(),
            &spl_token::id(),
            &spl_token::id(),
        );
        accounts.initialize_swap().unwrap();
        (accounts, user_key)
    }

    /// RB13: a pool whose side A vault holds ONLY protocol fees (counter ==
    /// vault) must still allow withdrawal — side A pays 0, side B pays its
    /// full pro-rata (X8's zero-guard semantics, the decided choice).
    /// RED under the pre-v2 raw-vault zero-guard: `ZeroTradingTokens`.
    #[test]
    fn test_withdraw_drained_side_succeeds() {
        let (mut accounts, user_key) = rb_fixture(1_000_000, 2_000_000);
        // Seed side A's counter to exactly the vault's current balance —
        // LP-owned reserve on side A is now 0.
        seed_protocol_fees(&mut accounts, 0, 0); // no-op seed call kept for symmetry/documentation
        {
            let mut data = accounts.swap_account.data.clone();
            let mut v2 = SwapV2::unpack_from_slice(&data[1..]).unwrap();
            v2.protocol_fees_a = 1_000_000; // == vault A's entire balance
            v2.pack_into_slice(&mut data[1..]);
            accounts.swap_account.data = data;
        }

        let withdrawer_key = Pubkey::new_unique();
        let pool_mint =
            StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
        let pool_supply = pool_mint.base.supply;
        let (token_a_key, mut token_a_account, token_b_key, mut token_b_account, pool_key, mut pool_account) =
            accounts.setup_token_accounts(
                &Pubkey::new_unique(),
                &withdrawer_key,
                0,
                0,
                pool_supply,
            );

        accounts
            .withdraw_all_token_types(
                &withdrawer_key,
                &pool_key,
                &mut pool_account,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                pool_supply,
                0,
                0,
            )
            .unwrap();

        let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
        assert_eq!(token_a.base.amount, 0);
        let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
        assert!(token_b.base.amount > 0);

        // Vault A still holds exactly the counter after the full-supply burn.
        let vault_a =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
        assert_eq!(vault_a.base.amount, 1_000_000);
    }

    /// RB13, B-side orientation (the plan's "both orientations"): mirrors
    /// `test_withdraw_drained_side_succeeds` with the drained side flipped
    /// to B — pins X10's zero-guard independently of X8's (a mutant on one
    /// guard alone must not hide behind the other).
    #[test]
    fn test_withdraw_drained_side_b_succeeds() {
        let (mut accounts, _user_key) = rb_fixture(1_000_000, 2_000_000);
        {
            let mut data = accounts.swap_account.data.clone();
            let mut v2 = SwapV2::unpack_from_slice(&data[1..]).unwrap();
            v2.protocol_fees_b = 2_000_000; // == vault B's entire balance
            v2.pack_into_slice(&mut data[1..]);
            accounts.swap_account.data = data;
        }

        let withdrawer_key = Pubkey::new_unique();
        let pool_mint =
            StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
        let pool_supply = pool_mint.base.supply;
        let (token_a_key, mut token_a_account, token_b_key, mut token_b_account, pool_key, mut pool_account) =
            accounts.setup_token_accounts(
                &Pubkey::new_unique(),
                &withdrawer_key,
                0,
                0,
                pool_supply,
            );

        accounts
            .withdraw_all_token_types(
                &withdrawer_key,
                &pool_key,
                &mut pool_account,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                pool_supply,
                0,
                0,
            )
            .unwrap();

        let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
        assert_eq!(token_b.base.amount, 0);
        let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
        assert!(token_a.base.amount > 0);

        let vault_b =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
        assert_eq!(vault_b.base.amount, 2_000_000);
    }

    /// X6/X7/X9 (withdraw_all pro-rata + clamps), PARTIAL withdrawal with
    /// SEEDED counters: a 100% burn (as in RB14) makes the pro-rata ratio
    /// exactly 1, so a reverted X6 is masked by the X7/X9 clamp recovering
    /// the right answer anyway — this test uses a partial (50%) burn,
    /// where pro-rata and raw vault diverge and the clamp does NOT bind,
    /// isolating X6 on its own.
    #[test]
    fn test_withdraw_all_partial_excludes_counters() {
        let (mut plain, plain_user) = rb_fixture(1_000_000, 2_000_000);
        let (mut seeded, seeded_user) = rb_fixture(1_000_000, 2_000_000);
        seed_protocol_fees(&mut seeded, 100_000, 200_000);

        let withdraw = |accounts: &mut SwapAccountInfo, user_key: &Pubkey| -> (u64, u64) {
            let withdrawer_key = Pubkey::new_unique();
            let pool_mint =
                StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
            let half_supply = pool_mint.base.supply / 2;
            let (token_a_key, mut token_a_account, token_b_key, mut token_b_account, pool_key, mut pool_account) =
                accounts.setup_token_accounts(user_key, &withdrawer_key, 0, 0, half_supply);
            accounts
                .withdraw_all_token_types(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    half_supply,
                    0,
                    0,
                )
                .unwrap();
            let a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap().base.amount;
            let b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap().base.amount;
            (a, b)
        };

        let (plain_a, plain_b) = withdraw(&mut plain, &plain_user);
        let (seeded_a, seeded_b) = withdraw(&mut seeded, &seeded_user);
        assert_eq!(
            (seeded_a, seeded_b),
            (plain_a, plain_b),
            "a partial withdrawal on the seeded (larger-raw-vault) pool must match its no-counter twin exactly"
        );
    }

    /// X9 (withdraw_all clamp B), seeded: the finding is that
    /// the clamp never binds under ConstantProduct (so
    /// `test_withdraw_all_partial_excludes_counters` above cannot pin it —
    /// confirmed empirically: the X7/X9 mutant left that test, RB13/RB13-B,
    /// and RB14 all green). The Offset curve's clamp DOES bind (same
    /// mechanism as `test_withdraw_all_offset_curve`: the curve computes a
    /// side-B withdrawal larger than the vault actually holds). Seeding a
    /// counter on B on top of that makes the CORRECT clamp target
    /// (`lp_b = vault_b - counter_b`, numerically the pre-seed vault_b)
    /// diverge from the raw (post-seed, larger) vault — the X9 mutant's
    /// only reachable red in this suite.
    #[test]
    fn test_withdraw_all_offset_curve_clamp_excludes_counter() {
        let user_key = Pubkey::new_unique();
        let fees = Fees {
            trade_fee_numerator: 1,
            trade_fee_denominator: 10,
            owner_trade_fee_numerator: 1,
            owner_trade_fee_denominator: 30,
            owner_withdraw_fee_numerator: 0,
            owner_withdraw_fee_denominator: 30,
            host_fee_numerator: 10,
            host_fee_denominator: 100,
        };
        let token_a_amount = 1_000_000_000;
        let token_b_amount = 100u64;
        let swap_curve = SwapCurve {
            curve_type: CurveType::Offset,
            calculator: Arc::new(OffsetCurve {
                token_b_offset: 2_000_000,
            }),
        };
        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &spl_token::id(),
            &spl_token::id(),
            &spl_token::id(),
        );
        accounts.initialize_swap().unwrap();

        let fee_b = 30u64;
        seed_protocol_fees(&mut accounts, 0, fee_b); // vault_b -> 130, lp_b stays 100
        let vault_b_after_seed =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap().base.amount;
        assert_eq!(vault_b_after_seed, token_b_amount + fee_b);

        let pool_mint =
            StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
        let total_pool = pool_mint.base.supply;
        let (token_a_key, mut token_a_account, token_b_key, mut token_b_account, _pool_key, _pool_account) =
            accounts.setup_token_accounts(&user_key, &Pubkey::new_unique(), 0, 0, 0);
        let pool_key = accounts.pool_token_key;
        let mut pool_account = accounts.pool_token_account.clone();

        accounts
            .withdraw_all_token_types(
                &user_key,
                &pool_key,
                &mut pool_account,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                total_pool.try_into().unwrap(),
                0,
                0,
            )
            .unwrap();

        // The clamp must target lp_b (100), never the raw post-seed vault (130).
        let token_b = StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap();
        assert_eq!(token_b.base.amount, token_b_amount);
        let vault_b_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
        assert_eq!(vault_b_after.base.amount, fee_b);
    }

    /// X7 (withdraw_all clamp A), seeded: mirrors the X9 test above using
    /// `test_withdraw_all_constant_price_curve`'s unbalanced-pool mechanism
    /// (curve computes a side-A withdrawal larger than the vault holds,
    /// binding the clamp) — with a counter seeded on A, on top of the
    /// existing balance.
    #[test]
    fn test_withdraw_all_constant_price_curve_clamp_excludes_counter() {
        let fees = Fees {
            trade_fee_numerator: 1,
            trade_fee_denominator: 10,
            owner_trade_fee_numerator: 1,
            owner_trade_fee_denominator: 30,
            owner_withdraw_fee_numerator: 0,
            owner_withdraw_fee_denominator: 30,
            host_fee_numerator: 10,
            host_fee_denominator: 100,
        };
        // Unbalanced, as in test_withdraw_all_constant_price_curve: the
        // curve will try to withdraw 1_500_000_000 of A against a vault
        // that (pre-seed) holds only 1_000_000_000 — the clamp binds.
        let swap_token_a_amount = 1_000_000_000u64;
        let swap_token_b_amount = 1_000u64;
        let token_b_price = 2_000_000;
        let swap_curve = SwapCurve {
            curve_type: CurveType::ConstantPrice,
            calculator: Arc::new(ConstantPriceCurve { token_b_price }),
        };
        let user_key = Pubkey::new_unique();
        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            swap_token_a_amount,
            swap_token_b_amount,
            &spl_token::id(),
            &spl_token::id(),
            &spl_token::id(),
        );
        accounts.initialize_swap().unwrap();

        let fee_a = 12_345u64;
        seed_protocol_fees(&mut accounts, fee_a, 0); // vault_a -> +fee_a, lp_a unchanged
        let vault_a_after_seed =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        assert_eq!(vault_a_after_seed, swap_token_a_amount + fee_a);

        let pool_mint =
            StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
        let total_pool = pool_mint.base.supply;
        let (token_a_key, mut token_a_account, token_b_key, mut token_b_account, _pool_key, _pool_account) =
            accounts.setup_token_accounts(&user_key, &Pubkey::new_unique(), 0, 0, 0);
        let pool_key = accounts.pool_token_key;
        let mut pool_account = accounts.pool_token_account.clone();

        accounts
            .withdraw_all_token_types(
                &user_key,
                &pool_key,
                &mut pool_account,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                total_pool.try_into().unwrap(),
                0,
                0,
            )
            .unwrap();

        // The clamp must target lp_a (the pre-seed amount), never the raw
        // post-seed vault.
        let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
        assert_eq!(token_a.base.amount, swap_token_a_amount);
        let vault_a_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
        assert_eq!(vault_a_after.base.amount, fee_a);
    }

    /// RB14 (conservation): pool + swaps both directions (accrual-produced
    /// counters, NOT seeded) + burn 100% of LP supply. LPs receive exactly
    /// `vault - counter` per side; vaults are left holding EXACTLY
    /// `(protocol_fees_a, protocol_fees_b)`. This is the end-to-end pin of
    /// the whole slice: extraction of accrued counters is unconstructable
    /// through any instruction this slice ships.
    #[test]
    fn test_full_burn_leaves_exactly_counters() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        let swapper_key = Pubkey::new_unique();
        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;

        // A->B swap: accrues protocol_fees_a.
        let (user_a_key, mut user_a_account) = mint_token(
            &spl_token::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &swapper_key,
            100_000,
        );
        let (user_b_key, mut user_b_account) = mint_token(
            &spl_token::id(),
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            &user_key,
            &swapper_key,
            0,
        );
        accounts
            .swap(
                &swapper_key,
                &user_a_key,
                &mut user_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &user_b_key,
                &mut user_b_account,
                100_000,
                0,
            )
            .unwrap();

        // B->A swap: accrues protocol_fees_b.
        let (user_b2_key, mut user_b2_account) = mint_token(
            &spl_token::id(),
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            &user_key,
            &swapper_key,
            200_000,
        );
        let (user_a2_key, mut user_a2_account) = mint_token(
            &spl_token::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &swapper_key,
            0,
        );
        accounts
            .swap(
                &swapper_key,
                &user_b2_key,
                &mut user_b2_account,
                &swap_token_b_key,
                &swap_token_a_key,
                &user_a2_key,
                &mut user_a2_account,
                200_000,
                0,
            )
            .unwrap();

        let swap_state = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        let protocol_fees_a = swap_state.protocol_fees_a();
        let protocol_fees_b = swap_state.protocol_fees_b();
        assert!(protocol_fees_a > 0);
        assert!(protocol_fees_b > 0);

        let vault_a_before =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data)
                .unwrap()
                .base
                .amount;
        let vault_b_before =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data)
                .unwrap()
                .base
                .amount;

        let pool_mint =
            StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
        let pool_supply = pool_mint.base.supply;
        // `setup_token_accounts` MINTS its `pool_amount` param (new supply),
        // it does not transfer existing LP — so burning 100% of supply means
        // withdrawing from the ORIGINAL creator-held destination
        // (`accounts.pool_token_key`, funded by CreatePool's initial mint),
        // not a freshly minted account. `withdrawer_key` = `user_key` = the
        // creator/payer (`SwapAccountInfo::new`'s `payer_key = *user_key`).
        let (token_a_key, mut token_a_account, token_b_key, mut token_b_account, _pool_key, _pool_account) =
            accounts.setup_token_accounts(&user_key, &Pubkey::new_unique(), 0, 0, 0);
        let pool_key = accounts.pool_token_key;
        let mut pool_account = accounts.pool_token_account.clone();

        accounts
            .withdraw_all_token_types(
                &user_key,
                &pool_key,
                &mut pool_account,
                &token_a_key,
                &mut token_a_account,
                &token_b_key,
                &mut token_b_account,
                pool_supply,
                0,
                0,
            )
            .unwrap();

        let lp_received_a =
            StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap().base.amount;
        let lp_received_b =
            StateWithExtensions::<Account>::unpack(&token_b_account.data).unwrap().base.amount;
        assert_eq!(lp_received_a, vault_a_before - protocol_fees_a);
        assert_eq!(lp_received_b, vault_b_before - protocol_fees_b);

        let vault_a_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap();
        let vault_b_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap();
        assert_eq!(vault_a_after.base.amount, protocol_fees_a);
        assert_eq!(vault_b_after.base.amount, protocol_fees_b);
    }

    /// RB15 (documented honestly, not silently claimed): the
    /// plan explicitly allows this test to be "green on arrival," with its
    /// real teeth coming from the M-B3 mutant (`checked_add` ->
    /// `saturating_add`), run separately by the lead. Why it CANNOT be red
    /// via any real swap: `lp_owned`'s invariant is `protocol_fees <=
    /// vault_amount`, and `vault_amount` itself can never exceed `u64::MAX`
    /// because spl-token's own `TransferChecked` refuses an incoming
    /// transfer that would overflow the destination vault — BEFORE this
    /// program's accrual step ever runs. Since `owner_fee` is always a
    /// strict fraction of the amount actually transferred in, and that
    /// transfer must itself fit within the vault's headroom to
    /// `u64::MAX`, `owner_fee` can never exceed the counter's own headroom
    /// to `u64::MAX` either — `checked_add` cannot observe an overflow on
    /// any state a real swap can produce. This test pins the closest real
    /// boundary (a very large, but not un-transferable, counter) and
    /// asserts it accrues cleanly; reaching the actual overflow branch
    /// needs the M-B3 mutant, not a bigger number here.
    #[test]
    fn test_accrual_near_max_succeeds_without_wrapping() {
        let (mut accounts, user_key) = rb_fixture(1_000, 2_000_000_000);
        let protocol_fees_a = u64::MAX / 2;
        {
            let mut token_a =
                Account::unpack_from_slice(&accounts.token_a_account.data[..Account::LEN])
                    .unwrap();
            token_a.amount = protocol_fees_a + 2_000_000_000; // healthy lp_owned reserve
            token_a.pack_into_slice(&mut accounts.token_a_account.data[..Account::LEN]);
            let mut data = accounts.swap_account.data.clone();
            let mut v2 = SwapV2::unpack_from_slice(&data[1..]).unwrap();
            v2.protocol_fees_a = protocol_fees_a;
            v2.pack_into_slice(&mut data[1..]);
            accounts.swap_account.data = data;
        }

        let swapper_key = Pubkey::new_unique();
        let (user_a_key, mut user_a_account) = mint_token(
            &spl_token::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &swapper_key,
            1_000_000,
        );
        let (user_b_key, mut user_b_account) = mint_token(
            &spl_token::id(),
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            &user_key,
            &swapper_key,
            0,
        );
        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;
        accounts
            .swap(
                &swapper_key,
                &user_a_key,
                &mut user_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &user_b_key,
                &mut user_b_account,
                1_000_000,
                0,
            )
            .unwrap();
        let swap_state = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        assert!(swap_state.protocol_fees_a() > protocol_fees_a);
    }

    /// M-B7's pin: `lp_owned` must fail closed (named error), never wrap,
    /// if a hand-packed state ever violates `protocol_fees <= vault_amount`.
    #[test]
    fn test_lp_owned_underflow_fails_closed() {
        let (mut accounts, user_key) = rb_fixture(1_000_000, 2_000_000);
        {
            let mut data = accounts.swap_account.data.clone();
            let mut v2 = SwapV2::unpack_from_slice(&data[1..]).unwrap();
            v2.protocol_fees_a = 1_000_000 + 1; // one more than the vault holds
            v2.pack_into_slice(&mut data[1..]);
            accounts.swap_account.data = data;
        }
        let swapper_key = Pubkey::new_unique();
        let (user_a_key, mut user_a_account) = mint_token(
            &spl_token::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &swapper_key,
            1_000,
        );
        let (user_b_key, mut user_b_account) = mint_token(
            &spl_token::id(),
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            &user_key,
            &swapper_key,
            0,
        );
        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;
        let err = accounts
            .swap(
                &swapper_key,
                &user_a_key,
                &mut user_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &user_b_key,
                &mut user_b_account,
                1_000,
                0,
            )
            .unwrap_err();
        assert_eq!(err, SwapError::CalculationFailure.into());
    }

    /// X5 (deposit_all site): `seed_protocol_fees` mints its `fee_a`/`fee_b`
    /// ON TOP of the existing vault balance while rewriting the counter to
    /// match — so the LP-OWNED reserve (`vault - counter`) is numerically
    /// UNCHANGED, even though the RAW vault is now larger. A deposit
    /// against the seeded pool must therefore pull EXACTLY what the same
    /// deposit pulls against an identical twin pool with no counters at
    /// all — proving the deposit reads `vault - counter`, never the raw
    /// (now-larger) vault. Reverting the exclusion (X5 mutant) would make
    /// the seeded pool's raw-vault-based pull DIVERGE from the twin's,
    /// reddening this test.
    #[test]
    fn test_deposit_all_excludes_counters() {
        let (mut plain, plain_user) = rb_fixture(1_000_000, 2_000_000);
        let (mut seeded, seeded_user) = rb_fixture(1_000_000, 2_000_000);
        seed_protocol_fees(&mut seeded, 100_000, 200_000);
        // Confirm the seed did what it claims: raw vault grew, LP-owned
        // reserve (vault - counter) did not.
        let seeded_vault_a =
            StateWithExtensions::<Account>::unpack(&seeded.token_a_account.data).unwrap().base.amount;
        assert_eq!(seeded_vault_a, 1_100_000);

        let deposit_pool_amount = 90_000u64;
        let pull = |accounts: &mut SwapAccountInfo, user_key: &Pubkey| -> u64 {
            let depositor_key = Pubkey::new_unique();
            let (token_a_key, mut token_a_account, token_b_key, mut token_b_account, pool_key, mut pool_account) =
                accounts.setup_token_accounts(user_key, &depositor_key, 10_000_000, 10_000_000, 0);
            accounts
                .deposit_all_token_types(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &token_b_key,
                    &mut token_b_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_pool_amount,
                    u64::MAX,
                    u64::MAX,
                )
                .unwrap();
            let token_a = StateWithExtensions::<Account>::unpack(&token_a_account.data).unwrap();
            10_000_000 - token_a.base.amount
        };

        let plain_pull = pull(&mut plain, &plain_user);
        let seeded_pull = pull(&mut seeded, &seeded_user);
        assert_eq!(
            seeded_pull, plain_pull,
            "seeded pull must equal the no-counter twin's pull (raw vault is larger but must not be read)"
        );
    }

    /// X12 (withdraw_single site): same reasoning as X5 above — seed the
    /// side actually being withdrawn (B), on top of its existing balance,
    /// so LP-owned reserve on B is numerically unchanged while the RAW
    /// vault is larger. Burning the same exact-B-out request must cost
    /// EXACTLY the same in pool tokens as the no-counter twin; reverting
    /// the exclusion would make the seeded pool read the larger raw vault
    /// and diverge.
    #[test]
    fn test_withdraw_single_excludes_counters() {
        let (mut plain, plain_user) = rb_fixture(1_000_000, 2_000_000);
        let (mut seeded, seeded_user) = rb_fixture(1_000_000, 2_000_000);
        seed_protocol_fees(&mut seeded, 0, 200_000);

        let destination_b_amount = 10_000u64;
        let burn = |accounts: &mut SwapAccountInfo, user_key: &Pubkey| -> u64 {
            let withdrawer_key = Pubkey::new_unique();
            let pool_mint =
                StateWithExtensions::<Mint>::unpack(&accounts.pool_mint_account.data).unwrap();
            let pool_supply = pool_mint.base.supply;
            let (_token_a_key, _token_a_account, token_b_key, mut token_b_account, pool_key, mut pool_account) =
                accounts.setup_token_accounts(user_key, &withdrawer_key, 0, 0, pool_supply);
            let pool_before =
                StateWithExtensions::<Account>::unpack(&pool_account.data).unwrap().base.amount;
            accounts
                .withdraw_single_token_type_exact_amount_out(
                    &withdrawer_key,
                    &pool_key,
                    &mut pool_account,
                    &token_b_key,
                    &mut token_b_account,
                    destination_b_amount,
                    u64::MAX,
                )
                .unwrap();
            let pool_after =
                StateWithExtensions::<Account>::unpack(&pool_account.data).unwrap().base.amount;
            pool_before - pool_after
        };

        let plain_burn = burn(&mut plain, &plain_user);
        let seeded_burn = burn(&mut seeded, &seeded_user);
        assert_eq!(
            seeded_burn, plain_burn,
            "seeded burn must equal the no-counter twin's burn (raw vault is larger but must not be read)"
        );
    }

    /// CRITICAL (fund-drain / pool-brick): unlike `withdraw_all` (X7/X9),
    /// `withdraw_single_token_type_exact_out` has NO clamp of the
    /// requested exact-out against the withdrawn side's LP-owned reserve.
    /// The curve doesn't stop it either: `withdraw_single_token_type_exact_out`
    /// in `curve/constant_product.rs` computes `ratio =
    /// destination_amount / lp_source`; when the (fee-inflated) source
    /// amount meets or exceeds `lp_source`, `one.checked_sub(&ratio)`
    /// fails and falls back to `PreciseNumber::new(0)` via
    /// `unwrap_or_else` — giving `root = 1` and `Some(pool_supply)`
    /// instead of `None`. A full-supply LP holder can request an exact-out
    /// strictly between `lp_b` and the raw vault (`lp_b +
    /// protocol_fees_b`), burn their whole position, and walk away funded
    /// by the counter-owned protocol fees — leaving `vault_b <
    /// protocol_fees_b`, which bricks every subsequent `lp_owned` call on
    /// side B (checked_sub underflow).
    #[test]
    fn test_withdraw_single_exact_out_drains_counter_and_bricks_pool() {
        let (mut accounts, user_key) = rb_fixture(1_000_000, 2_000_000);
        let protocol_fee_b = 200_000u64;
        seed_protocol_fees(&mut accounts, 0, protocol_fee_b);

        let lp_b = 2_000_000u64; // token_b vault before seeding, i.e. the LP-owned reserve
        let vault_b_before = lp_b + protocol_fee_b;
        // Strictly between the LP-owned reserve and the raw vault: the
        // fund-drain window this bug opens.
        let destination_b_amount = lp_b + 1;
        assert!(destination_b_amount < vault_b_before);

        // A fresh, empty destination account for the withdrawn token B —
        // the withdrawer is `user_key`, who already holds 100% of the
        // pool mint supply from `rb_fixture`'s initial deposit.
        let (_a_key, _a_account, dest_b_key, mut dest_b_account, _pool_key, _pool_account) =
            accounts.setup_token_accounts(&user_key, &user_key, 0, 0, 0);

        let pool_token_key = accounts.pool_token_key;
        let mut pool_token_account = accounts.pool_token_account.clone();

        let result = accounts.withdraw_single_token_type_exact_amount_out(
            &user_key,
            &pool_token_key,
            &mut pool_token_account,
            &dest_b_key,
            &mut dest_b_account,
            destination_b_amount,
            u64::MAX,
        );

        // Post-fix: the clamp must reject the drain outright — nothing
        // moves, the pool is never bricked.
        assert_eq!(
            result,
            Err(SwapError::ExceededLpReserve.into()),
            "expected the clamp to reject an exact-out beyond the LP-owned reserve: {result:?}"
        );

        let dest_balance =
            StateWithExtensions::<Account>::unpack(&dest_b_account.data).unwrap().base.amount;
        assert_eq!(dest_balance, 0, "rejected withdrawal must move nothing");

        let vault_b_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data)
                .unwrap()
                .base
                .amount;
        let data = accounts.swap_account.data.clone();
        let v2 = SwapV2::unpack_from_slice(&data[1..]).unwrap();
        assert_eq!(vault_b_after, vault_b_before, "vault untouched by the rejected withdrawal");
        assert!(
            vault_b_after >= v2.protocol_fees_b,
            "pool must stay healthy: vault_b ({vault_b_after}) >= protocol_fees_b ({})",
            v2.protocol_fees_b
        );
    }

    /// A-side twin of the drain/brick test above, on the SAME asymmetric
    /// `rb_fixture(1_000_000, 2_000_000)` (lp_a=1_000_000 != lp_b=2_000_000).
    /// The B-side test alone can't catch a swapped-arm mutant on the
    /// clamp (`AtoB => lp_b, BtoA => lp_a`): on that symmetric-request
    /// fixture, D=2,000,001 exceeds BOTH lp_a=1,000,000 and lp_b=2,000,000,
    /// so the clamp rejects regardless of which arm reads which side. This
    /// test picks D strictly between lp_a and lp_b (1,000,001) so a
    /// swapped arm would compare against lp_b=2,000,000 instead and wrongly
    /// ALLOW the drain — giving the direction-keying real mutation teeth.
    #[test]
    fn test_withdraw_single_exact_out_a_side_drains_counter_and_bricks_pool() {
        let (mut accounts, user_key) = rb_fixture(1_000_000, 2_000_000);
        let protocol_fee_a = 100_000u64;
        seed_protocol_fees(&mut accounts, protocol_fee_a, 0);

        let lp_a = 1_000_000u64; // token_a vault before seeding, i.e. the LP-owned reserve
        let lp_b = 2_000_000u64;
        let vault_a_before = lp_a + protocol_fee_a;
        // Strictly between lp_a and lp_b: rejected by the correct arm
        // (compares against lp_a), wrongly allowed by a swapped arm
        // (would compare against lp_b instead).
        let destination_a_amount = lp_a + 1;
        assert!(destination_a_amount > lp_a && destination_a_amount < lp_b);
        assert!(destination_a_amount <= vault_a_before);

        // A fresh, empty destination account for the withdrawn token A —
        // the withdrawer is `user_key`, who already holds 100% of the
        // pool mint supply from `rb_fixture`'s initial deposit.
        let (dest_a_key, mut dest_a_account, _b_key, _b_account, _pool_key, _pool_account) =
            accounts.setup_token_accounts(&user_key, &user_key, 0, 0, 0);

        let pool_token_key = accounts.pool_token_key;
        let mut pool_token_account = accounts.pool_token_account.clone();

        let result = accounts.withdraw_single_token_type_exact_amount_out(
            &user_key,
            &pool_token_key,
            &mut pool_token_account,
            &dest_a_key,
            &mut dest_a_account,
            destination_a_amount,
            u64::MAX,
        );

        // The clamp must reject the drain outright — nothing moves, the
        // pool is never bricked.
        assert_eq!(
            result,
            Err(SwapError::ExceededLpReserve.into()),
            "expected the clamp to reject an exact-out beyond the LP-owned reserve: {result:?}"
        );

        let dest_balance =
            StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;
        assert_eq!(dest_balance, 0, "rejected withdrawal must move nothing");

        let vault_a_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data)
                .unwrap()
                .base
                .amount;
        let data = accounts.swap_account.data.clone();
        let v2 = SwapV2::unpack_from_slice(&data[1..]).unwrap();
        assert_eq!(vault_a_after, vault_a_before, "vault untouched by the rejected withdrawal");
        assert!(
            vault_a_after >= v2.protocol_fees_a,
            "pool must stay healthy: vault_a ({vault_a_after}) >= protocol_fees_a ({})",
            v2.protocol_fees_a
        );
    }

    /// X11 (deposit_single site): LP minted for a fixed source-token
    /// deposit on a seeded-counter pool must equal the no-counter twin's
    /// mint exactly (same seed-is-additive reasoning as X5/X12 above).
    #[test]
    fn test_deposit_single_excludes_counters() {
        let (mut plain, plain_user) = rb_fixture(1_000_000, 2_000_000);
        let (mut seeded, seeded_user) = rb_fixture(1_000_000, 2_000_000);
        seed_protocol_fees(&mut seeded, 100_000, 200_000);

        let deposit_amount = 50_000u64;
        let mint = |accounts: &mut SwapAccountInfo, user_key: &Pubkey| -> u64 {
            let depositor_key = Pubkey::new_unique();
            let (token_a_key, mut token_a_account, _token_b_key, _token_b_account, pool_key, mut pool_account) =
                accounts.setup_token_accounts(user_key, &depositor_key, 1_000_000, 0, 0);
            accounts
                .deposit_single_token_type_exact_amount_in(
                    &depositor_key,
                    &token_a_key,
                    &mut token_a_account,
                    &pool_key,
                    &mut pool_account,
                    deposit_amount,
                    0,
                )
                .unwrap();
            StateWithExtensions::<Account>::unpack(&pool_account.data).unwrap().base.amount
        };

        let plain_mint = mint(&mut plain, &plain_user);
        let seeded_mint = mint(&mut seeded, &seeded_user);
        assert_eq!(
            seeded_mint, plain_mint,
            "seeded mint must equal the no-counter twin's mint (raw vault is larger but must not be read)"
        );
    }

    // =======================================================================
    // The authority model.
    // =======================================================================

    // ---- Step 0: stub-dispatcher probe -----------------------------------

    /// A system Transfer with `from.is_signer == false` must be refused
    /// by the stub — the M target for `test_system_transfer`'s own signer
    /// check.
    #[test]
    fn test_stub_transfer_requires_signer() {
        let from_key = Pubkey::new_unique();
        let to_key = Pubkey::new_unique();
        let mut from_account = SolanaAccount::new(1_000_000, 0, &system_program::id());
        let mut to_account = SolanaAccount::new(0, 0, &system_program::id());
        let mut meta = vec![
            (&from_key, false, &mut from_account),
            (&to_key, false, &mut to_account),
        ];
        let account_infos = create_is_signer_account_infos(&mut meta);
        let mut data = vec![0u8; 12];
        data[0..4].copy_from_slice(&2u32.to_le_bytes());
        data[4..12].copy_from_slice(&100u64.to_le_bytes());
        let err = test_system_transfer(&data, &account_infos).unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    /// A system Allocate whose target shell is NOT pre-sized to exactly
    /// `space` must be refused — the M target for `test_system_allocate`'s
    /// own pre-sizing assert.
    #[test]
    fn test_stub_allocate_requires_exact_size() {
        let account_key = Pubkey::new_unique();
        // Shell sized 10, but the instruction requests 98 (ProtocolConfig::LEN).
        let mut account = SolanaAccount::new(0, 10, &system_program::id());
        let mut meta = vec![(&account_key, true, &mut account)];
        let account_infos = create_is_signer_account_infos(&mut meta);
        let mut data = vec![0u8; 12];
        data[0..4].copy_from_slice(&8u32.to_le_bytes());
        data[4..12].copy_from_slice(&(ProtocolConfig::LEN as u64).to_le_bytes());
        let err = test_system_allocate(&data, &account_infos).unwrap_err();
        assert_eq!(err, ProgramError::AccountDataTooSmall);
    }

    // ---- Part A: InitializeConfig / SetTreasury / TransferAdmin / AcceptAdmin --

    /// Flattened low-level InitializeConfig runner for the adversarial
    /// surface — lets each test independently forge exactly one input
    /// (wrong signer key, unsigned, wrong programdata address/owner/shape).
    #[allow(clippy::too_many_arguments)]
    fn run_initialize_config_raw(
        payer_key: &Pubkey,
        payer_account: &mut SolanaAccount,
        authority_key: &Pubkey,
        authority_account: &mut SolanaAccount,
        authority_is_signer: bool,
        config_key: &Pubkey,
        config_account: &mut SolanaAccount,
        programdata_key: &Pubkey,
        programdata_account: &mut SolanaAccount,
        admin: Pubkey,
        treasury: Pubkey,
        mode: u8,
    ) -> ProgramResult {
        let mut ix = initialize_config(
            &SWAP_PROGRAM_ID,
            payer_key,
            authority_key,
            config_key,
            programdata_key,
            InitializeConfig {
                admin,
                treasury,
                mode,
            },
        )
        .unwrap();
        ix.accounts[1].is_signer = authority_is_signer;
        let mut system_program_dummy = SolanaAccount::default();
        do_process_instruction(
            ix,
            vec![
                payer_account,
                authority_account,
                config_account,
                programdata_account,
                &mut system_program_dummy,
            ],
        )
    }

    fn funded_payer() -> (Pubkey, SolanaAccount) {
        (
            Pubkey::new_unique(),
            SolanaAccount::new(10_000_000_000, 0, &system_program::id()),
        )
    }

    #[test]
    fn test_initialize_config_success() {
        let (payer_key, mut payer_account) = funded_payer();
        let mut config = ConfigFixture::new();
        let admin = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin, treasury, MODE_PERMISSIONLESS)
            .unwrap();

        let unpacked = ProtocolConfig::unpack_from_slice(&config.config_account.data).unwrap();
        assert_eq!(unpacked.version, CONFIG_VERSION);
        assert_eq!(unpacked.admin, admin);
        assert_eq!(unpacked.treasury, treasury);
        assert_eq!(unpacked.pending_admin, Pubkey::default());
        assert_eq!(unpacked.pool_creation_mode, MODE_PERMISSIONLESS);
        assert_eq!(config.config_account.owner, SWAP_PROGRAM_ID);
        let rent = Rent::default();
        assert_eq!(config.config_account.lamports, rent.minimum_balance(ProtocolConfig::LEN));
    }

    #[test]
    fn test_initialize_config_wrong_authority() {
        let ConfigFixture {
            config_key,
            mut config_account,
            programdata_key,
            mut programdata_account,
            ..
        } = ConfigFixture::new(); // programdata says authority = the fixture's OWN upgrade_authority_key
        let (payer_key, mut payer_account) = funded_payer();
        let wrong_authority_key = Pubkey::new_unique();
        let mut wrong_authority_account = SolanaAccount::new(0, 0, &system_program::id());
        let err = run_initialize_config_raw(
            &payer_key,
            &mut payer_account,
            &wrong_authority_key,
            &mut wrong_authority_account,
            true,
            &config_key,
            &mut config_account,
            &programdata_key,
            &mut programdata_account,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            MODE_PERMISSIONLESS,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::InvalidConfigAuthority.into());
    }

    #[test]
    fn test_initialize_config_unsigned_authority() {
        let ConfigFixture {
            upgrade_authority_key,
            mut upgrade_authority_account,
            config_key,
            mut config_account,
            programdata_key,
            mut programdata_account,
        } = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let err = run_initialize_config_raw(
            &payer_key,
            &mut payer_account,
            &upgrade_authority_key,
            &mut upgrade_authority_account,
            false,
            &config_key,
            &mut config_account,
            &programdata_key,
            &mut programdata_account,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            MODE_PERMISSIONLESS,
        )
        .unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    /// M-A1, the phase's load-bearing mutant: a well-formed ProgramData
    /// account at a DIFFERENT address must be refused — the address is
    /// DERIVED, never trusted.
    #[test]
    fn test_initialize_config_forged_programdata_address() {
        let ConfigFixture {
            upgrade_authority_key,
            mut upgrade_authority_account,
            config_key,
            mut config_account,
            mut programdata_account,
            ..
        } = ConfigFixture::new();
        let forged_programdata_key = Pubkey::new_unique();
        let (payer_key, mut payer_account) = funded_payer();
        let err = run_initialize_config_raw(
            &payer_key,
            &mut payer_account,
            &upgrade_authority_key,
            &mut upgrade_authority_account,
            true,
            &config_key,
            &mut config_account,
            &forged_programdata_key,
            &mut programdata_account,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            MODE_PERMISSIONLESS,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::InvalidProgramData.into());
    }

    #[test]
    fn test_initialize_config_wrong_programdata_owner() {
        let ConfigFixture {
            upgrade_authority_key,
            mut upgrade_authority_account,
            config_key,
            mut config_account,
            programdata_key,
            mut programdata_account,
        } = ConfigFixture::new();
        programdata_account.owner = system_program::id();
        let (payer_key, mut payer_account) = funded_payer();
        let err = run_initialize_config_raw(
            &payer_key,
            &mut payer_account,
            &upgrade_authority_key,
            &mut upgrade_authority_account,
            true,
            &config_key,
            &mut config_account,
            &programdata_key,
            &mut programdata_account,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            MODE_PERMISSIONLESS,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::InvalidProgramData.into());
    }

    #[test]
    fn test_initialize_config_wrong_discriminant() {
        let ConfigFixture {
            upgrade_authority_key,
            mut upgrade_authority_account,
            config_key,
            mut config_account,
            programdata_key,
            mut programdata_account,
        } = ConfigFixture::new();
        programdata_account.data[0..4].copy_from_slice(&2u32.to_le_bytes()); // Program, not ProgramData
        let (payer_key, mut payer_account) = funded_payer();
        let err = run_initialize_config_raw(
            &payer_key,
            &mut payer_account,
            &upgrade_authority_key,
            &mut upgrade_authority_account,
            true,
            &config_key,
            &mut config_account,
            &programdata_key,
            &mut programdata_account,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            MODE_PERMISSIONLESS,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::InvalidProgramData.into());
    }

    /// `verify_program_data`'s `.get(..45)` guard must refuse a short
    /// ProgramData account with the named error, not panic on the
    /// unchecked `head[0..4]`/`head[12]`/`head[13..45]` slicing below it.
    #[test]
    fn test_initialize_config_short_programdata() {
        let ConfigFixture {
            upgrade_authority_key,
            mut upgrade_authority_account,
            config_key,
            mut config_account,
            programdata_key,
            mut programdata_account,
        } = ConfigFixture::new();
        programdata_account.data.truncate(44); // one byte short of the 45-byte head
        let (payer_key, mut payer_account) = funded_payer();
        let err = run_initialize_config_raw(
            &payer_key,
            &mut payer_account,
            &upgrade_authority_key,
            &mut upgrade_authority_account,
            true,
            &config_key,
            &mut config_account,
            &programdata_key,
            &mut programdata_account,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            MODE_PERMISSIONLESS,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::InvalidProgramData.into());
    }

    #[test]
    fn test_initialize_config_immutable_program() {
        let ConfigFixture {
            upgrade_authority_key,
            mut upgrade_authority_account,
            config_key,
            mut config_account,
            programdata_key,
            mut programdata_account,
        } = ConfigFixture::new();
        programdata_account.data[12] = 0; // Option flag = None
        let (payer_key, mut payer_account) = funded_payer();
        let err = run_initialize_config_raw(
            &payer_key,
            &mut payer_account,
            &upgrade_authority_key,
            &mut upgrade_authority_account,
            true,
            &config_key,
            &mut config_account,
            &programdata_key,
            &mut programdata_account,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            MODE_PERMISSIONLESS,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::ImmutableProgram.into());
    }

    #[test]
    fn test_initialize_config_double_init() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        config
            .init_config(
                &payer_key,
                &mut payer_account,
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                MODE_PERMISSIONLESS,
            )
            .unwrap();
        let err = config
            .init_config(
                &payer_key,
                &mut payer_account,
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                MODE_PERMISSIONLESS,
            )
            .unwrap_err();
        assert_eq!(err, SwapError::ConfigAlreadyInitialized.into());
    }

    /// The grief case: pre-funding the config PDA with 1 lamport
    /// must NOT brick `InitializeConfig` — under bare `create_account` this
    /// fails `AccountAlreadyInitialized`; under the grief-proof helper it
    /// succeeds and ends rent-exempt.
    #[test]
    fn test_initialize_config_prefunded_pda_succeeds() {
        let mut config = ConfigFixture::new();
        config.config_account.lamports = 1;
        let (payer_key, mut payer_account) = funded_payer();
        let admin = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin, treasury, MODE_PERMISSIONLESS)
            .unwrap();
        let unpacked = ProtocolConfig::unpack_from_slice(&config.config_account.data).unwrap();
        assert_eq!(unpacked.version, CONFIG_VERSION);
        let rent = Rent::default();
        assert_eq!(config.config_account.lamports, rent.minimum_balance(ProtocolConfig::LEN));
    }

    #[test]
    fn test_initialize_config_default_admin() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let err = config
            .init_config(
                &payer_key,
                &mut payer_account,
                Pubkey::default(),
                Pubkey::new_unique(),
                MODE_PERMISSIONLESS,
            )
            .unwrap_err();
        assert_eq!(err, SwapError::InvalidConfigValue.into());
    }

    #[test]
    fn test_initialize_config_default_treasury() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let err = config
            .init_config(
                &payer_key,
                &mut payer_account,
                Pubkey::new_unique(),
                Pubkey::default(),
                MODE_PERMISSIONLESS,
            )
            .unwrap_err();
        assert_eq!(err, SwapError::InvalidConfigValue.into());
    }

    #[test]
    fn test_initialize_config_bad_mode() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let err = config
            .init_config(&payer_key, &mut payer_account, Pubkey::new_unique(), Pubkey::new_unique(), 2)
            .unwrap_err();
        assert_eq!(err, SwapError::InvalidPoolCreationMode.into());
    }

    #[test]
    fn test_initialize_config_wrong_config_address() {
        let ConfigFixture {
            upgrade_authority_key,
            mut upgrade_authority_account,
            mut config_account,
            programdata_key,
            mut programdata_account,
            ..
        } = ConfigFixture::new();
        let wrong_config_key = Pubkey::new_unique();
        let (payer_key, mut payer_account) = funded_payer();
        let err = run_initialize_config_raw(
            &payer_key,
            &mut payer_account,
            &upgrade_authority_key,
            &mut upgrade_authority_account,
            true,
            &wrong_config_key,
            &mut config_account,
            &programdata_key,
            &mut programdata_account,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            MODE_PERMISSIONLESS,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::InvalidProgramAddress.into());
    }

    #[test]
    fn test_set_treasury_success() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        let treasury_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, treasury_key, MODE_PERMISSIONLESS)
            .unwrap();

        let new_treasury = Pubkey::new_unique();
        let ix = set_treasury(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            SetTreasury { treasury: new_treasury },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix, vec![&mut config.config_account, &mut admin_dummy]).unwrap();
        let unpacked = ProtocolConfig::unpack_from_slice(&config.config_account.data).unwrap();
        assert_eq!(unpacked.treasury, new_treasury);
        assert_eq!(unpacked.admin, admin_key); // untouched
    }

    #[test]
    fn test_set_treasury_not_admin() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let non_admin_key = Pubkey::new_unique();
        let ix = set_treasury(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &non_admin_key,
            SetTreasury { treasury: Pubkey::new_unique() },
        )
        .unwrap();
        let mut non_admin_dummy = SolanaAccount::default();
        let err =
            do_process_instruction(ix, vec![&mut config.config_account, &mut non_admin_dummy]).unwrap_err();
        assert_eq!(err, SwapError::NotAdmin.into());
    }

    #[test]
    fn test_set_treasury_unsigned_admin() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let mut ix = set_treasury(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            SetTreasury { treasury: Pubkey::new_unique() },
        )
        .unwrap();
        ix.accounts[1].is_signer = false;
        let mut admin_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix, vec![&mut config.config_account, &mut admin_dummy]).unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    #[test]
    fn test_set_treasury_no_config() {
        let config = ConfigFixture::new(); // never initialized
        let mut config_account = config.config_account;
        let admin_key = Pubkey::new_unique();
        let ix = set_treasury(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            SetTreasury { treasury: Pubkey::new_unique() },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix, vec![&mut config_account, &mut admin_dummy]).unwrap_err();
        assert_eq!(err, SwapError::ConfigNotInitialized.into());
    }

    #[test]
    fn test_set_treasury_default() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let ix = set_treasury(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            SetTreasury { treasury: Pubkey::default() },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix, vec![&mut config.config_account, &mut admin_dummy]).unwrap_err();
        assert_eq!(err, SwapError::InvalidConfigValue.into());
    }

    /// A config-SHAPED account at a WRONG (non-derived) address, with an
    /// attacker-chosen admin — `load_config`'s derivation compare must fire
    /// BEFORE any field of the forged account is trusted.
    #[test]
    fn test_set_treasury_forged_config() {
        let forged_config_key = Pubkey::new_unique();
        let attacker_key = Pubkey::new_unique();
        let forged = ProtocolConfig {
            version: CONFIG_VERSION,
            admin: attacker_key,
            pending_admin: Pubkey::default(),
            treasury: Pubkey::new_unique(),
            pool_creation_mode: MODE_PERMISSIONLESS,
        };
        let mut forged_account = SolanaAccount::new(0, ProtocolConfig::LEN, &SWAP_PROGRAM_ID);
        forged.pack_into_slice(&mut forged_account.data);
        let ix = set_treasury(
            &SWAP_PROGRAM_ID,
            &forged_config_key,
            &attacker_key,
            SetTreasury { treasury: Pubkey::new_unique() },
        )
        .unwrap();
        let mut attacker_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix, vec![&mut forged_account, &mut attacker_dummy]).unwrap_err();
        assert_eq!(err, SwapError::InvalidProgramAddress.into());
    }

    #[test]
    fn test_transfer_admin_sets_pending_only() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let new_pending = Pubkey::new_unique();
        let ix = transfer_admin(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            TransferAdmin { pending_admin: new_pending },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix, vec![&mut config.config_account, &mut admin_dummy]).unwrap();
        let unpacked = ProtocolConfig::unpack_from_slice(&config.config_account.data).unwrap();
        assert_eq!(unpacked.admin, admin_key, "admin UNCHANGED until AcceptAdmin");
        assert_eq!(unpacked.pending_admin, new_pending);
    }

    #[test]
    fn test_transfer_admin_not_admin() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let non_admin_key = Pubkey::new_unique();
        let ix = transfer_admin(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &non_admin_key,
            TransferAdmin { pending_admin: Pubkey::new_unique() },
        )
        .unwrap();
        let mut non_admin_dummy = SolanaAccount::default();
        let err =
            do_process_instruction(ix, vec![&mut config.config_account, &mut non_admin_dummy]).unwrap_err();
        assert_eq!(err, SwapError::NotAdmin.into());
    }

    #[test]
    fn test_accept_admin_success() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let new_admin = Pubkey::new_unique();
        let ix_transfer = transfer_admin(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            TransferAdmin { pending_admin: new_admin },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix_transfer, vec![&mut config.config_account, &mut admin_dummy]).unwrap();

        let ix_accept = accept_admin(&SWAP_PROGRAM_ID, &config.config_key, &new_admin).unwrap();
        let mut pending_dummy = SolanaAccount::default();
        do_process_instruction(ix_accept, vec![&mut config.config_account, &mut pending_dummy]).unwrap();

        let unpacked = ProtocolConfig::unpack_from_slice(&config.config_account.data).unwrap();
        assert_eq!(unpacked.admin, new_admin);
        assert_eq!(unpacked.pending_admin, Pubkey::default(), "cleared on accept");
    }

    #[test]
    fn test_accept_admin_wrong_key() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let new_admin = Pubkey::new_unique();
        let ix_transfer = transfer_admin(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            TransferAdmin { pending_admin: new_admin },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix_transfer, vec![&mut config.config_account, &mut admin_dummy]).unwrap();

        let wrong_key = Pubkey::new_unique();
        let ix_accept = accept_admin(&SWAP_PROGRAM_ID, &config.config_key, &wrong_key).unwrap();
        let mut wrong_dummy = SolanaAccount::default();
        let err =
            do_process_instruction(ix_accept, vec![&mut config.config_account, &mut wrong_dummy]).unwrap_err();
        assert_eq!(err, SwapError::NotPendingAdmin.into());
    }

    #[test]
    fn test_accept_admin_unsigned() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let new_admin = Pubkey::new_unique();
        let ix_transfer = transfer_admin(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            TransferAdmin { pending_admin: new_admin },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix_transfer, vec![&mut config.config_account, &mut admin_dummy]).unwrap();

        let mut ix_accept = accept_admin(&SWAP_PROGRAM_ID, &config.config_key, &new_admin).unwrap();
        ix_accept.accounts[1].is_signer = false;
        let mut pending_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix_accept, vec![&mut config.config_account, &mut pending_dummy])
            .unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    #[test]
    fn test_accept_admin_none_pending() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        config
            .init_config(&payer_key, &mut payer_account, Pubkey::new_unique(), Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let some_signer = Pubkey::new_unique();
        let ix_accept = accept_admin(&SWAP_PROGRAM_ID, &config.config_key, &some_signer).unwrap();
        let mut some_dummy = SolanaAccount::default();
        let err =
            do_process_instruction(ix_accept, vec![&mut config.config_account, &mut some_dummy]).unwrap_err();
        assert_eq!(err, SwapError::NotPendingAdmin.into());
    }

    #[test]
    fn test_transfer_admin_cancel() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let proposed_pending = Pubkey::new_unique();
        let ix1 = transfer_admin(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            TransferAdmin { pending_admin: proposed_pending },
        )
        .unwrap();
        let mut admin_dummy1 = SolanaAccount::default();
        do_process_instruction(ix1, vec![&mut config.config_account, &mut admin_dummy1]).unwrap();

        // Cancel: TransferAdmin(default) clears pending.
        let ix2 = transfer_admin(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            TransferAdmin { pending_admin: Pubkey::default() },
        )
        .unwrap();
        let mut admin_dummy2 = SolanaAccount::default();
        do_process_instruction(ix2, vec![&mut config.config_account, &mut admin_dummy2]).unwrap();
        let unpacked = ProtocolConfig::unpack_from_slice(&config.config_account.data).unwrap();
        assert_eq!(unpacked.pending_admin, Pubkey::default());

        // The previously-proposed key can no longer accept.
        let ix_accept = accept_admin(&SWAP_PROGRAM_ID, &config.config_key, &proposed_pending).unwrap();
        let mut proposed_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix_accept, vec![&mut config.config_account, &mut proposed_dummy])
            .unwrap_err();
        assert_eq!(err, SwapError::NotPendingAdmin.into());
    }

    #[test]
    fn test_old_admin_retains_until_accept() {
        let mut config = ConfigFixture::new();
        let (payer_key, mut payer_account) = funded_payer();
        let admin_key = Pubkey::new_unique();
        config
            .init_config(&payer_key, &mut payer_account, admin_key, Pubkey::new_unique(), MODE_PERMISSIONLESS)
            .unwrap();
        let new_admin = Pubkey::new_unique();
        let ix_transfer = transfer_admin(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            TransferAdmin { pending_admin: new_admin },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix_transfer, vec![&mut config.config_account, &mut admin_dummy]).unwrap();

        // No typo-brick window: the OLD admin still passes SetTreasury.
        let ix_set = set_treasury(
            &SWAP_PROGRAM_ID,
            &config.config_key,
            &admin_key,
            SetTreasury { treasury: Pubkey::new_unique() },
        )
        .unwrap();
        let mut admin_dummy2 = SolanaAccount::default();
        do_process_instruction(ix_set, vec![&mut config.config_account, &mut admin_dummy2]).unwrap();
    }

    // ---- Part C: CreatePool policy gate + SetPoolCreation ----------------

    /// The definitive red this closes: at pre-v2 HEAD, CreatePool had
    /// no gate at all and SUCCEEDED with no config. Post-v2, absence
    /// fails CLOSED.
    #[test]
    fn test_create_pool_no_config() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.config_account = SolanaAccount::new(0, ProtocolConfig::LEN, &system_program::id());
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::PoolCreationNotConfigured.into());
    }

    #[test]
    fn test_create_pool_mode0_non_admin() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        let ix = set_pool_creation(
            &SWAP_PROGRAM_ID,
            &fx.config_key,
            &fx.admin_key,
            SetPoolCreation { mode: MODE_ADMIN_ONLY },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix, vec![&mut fx.config_account, &mut admin_dummy]).unwrap();

        assert_ne!(fx.payer_key, fx.admin_key);
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::PoolCreationRestricted.into());
    }

    #[test]
    fn test_create_pool_mode0_admin_payer_succeeds() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        let ix = set_pool_creation(
            &SWAP_PROGRAM_ID,
            &fx.config_key,
            &fx.admin_key,
            SetPoolCreation { mode: MODE_ADMIN_ONLY },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix, vec![&mut fx.config_account, &mut admin_dummy]).unwrap();

        fx.payer_key = fx.admin_key; // payer IS the admin
        run_create_pool(&mut fx, &None).unwrap();
    }

    #[test]
    fn test_create_pool_mode1_any_payer_succeeds() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        assert_ne!(fx.payer_key, fx.admin_key, "permissionlessness must be meaningful here");
        run_create_pool(&mut fx, &None).unwrap();
    }

    #[test]
    fn test_set_pool_creation_flip() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        let ix0 = set_pool_creation(
            &SWAP_PROGRAM_ID,
            &fx.config_key,
            &fx.admin_key,
            SetPoolCreation { mode: MODE_ADMIN_ONLY },
        )
        .unwrap();
        let mut admin_dummy0 = SolanaAccount::default();
        do_process_instruction(ix0, vec![&mut fx.config_account, &mut admin_dummy0]).unwrap();
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::PoolCreationRestricted.into());

        let ix1 = set_pool_creation(
            &SWAP_PROGRAM_ID,
            &fx.config_key,
            &fx.admin_key,
            SetPoolCreation { mode: MODE_PERMISSIONLESS },
        )
        .unwrap();
        let mut admin_dummy1 = SolanaAccount::default();
        do_process_instruction(ix1, vec![&mut fx.config_account, &mut admin_dummy1]).unwrap();
        run_create_pool(&mut fx, &None).unwrap();
    }

    #[test]
    fn test_set_pool_creation_not_admin() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        let non_admin_key = Pubkey::new_unique();
        let ix = set_pool_creation(
            &SWAP_PROGRAM_ID,
            &fx.config_key,
            &non_admin_key,
            SetPoolCreation { mode: MODE_ADMIN_ONLY },
        )
        .unwrap();
        let mut non_admin_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix, vec![&mut fx.config_account, &mut non_admin_dummy]).unwrap_err();
        assert_eq!(err, SwapError::NotAdmin.into());
    }

    #[test]
    fn test_set_pool_creation_bad_mode() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        let ix = set_pool_creation(
            &SWAP_PROGRAM_ID,
            &fx.config_key,
            &fx.admin_key,
            SetPoolCreation { mode: 2 },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix, vec![&mut fx.config_account, &mut admin_dummy]).unwrap_err();
        assert_eq!(err, SwapError::InvalidPoolCreationMode.into());
    }

    #[test]
    fn test_set_pool_creation_no_config() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.config_account = SolanaAccount::new(0, ProtocolConfig::LEN, &system_program::id());
        let ix = set_pool_creation(
            &SWAP_PROGRAM_ID,
            &fx.config_key,
            &fx.admin_key,
            SetPoolCreation { mode: MODE_PERMISSIONLESS },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        let err = do_process_instruction(ix, vec![&mut fx.config_account, &mut admin_dummy]).unwrap_err();
        assert_eq!(err, SwapError::ConfigNotInitialized.into());
    }

    /// M-C4: mode ≥ 2 can never be WRITTEN by the setters (they validate
    /// ≤ 1) — hand-forging it is the ONE deliberate hand-packed-state
    /// exception, proving the fail-closed branch has no permissive third arm
    /// even for a state the program itself would never produce.
    #[test]
    fn test_create_pool_forged_mode_falls_closed() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        let mut forged = ProtocolConfig::unpack_from_slice(&fx.config_account.data).unwrap();
        forged.pool_creation_mode = 7;
        forged.pack_into_slice(&mut fx.config_account.data);
        assert_ne!(fx.payer_key, fx.admin_key);
        let err = run_create_pool(&mut fx, &None).unwrap_err();
        assert_eq!(err, SwapError::PoolCreationRestricted.into());
    }

    // ---- Part D: grief-proof CreatePool PDA creation ----------------------

    #[test]
    fn test_create_pool_prefunded_pool_pda_succeeds() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.pool_account.lamports = 1;
        run_create_pool(&mut fx, &None).unwrap();
        let swap_state = SwapVersion::unpack(&fx.pool_account.data).unwrap();
        assert!(swap_state.is_initialized());
    }

    #[test]
    fn test_create_pool_prefunded_lp_mint_pda_succeeds() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.lp_mint_account.lamports = 1;
        run_create_pool(&mut fx, &None).unwrap();
    }

    #[test]
    fn test_create_pool_prefunded_dest_pda_succeeds() {
        let mut fx = behavior_fixture(&spl_token::id(), &spl_token::id(), &spl_token::id());
        fx.dest_account.lamports = 1;
        run_create_pool(&mut fx, &None).unwrap();
    }

    // ---- Part B: CollectProtocolFees + the outflow invariant --------

    fn treasury_dest_accounts(
        accounts: &mut SwapAccountInfo,
        mint_authority_key: &Pubkey,
    ) -> (Pubkey, SolanaAccount, Pubkey, SolanaAccount) {
        let token_a_program_id = accounts.token_a_program_id;
        let token_b_program_id = accounts.token_b_program_id;
        let treasury_key = accounts.treasury_key;
        let (dest_a_key, dest_a_account) = mint_token(
            &token_a_program_id,
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            mint_authority_key,
            &treasury_key,
            0,
        );
        let (dest_b_key, dest_b_account) = mint_token(
            &token_b_program_id,
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            mint_authority_key,
            &treasury_key,
            0,
        );
        (dest_a_key, dest_a_account, dest_b_key, dest_b_account)
    }

    fn collect_ix(accounts: &SwapAccountInfo, dest_a: &Pubkey, dest_b: &Pubkey) -> Instruction {
        collect_protocol_fees(
            &SWAP_PROGRAM_ID,
            &accounts.swap_key,
            &accounts.authority_key,
            &accounts.token_a_key,
            &accounts.token_b_key,
            dest_a,
            dest_b,
            &accounts.token_a_mint_key,
            &accounts.token_b_mint_key,
            &accounts.config_key,
            &accounts.token_a_program_id,
            &accounts.token_b_program_id,
        )
        .unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn run_collect(
        accounts: &mut SwapAccountInfo,
        dest_a_key: &Pubkey,
        dest_a_account: &mut SolanaAccount,
        dest_b_key: &Pubkey,
        dest_b_account: &mut SolanaAccount,
    ) -> ProgramResult {
        let ix = collect_ix(accounts, dest_a_key, dest_b_key);
        let mut authority_dummy = SolanaAccount::default();
        let mut mint_a_dummy = accounts.token_a_mint_account.clone();
        let mut mint_b_dummy = accounts.token_b_mint_account.clone();
        let mut config_dummy = accounts.config_account.clone();
        let mut token_program_a_dummy = SolanaAccount::default();
        let mut token_program_b_dummy = SolanaAccount::default();
        do_process_instruction(
            ix,
            vec![
                &mut accounts.swap_account,
                &mut authority_dummy,
                &mut accounts.token_a_account,
                &mut accounts.token_b_account,
                dest_a_account,
                dest_b_account,
                &mut mint_a_dummy,
                &mut mint_b_dummy,
                &mut config_dummy,
                &mut token_program_a_dummy,
                &mut token_program_b_dummy,
            ],
        )
    }

    /// Per-side programs (NOT hardcoded `spl_token::id()`) so this also
    /// works unchanged on a mixed-vault fixture (`rb_fixture_mixed`) —
    /// behavior-neutral for every existing single-program caller, since
    /// `token_a_program_id == token_b_program_id` there.
    fn accrue_both_directions(accounts: &mut SwapAccountInfo, user_key: &Pubkey) {
        let swapper_key = Pubkey::new_unique();
        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;
        let token_a_program_id = accounts.token_a_program_id;
        let token_b_program_id = accounts.token_b_program_id;

        let (user_a_key, mut user_a_account) = mint_token(
            &token_a_program_id,
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            user_key,
            &swapper_key,
            100_000,
        );
        let (user_b_key, mut user_b_account) = mint_token(
            &token_b_program_id,
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            user_key,
            &swapper_key,
            0,
        );
        accounts
            .swap(
                &swapper_key,
                &user_a_key,
                &mut user_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &user_b_key,
                &mut user_b_account,
                100_000,
                0,
            )
            .unwrap();

        let (user_b2_key, mut user_b2_account) = mint_token(
            &token_b_program_id,
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            user_key,
            &swapper_key,
            200_000,
        );
        let (user_a2_key, mut user_a2_account) = mint_token(
            &token_a_program_id,
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            user_key,
            &swapper_key,
            0,
        );
        accounts
            .swap(
                &swapper_key,
                &user_b2_key,
                &mut user_b2_account,
                &swap_token_b_key,
                &swap_token_a_key,
                &user_a2_key,
                &mut user_a2_account,
                200_000,
                0,
            )
            .unwrap();
    }

    /// Mixed-vault pool: vault A runs Token-2022,
    /// vault B runs classic SPL — a SUPPORTED, test-pinned shape (the
    /// "mixed-pool-token-2022" `test_case` rows above `test_deposit` et
    /// al.: `(pool_token_program_id, token_a_program_id, token_b_program_id)
    /// = (spl_token_2022, spl_token_2022, spl_token)`).
    fn rb_fixture_mixed(token_a_amount: u64, token_b_amount: u64) -> (SwapAccountInfo, Pubkey) {
        let user_key = Pubkey::new_unique();
        let fees = Fees {
            trade_fee_numerator: 1,
            trade_fee_denominator: 10,
            owner_trade_fee_numerator: 1,
            owner_trade_fee_denominator: 10,
            owner_withdraw_fee_numerator: 0,
            owner_withdraw_fee_denominator: 0,
            host_fee_numerator: 0,
            host_fee_denominator: 0,
        };
        let swap_curve = SwapCurve {
            curve_type: CurveType::ConstantProduct,
            calculator: Arc::new(ConstantProductCurve {}),
        };
        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            SwapTransferFees::default(),
            swap_curve,
            token_a_amount,
            token_b_amount,
            &spl_token_2022::id(),
            &spl_token_2022::id(),
            &spl_token::id(),
        );
        accounts.initialize_swap().unwrap();
        (accounts, user_key)
    }

    #[test]
    fn test_collect_moves_exactly_counters_and_zeroes() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);

        let swap_state = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        let counter_a_before = swap_state.protocol_fees_a();
        let counter_b_before = swap_state.protocol_fees_b();
        assert!(counter_a_before > 0);
        assert!(counter_b_before > 0);

        let vault_a_before =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        let vault_b_before =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap().base.amount;

        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        let dest_a_before =
            StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;
        let dest_b_before =
            StateWithExtensions::<Account>::unpack(&dest_b_account.data).unwrap().base.amount;

        run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap();

        let vault_a_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        let vault_b_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap().base.amount;
        let dest_a_after =
            StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;
        let dest_b_after =
            StateWithExtensions::<Account>::unpack(&dest_b_account.data).unwrap().base.amount;

        // I1: conservation, exact.
        assert_eq!(vault_a_after, vault_a_before - counter_a_before);
        assert_eq!(vault_b_after, vault_b_before - counter_b_before);
        assert_eq!(dest_a_after, dest_a_before + counter_a_before);
        assert_eq!(dest_b_after, dest_b_before + counter_b_before);

        // I2: reset.
        let swap_state_after = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        assert_eq!(swap_state_after.protocol_fees_a(), 0);
        assert_eq!(swap_state_after.protocol_fees_b(), 0);

        // I3: LP neutrality — the arithmetic identity.
        assert_eq!(vault_a_before - counter_a_before, vault_a_after);
        assert_eq!(vault_b_before - counter_b_before, vault_b_after);

        // Quote-parity probe: a twin pool built directly at the POST-COLLECT
        // LP-owned reserves (no counters) must quote an identical probe swap
        // — collect changes NOTHING pool math can see.
        let (mut twin, twin_user) = rb_fixture(vault_a_after, vault_b_after);
        let probe_amount = 10_000u64;
        let quote = |fx: &mut SwapAccountInfo, fx_user: &Pubkey| -> u64 {
            let prober_key = Pubkey::new_unique();
            let (prober_a_key, mut prober_a_account) = mint_token(
                &spl_token::id(),
                &fx.token_a_mint_key,
                &mut fx.token_a_mint_account,
                fx_user,
                &prober_key,
                probe_amount,
            );
            let (prober_b_key, mut prober_b_account) = mint_token(
                &spl_token::id(),
                &fx.token_b_mint_key,
                &mut fx.token_b_mint_account,
                fx_user,
                &prober_key,
                0,
            );
            let fx_token_a_key = fx.token_a_key;
            let fx_token_b_key = fx.token_b_key;
            fx.swap(
                &prober_key,
                &prober_a_key,
                &mut prober_a_account,
                &fx_token_a_key,
                &fx_token_b_key,
                &prober_b_key,
                &mut prober_b_account,
                probe_amount,
                0,
            )
            .unwrap();
            StateWithExtensions::<Account>::unpack(&prober_b_account.data).unwrap().base.amount
        };
        let collected_quote = quote(&mut accounts, &user_key);
        let twin_quote = quote(&mut twin, &twin_user);
        assert_eq!(
            collected_quote, twin_quote,
            "post-collect swap quote must match a fresh pool at the same LP-owned reserves"
        );
    }

    /// A mixed-vault pool (vault A = Token-2022,
    /// vault B = classic SPL) must be fully collectible in ONE call — each
    /// side served by its OWN token program. Pre-fix, a single shared
    /// program could only ever match one side's vault; the other side's
    /// `transfer_checked` CPI dispatched through the wrong token program
    /// and `IncorrectProgramId`'d out, reverting the whole instruction and
    /// permanently stranding that side's counter (no other instruction can
    /// move it either — `lp_owned` excludes it from LP withdraw too).
    #[test]
    fn test_collect_mixed_vault_programs() {
        let (mut accounts, user_key) = rb_fixture_mixed(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);

        let swap_state = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        let counter_a_before = swap_state.protocol_fees_a();
        let counter_b_before = swap_state.protocol_fees_b();
        assert!(counter_a_before > 0);
        assert!(counter_b_before > 0);

        let vault_a_before =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        let vault_b_before =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap().base.amount;

        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        let dest_a_before =
            StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;
        let dest_b_before =
            StateWithExtensions::<Account>::unpack(&dest_b_account.data).unwrap().base.amount;

        run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap();

        let vault_a_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        let vault_b_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap().base.amount;
        let dest_a_after =
            StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;
        let dest_b_after =
            StateWithExtensions::<Account>::unpack(&dest_b_account.data).unwrap().base.amount;

        // Both-sides invariant: each side debited/credited EXACTLY its own
        // counter, via its own program.
        assert_eq!(vault_a_after, vault_a_before - counter_a_before);
        assert_eq!(vault_b_after, vault_b_before - counter_b_before);
        assert_eq!(dest_a_after, dest_a_before + counter_a_before);
        assert_eq!(dest_b_after, dest_b_before + counter_b_before);

        let swap_state_after = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        assert_eq!(swap_state_after.protocol_fees_a(), 0);
        assert_eq!(swap_state_after.protocol_fees_b(), 0);
    }

    /// M-B10: a caller-supplied token program that does NOT match the side
    /// it's paired with must be refused by name (`IncorrectTokenProgramId`)
    /// — not by whatever the CPI happens to fail with several steps later.
    /// `rb_fixture` is single-program (both sides classic SPL); passing
    /// Token-2022 for side A while vault A is actually classic SPL pins the
    /// per-side check that guards mixed-vault correctness above.
    #[test]
    fn test_collect_wrong_side_a_token_program() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);
        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);

        let ix = collect_protocol_fees(
            &SWAP_PROGRAM_ID,
            &accounts.swap_key,
            &accounts.authority_key,
            &accounts.token_a_key,
            &accounts.token_b_key,
            &dest_a_key,
            &dest_b_key,
            &accounts.token_a_mint_key,
            &accounts.token_b_mint_key,
            &accounts.config_key,
            &spl_token_2022::id(), // WRONG: vault A is actually classic SPL
            &accounts.token_b_program_id,
        )
        .unwrap();
        let mut authority_dummy = SolanaAccount::default();
        let mut mint_a_dummy = accounts.token_a_mint_account.clone();
        let mut mint_b_dummy = accounts.token_b_mint_account.clone();
        let mut config_dummy = accounts.config_account.clone();
        let mut token_program_a_dummy = SolanaAccount::default();
        let mut token_program_b_dummy = SolanaAccount::default();
        let err = do_process_instruction(
            ix,
            vec![
                &mut accounts.swap_account,
                &mut authority_dummy,
                &mut accounts.token_a_account,
                &mut accounts.token_b_account,
                &mut dest_a_account,
                &mut dest_b_account,
                &mut mint_a_dummy,
                &mut mint_b_dummy,
                &mut config_dummy,
                &mut token_program_a_dummy,
                &mut token_program_b_dummy,
            ],
        )
        .unwrap_err();
        assert_eq!(err, SwapError::IncorrectTokenProgramId.into());
    }

    /// M-B10's B-side twin: the A-side check above has a mutant-reddening
    /// test; the B-side check (processor.rs's second `if *vault_b_info.owner
    /// != *token_program_b_info.key`) did not — closing that gap. Same
    /// `rb_fixture` (single-program, both sides classic SPL); passing
    /// Token-2022 for side B while vault B is actually classic SPL pins the
    /// B-side arm of the per-side check.
    #[test]
    fn test_collect_wrong_side_b_token_program() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);
        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);

        let ix = collect_protocol_fees(
            &SWAP_PROGRAM_ID,
            &accounts.swap_key,
            &accounts.authority_key,
            &accounts.token_a_key,
            &accounts.token_b_key,
            &dest_a_key,
            &dest_b_key,
            &accounts.token_a_mint_key,
            &accounts.token_b_mint_key,
            &accounts.config_key,
            &accounts.token_a_program_id,
            &spl_token_2022::id(), // WRONG: vault B is actually classic SPL
        )
        .unwrap();
        let mut authority_dummy = SolanaAccount::default();
        let mut mint_a_dummy = accounts.token_a_mint_account.clone();
        let mut mint_b_dummy = accounts.token_b_mint_account.clone();
        let mut config_dummy = accounts.config_account.clone();
        let mut token_program_a_dummy = SolanaAccount::default();
        let mut token_program_b_dummy = SolanaAccount::default();
        let err = do_process_instruction(
            ix,
            vec![
                &mut accounts.swap_account,
                &mut authority_dummy,
                &mut accounts.token_a_account,
                &mut accounts.token_b_account,
                &mut dest_a_account,
                &mut dest_b_account,
                &mut mint_a_dummy,
                &mut mint_b_dummy,
                &mut config_dummy,
                &mut token_program_a_dummy,
                &mut token_program_b_dummy,
            ],
        )
        .unwrap_err();
        assert_eq!(err, SwapError::IncorrectTokenProgramId.into());
    }

    #[test]
    fn test_collect_second_call_moves_zero() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);

        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap();

        let vault_a_mid =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        let vault_b_mid =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap().base.amount;
        let dest_a_mid = StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;
        let dest_b_mid = StateWithExtensions::<Account>::unpack(&dest_b_account.data).unwrap().base.amount;

        run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap();

        let vault_a_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        let vault_b_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap().base.amount;
        let dest_a_after = StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;
        let dest_b_after = StateWithExtensions::<Account>::unpack(&dest_b_account.data).unwrap().base.amount;

        assert_eq!(vault_a_after, vault_a_mid);
        assert_eq!(vault_b_after, vault_b_mid);
        assert_eq!(dest_a_after, dest_a_mid);
        assert_eq!(dest_b_after, dest_b_mid);
    }

    #[test]
    fn test_collect_wrong_destination_owner() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);

        let random_key = Pubkey::new_unique();
        let (dest_a_key, mut dest_a_account) = mint_token(
            &spl_token::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &random_key, // NOT the treasury
            0,
        );
        let (_dest_b_key, _dest_b_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        let err = run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap_err();
        assert_eq!(err, SwapError::InvalidTreasuryDestination.into());
    }

    #[test]
    fn test_collect_dest_mint_mismatch() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);

        let treasury_key = accounts.treasury_key;
        // dest_a is a treasury-owned account of MINT B, not mint A.
        let (dest_a_key, mut dest_a_account) = mint_token(
            &spl_token::id(),
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            &user_key,
            &treasury_key,
            0,
        );
        let (_dest_a_key2, _dest_a_account2, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        let err = run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap_err();
        assert_eq!(err, SwapError::InvalidTreasuryDestination.into());
    }

    /// M-B9 isolation: a destination that IS a valid treasury account (right
    /// owner, right mint) but is referenced under vault_a's OWN key.
    #[test]
    fn test_collect_dest_is_vault() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);

        let vault_a_key = accounts.token_a_key;
        let treasury_key = accounts.treasury_key;
        let (_real_key, mut fake_dest_account) = mint_token(
            &spl_token::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &treasury_key,
            0,
        );
        let (_dest_a_key, _dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        let err = run_collect(
            &mut accounts,
            &vault_a_key, // dest_a KEY == vault_a's own key
            &mut fake_dest_account,
            &dest_b_key,
            &mut dest_b_account,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::InvalidTreasuryDestination.into());
    }

    #[test]
    fn test_collect_no_config() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accounts.config_account = SolanaAccount::new(0, ProtocolConfig::LEN, &system_program::id());
        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        let err = run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap_err();
        assert_eq!(err, SwapError::ConfigNotInitialized.into());
    }

    /// Property test — pins that no signer gate exists on any meta. No
    /// mutant claims this; it IS the assertion that nobody adds one.
    #[test]
    fn test_collect_permissionless() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);
        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        let ix = collect_ix(&accounts, &dest_a_key, &dest_b_key);
        assert!(
            ix.accounts.iter().all(|m| !m.is_signer),
            "CollectProtocolFees must be permissionless: no meta may require a signature"
        );
        run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap();
        let dest_a_amount =
            StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;
        assert!(dest_a_amount > 0);
    }

    #[test]
    fn test_collect_wrong_vault() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);

        let attacker_key = Pubkey::new_unique();
        let (attacker_vault_key, mut attacker_vault_account) = mint_token(
            &spl_token::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &attacker_key,
            0,
        );
        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        let ix = collect_protocol_fees(
            &SWAP_PROGRAM_ID,
            &accounts.swap_key,
            &accounts.authority_key,
            &attacker_vault_key,
            &accounts.token_b_key,
            &dest_a_key,
            &dest_b_key,
            &accounts.token_a_mint_key,
            &accounts.token_b_mint_key,
            &accounts.config_key,
            &accounts.token_a_program_id,
            &accounts.token_b_program_id,
        )
        .unwrap();
        let mut authority_dummy = SolanaAccount::default();
        let mut mint_a_dummy = accounts.token_a_mint_account.clone();
        let mut mint_b_dummy = accounts.token_b_mint_account.clone();
        let mut config_dummy = accounts.config_account.clone();
        let mut token_program_a_dummy = SolanaAccount::default();
        let mut token_program_b_dummy = SolanaAccount::default();
        let err = do_process_instruction(
            ix,
            vec![
                &mut accounts.swap_account,
                &mut authority_dummy,
                &mut attacker_vault_account,
                &mut accounts.token_b_account,
                &mut dest_a_account,
                &mut dest_b_account,
                &mut mint_a_dummy,
                &mut mint_b_dummy,
                &mut config_dummy,
                &mut token_program_a_dummy,
                &mut token_program_b_dummy,
            ],
        )
        .unwrap_err();
        assert_eq!(err, SwapError::IncorrectSwapAccount.into());
    }

    /// The design's headline: retroactivity by live read — collect ALWAYS
    /// pays whoever `config.treasury` names NOW, never a cached value.
    #[test]
    fn test_collect_respects_retarget() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        accrue_both_directions(&mut accounts, &user_key);

        let (old_dest_a_key, mut old_dest_a_account, old_dest_b_key, mut old_dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);

        let new_treasury_key = Pubkey::new_unique();
        let ix = set_treasury(
            &SWAP_PROGRAM_ID,
            &accounts.config_key,
            &accounts.admin_key,
            SetTreasury { treasury: new_treasury_key },
        )
        .unwrap();
        let mut admin_dummy = SolanaAccount::default();
        do_process_instruction(ix, vec![&mut accounts.config_account, &mut admin_dummy]).unwrap();

        // Old (T1-owned) destinations are refused now.
        let err = run_collect(
            &mut accounts,
            &old_dest_a_key,
            &mut old_dest_a_account,
            &old_dest_b_key,
            &mut old_dest_b_account,
        )
        .unwrap_err();
        assert_eq!(err, SwapError::InvalidTreasuryDestination.into());

        // New (T2-owned) destinations succeed.
        let (new_dest_a_key, mut new_dest_a_account) = mint_token(
            &spl_token::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &new_treasury_key,
            0,
        );
        let (new_dest_b_key, mut new_dest_b_account) = mint_token(
            &spl_token::id(),
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            &user_key,
            &new_treasury_key,
            0,
        );
        run_collect(
            &mut accounts,
            &new_dest_a_key,
            &mut new_dest_a_account,
            &new_dest_b_key,
            &mut new_dest_b_account,
        )
        .unwrap();
    }

    fn rb_fixture_token2022_fee(token_a_amount: u64, token_b_amount: u64) -> (SwapAccountInfo, Pubkey) {
        let user_key = Pubkey::new_unique();
        let fees = Fees {
            trade_fee_numerator: 1,
            trade_fee_denominator: 10,
            owner_trade_fee_numerator: 1,
            owner_trade_fee_denominator: 10,
            owner_withdraw_fee_numerator: 0,
            owner_withdraw_fee_denominator: 0,
            host_fee_numerator: 0,
            host_fee_denominator: 0,
        };
        let swap_curve = SwapCurve {
            curve_type: CurveType::ConstantProduct,
            calculator: Arc::new(ConstantProductCurve {}),
        };
        let transfer_fees = SwapTransferFees {
            pool_token: TransferFee::default(),
            token_a: TransferFee {
                epoch: 0.into(),
                transfer_fee_basis_points: 100.into(),
                maximum_fee: 1_000_000_000.into(),
            },
            token_b: TransferFee::default(),
        };
        let mut accounts = SwapAccountInfo::new(
            &user_key,
            fees,
            transfer_fees,
            swap_curve,
            token_a_amount,
            token_b_amount,
            &spl_token_2022::id(),
            &spl_token_2022::id(),
            &spl_token_2022::id(),
        );
        accounts.initialize_swap().unwrap();
        (accounts, user_key)
    }

    #[test]
    fn test_collect_token2022_fee_mint() {
        let (mut accounts, user_key) = rb_fixture_token2022_fee(10_000_000, 20_000_000);
        let swapper_key = Pubkey::new_unique();
        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;
        let (user_a_key, mut user_a_account) = mint_token(
            &spl_token_2022::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &swapper_key,
            100_000,
        );
        let (user_b_key, mut user_b_account) = mint_token(
            &spl_token_2022::id(),
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            &user_key,
            &swapper_key,
            0,
        );
        accounts
            .swap(
                &swapper_key,
                &user_a_key,
                &mut user_a_account,
                &swap_token_a_key,
                &swap_token_b_key,
                &user_b_key,
                &mut user_b_account,
                100_000,
                0,
            )
            .unwrap();

        let swap_state = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        let counter_a = swap_state.protocol_fees_a();
        assert!(counter_a > 0);

        let vault_a_before =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;

        let treasury_key = accounts.treasury_key;
        let (dest_a_key, mut dest_a_account) = mint_token(
            &spl_token_2022::id(),
            &accounts.token_a_mint_key,
            &mut accounts.token_a_mint_account,
            &user_key,
            &treasury_key,
            0,
        );
        let (dest_b_key, mut dest_b_account) = mint_token(
            &spl_token_2022::id(),
            &accounts.token_b_mint_key,
            &mut accounts.token_b_mint_account,
            &user_key,
            &treasury_key,
            0,
        );
        let dest_a_before =
            StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;

        run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap();

        let vault_a_after =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        let dest_a_after =
            StateWithExtensions::<Account>::unpack(&dest_a_account.data).unwrap().base.amount;

        // Vault debit is EXACTLY the counter — a transfer fee never touches it.
        assert_eq!(vault_a_after, vault_a_before - counter_a);

        // Treasury's CREDIT is shaved by the epoch fee.
        let mint_a_data = accounts.token_a_mint_account.data.clone();
        let mint_a = StateWithExtensions::<Mint>::unpack(&mint_a_data).unwrap();
        let fee_config = mint_a.get_extension::<TransferFeeConfig>().unwrap();
        let epoch_fee = fee_config.calculate_epoch_fee(0, counter_a).unwrap();
        assert!(epoch_fee > 0, "fixture must actually exercise a nonzero fee");
        assert_eq!(dest_a_after, dest_a_before + counter_a - epoch_fee);

        let swap_state_after = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        assert_eq!(swap_state_after.protocol_fees_a(), 0);
    }

    fn assert_vault_equals_lp_owned_plus_counter(accounts: &SwapAccountInfo) {
        let swap_state = SwapVersion::unpack(&accounts.swap_account.data).unwrap();
        let vault_a =
            StateWithExtensions::<Account>::unpack(&accounts.token_a_account.data).unwrap().base.amount;
        let vault_b =
            StateWithExtensions::<Account>::unpack(&accounts.token_b_account.data).unwrap().base.amount;
        let counter_a = swap_state.protocol_fees_a();
        let counter_b = swap_state.protocol_fees_b();
        // `checked_sub` panics (via unwrap) if the invariant `counter <=
        // vault` is ever violated — that panic IS the assertion.
        let lp_owned_a = vault_a.checked_sub(counter_a).unwrap();
        let lp_owned_b = vault_b.checked_sub(counter_b).unwrap();
        assert_eq!(vault_a, lp_owned_a + counter_a);
        assert_eq!(vault_b, lp_owned_b + counter_b);
    }

    #[test]
    fn test_collect_then_swap_then_collect() {
        let (mut accounts, user_key) = rb_fixture(10_000_000, 20_000_000);
        let swapper_key = Pubkey::new_unique();
        let swap_token_a_key = accounts.token_a_key;
        let swap_token_b_key = accounts.token_b_key;

        let do_swap_a_to_b = |accounts: &mut SwapAccountInfo, amount: u64| {
            let (ua, mut ua_acc) = mint_token(
                &spl_token::id(),
                &accounts.token_a_mint_key,
                &mut accounts.token_a_mint_account,
                &user_key,
                &swapper_key,
                amount,
            );
            let (ub, mut ub_acc) = mint_token(
                &spl_token::id(),
                &accounts.token_b_mint_key,
                &mut accounts.token_b_mint_account,
                &user_key,
                &swapper_key,
                0,
            );
            accounts
                .swap(&swapper_key, &ua, &mut ua_acc, &swap_token_a_key, &swap_token_b_key, &ub, &mut ub_acc, amount, 0)
                .unwrap();
        };
        let do_swap_b_to_a = |accounts: &mut SwapAccountInfo, amount: u64| {
            let (ub, mut ub_acc) = mint_token(
                &spl_token::id(),
                &accounts.token_b_mint_key,
                &mut accounts.token_b_mint_account,
                &user_key,
                &swapper_key,
                amount,
            );
            let (ua, mut ua_acc) = mint_token(
                &spl_token::id(),
                &accounts.token_a_mint_key,
                &mut accounts.token_a_mint_account,
                &user_key,
                &swapper_key,
                0,
            );
            accounts
                .swap(&swapper_key, &ub, &mut ub_acc, &swap_token_b_key, &swap_token_a_key, &ua, &mut ua_acc, amount, 0)
                .unwrap();
        };

        do_swap_a_to_b(&mut accounts, 100_000);
        assert_vault_equals_lp_owned_plus_counter(&accounts);

        do_swap_b_to_a(&mut accounts, 150_000);
        assert_vault_equals_lp_owned_plus_counter(&accounts);

        let (dest_a_key, mut dest_a_account, dest_b_key, mut dest_b_account) =
            treasury_dest_accounts(&mut accounts, &user_key);
        run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap();
        assert_vault_equals_lp_owned_plus_counter(&accounts);

        do_swap_a_to_b(&mut accounts, 80_000);
        assert_vault_equals_lp_owned_plus_counter(&accounts);

        run_collect(&mut accounts, &dest_a_key, &mut dest_a_account, &dest_b_key, &mut dest_b_account)
            .unwrap();
        assert_vault_equals_lp_owned_plus_counter(&accounts);
    }
}
