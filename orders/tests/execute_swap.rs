//! Native processor integration: orders -> current DEX -> actual SPL Token.
//! Host syscall dispatch checks CPI signer seeds and writable privileges, but
//! does not replace a validator's transaction rollback or SBF execution.
#![allow(deprecated)]

use {
    rome_dex::{
        curve::{
            base::{CurveType, SwapCurve},
            constant_product::ConstantProductCurve,
            fees::Fees,
        },
        state::{SwapV2, SwapVersion},
    },
    rome_dex_orders::{
        processor::Processor,
        state::{Order, ORDER_LEN, STATUS_FILLED, STATUS_OPEN},
        DEX_PROGRAM_ID,
    },
    solana_program::{
        account_info::AccountInfo,
        clock::Clock,
        entrypoint::ProgramResult,
        instruction::Instruction,
        program_error::ProgramError,
        program_option::COption,
        program_pack::Pack,
        program_stubs::{set_syscall_stubs, SyscallStubs},
        pubkey::Pubkey,
    },
    std::{
        cell::{Cell, RefCell},
        sync::{Arc, Once},
    },
};

thread_local! {
    static CALLER: Cell<Pubkey> = const { Cell::new(rome_dex_orders::id()) };
    static NOW: Cell<i64> = const { Cell::new(100) };
    static SWAPS: RefCell<Vec<Instruction>> = const { RefCell::new(Vec::new()) };
}

struct NativeCpi;
impl SyscallStubs for NativeCpi {
    fn sol_get_clock_sysvar(&self, address: *mut u8) -> u64 {
        let clock = Clock {
            unix_timestamp: NOW.with(Cell::get),
            ..Clock::default()
        };
        unsafe {
            std::ptr::write(address.cast::<Clock>(), clock);
        }
        0
    }

    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> ProgramResult {
        let caller = CALLER.with(Cell::get);
        let signers = seeds
            .iter()
            .map(|s| Pubkey::create_program_address(s, &caller))
            .collect::<Result<Vec<_>, _>>()?;
        let mut inner = Vec::new();
        for meta in &ix.accounts {
            let mut info = infos
                .iter()
                .find(|a| a.key == &meta.pubkey)
                .ok_or(ProgramError::NotEnoughAccountKeys)?
                .clone();
            if meta.is_writable && !info.is_writable {
                return Err(ProgramError::InvalidAccountData);
            }
            if meta.is_signer && !info.is_signer && !signers.contains(info.key) {
                return Err(ProgramError::MissingRequiredSignature);
            }
            info.is_writable = meta.is_writable;
            info.is_signer = meta.is_signer;
            inner.push(info);
        }
        CALLER.with(|c| c.set(ix.program_id));
        let result = if ix.program_id == DEX_PROGRAM_ID {
            SWAPS.with(|s| s.borrow_mut().push(ix.clone()));
            let result = rome_dex::processor::Processor::process(&ix.program_id, &inner, &ix.data);
            // A host AccountInfo allows writes through a readonly reference;
            // reject that result as the runtime would instead of masking it.
            if result.is_ok() && !inner[0].is_writable {
                Err(ProgramError::InvalidAccountData)
            } else {
                result
            }
        } else if ix.program_id == spl_token::id() {
            spl_token::processor::Processor::process(&ix.program_id, &inner, &ix.data)
        } else {
            Err(ProgramError::IncorrectProgramId)
        };
        CALLER.with(|c| c.set(caller));
        result
    }
}

fn account(key: Pubkey, owner: Pubkey, data: Vec<u8>, writable: bool) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(key)),
        false,
        writable,
        Box::leak(Box::new(1_000_000)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(owner)),
        false,
        0,
    )
}

fn token(key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) -> AccountInfo<'static> {
    let value = spl_token::state::Account {
        mint,
        owner,
        amount,
        state: spl_token::state::AccountState::Initialized,
        ..spl_token::state::Account::default()
    };
    let mut data = vec![0; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(value, &mut data).unwrap();
    account(key, spl_token::id(), data, true)
}

fn mint(key: Pubkey, authority: Pubkey) -> AccountInfo<'static> {
    let value = spl_token::state::Mint {
        mint_authority: COption::Some(authority),
        supply: 1_000_000_000,
        decimals: 6,
        is_initialized: true,
        ..spl_token::state::Mint::default()
    };
    let mut data = vec![0; spl_token::state::Mint::LEN];
    spl_token::state::Mint::pack(value, &mut data).unwrap();
    account(key, spl_token::id(), data, false)
}

struct Fixture {
    accounts: Vec<AccountInfo<'static>>,
    a_to_b: bool,
    tranche: u64,
}
impl Fixture {
    fn new(a_to_b: bool, evm_owner: bool, dca: bool, min_out: u64) -> Self {
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            set_syscall_stubs(Box::new(NativeCpi));
        });
        NOW.with(|n| n.set(100));
        SWAPS.with(|s| s.borrow_mut().clear());
        CALLER.with(|c| c.set(rome_dex_orders::id()));
        let owner = if evm_owner {
            Pubkey::find_program_address(&[b"evm-owner"], &Pubkey::new_unique()).0
        } else {
            Pubkey::new_unique()
        };
        let nonce = 7u64;
        let (order_key, bump) = Pubkey::find_program_address(
            &[b"order", owner.as_ref(), &nonce.to_le_bytes()],
            &rome_dex_orders::id(),
        );
        let pool = Pubkey::new_unique();
        let (authority, pool_bump) =
            Pubkey::find_program_address(&[pool.as_ref()], &DEX_PROGRAM_ID);
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let va = Pubkey::new_unique();
        let vb = Pubkey::new_unique();
        let lp = Pubkey::new_unique();
        let escrow = Pubkey::new_unique();
        let dst = Pubkey::new_unique();
        let (src_mint, dst_mint) = if a_to_b { (a, b) } else { (b, a) };
        let tranche = 1_000_000;
        let total = if dca { 2 * tranche } else { tranche };
        let state = Order {
            is_initialized: true,
            bump,
            status: STATUS_OPEN,
            owner,
            pool,
            input_escrow: escrow,
            dst_ata: dst,
            nonce,
            a_to_b,
            amount_in_total: total,
            remaining_in: total,
            tranche_in: tranche,
            min_out_per_tranche: min_out,
            interval_secs: if dca { 10 } else { 0 },
            expiry_ts: 1000,
            keeper_fee_bps: 10,
            ..Order::default()
        };
        let mut order_data = vec![0; ORDER_LEN];
        state.pack(&mut order_data);
        let swap = SwapV2 {
            is_initialized: true,
            bump_seed: pool_bump,
            token_program_id: spl_token::id(),
            token_a: va,
            token_b: vb,
            pool_mint: lp,
            token_a_mint: a,
            token_b_mint: b,
            fees: Fees {
                trade_fee_numerator: 25,
                trade_fee_denominator: 10_000,
                owner_trade_fee_numerator: 5,
                owner_trade_fee_denominator: 10_000,
                ..Fees::default()
            },
            swap_curve: SwapCurve {
                curve_type: CurveType::ConstantProduct,
                calculator: Arc::new(ConstantProductCurve {}),
            },
            protocol_fees_a: 0,
            protocol_fees_b: 0,
        };
        let mut pool_data = vec![0; SwapVersion::LATEST_LEN];
        SwapVersion::pack(SwapVersion::SwapV2(swap), &mut pool_data).unwrap();
        let (src_vault, dst_vault) = if a_to_b { (va, vb) } else { (vb, va) };
        let mut accounts = vec![
            account(order_key, rome_dex_orders::id(), order_data, true),
            token(escrow, src_mint, order_key, total),
            token(dst, dst_mint, owner, 0),
            token(Pubkey::new_unique(), src_mint, Pubkey::new_unique(), 0),
            account(DEX_PROGRAM_ID, Pubkey::default(), vec![], false),
            account(pool, DEX_PROGRAM_ID, pool_data, true),
            account(authority, Pubkey::default(), vec![], false),
            token(src_vault, src_mint, authority, 1_000_000_000),
            token(dst_vault, dst_mint, authority, 1_000_000_000),
            mint(lp, authority),
            // Legacy outer Execute slot remains accepted, but is not a DEX mint.
            token(Pubkey::new_unique(), lp, Pubkey::new_unique(), 0),
            mint(src_mint, authority),
            mint(dst_mint, authority),
            account(spl_token::id(), Pubkey::default(), vec![], false),
        ];
        accounts[9].is_writable = true;
        Self {
            accounts,
            a_to_b,
            tranche,
        }
    }
    fn balance(&self, i: usize) -> u64 {
        spl_token::state::Account::unpack(&self.accounts[i].data.borrow())
            .unwrap()
            .amount
    }
    fn execute(&self) -> ProgramResult {
        Processor::process(&rome_dex_orders::id(), &self.accounts, &[1])
    }
    fn assert_fill(&self, fills: u64) {
        let order = Order::unpack(&self.accounts[0].data.borrow()).unwrap();
        assert_eq!(
            order.remaining_in,
            order.amount_in_total - fills * self.tranche
        );
        assert_eq!(self.balance(3), fills * 1000);
        assert!(self.balance(2) > 0);
        assert_eq!(1_000_000_000 - self.balance(8), self.balance(2));
        assert_eq!(
            self.balance(7) - 1_000_000_000 + self.balance(3) + self.balance(1),
            order.amount_in_total
        );
        assert_eq!(self.balance(10), 0);
        let pool = SwapV2::unpack(&self.accounts[5].data.borrow()[1..]).unwrap();
        let (active, other) = if self.a_to_b {
            (pool.protocol_fees_a, pool.protocol_fees_b)
        } else {
            (pool.protocol_fees_b, pool.protocol_fees_a)
        };
        assert_eq!(active, fills * 499);
        assert_eq!(other, 0);
        SWAPS.with(|swaps| {
            for ix in swaps.borrow().iter() {
                assert_eq!(ix.accounts.len(), 13);
                assert!(ix.accounts[0].is_writable);
                assert_eq!(ix.accounts[8].pubkey, *self.accounts[11].key);
                assert_eq!(ix.accounts[9].pubkey, *self.accounts[12].key);
            }
        });
    }
}

#[test]
fn executes_current_dex_for_both_directions_and_owner_lanes() {
    for a_to_b in [true, false] {
        for evm_owner in [false, true] {
            let f = Fixture::new(a_to_b, evm_owner, false, 1);
            f.execute()
                .expect("orders must execute the current DEX swap ABI");
            f.assert_fill(1);
            assert_eq!(
                Order::unpack(&f.accounts[0].data.borrow()).unwrap().status,
                STATUS_FILLED
            );
        }
    }
}

#[test]
fn dca_keeps_interval_and_fills_two_tranches() {
    for a_to_b in [true, false] {
        let f = Fixture::new(a_to_b, false, true, 1);
        f.execute().unwrap();
        f.assert_fill(1);
        assert_eq!(
            Order::unpack(&f.accounts[0].data.borrow()).unwrap().status,
            STATUS_OPEN
        );
        assert_eq!(
            f.execute(),
            Err(rome_dex_orders::error::OrderError::IntervalNotElapsed.into())
        );
        NOW.with(|n| n.set(110));
        f.execute().unwrap();
        f.assert_fill(2);
        assert_eq!(
            Order::unpack(&f.accounts[0].data.borrow()).unwrap().status,
            STATUS_FILLED
        );
    }
}

#[test]
fn current_dex_still_rejects_an_unsatisfiable_output_floor() {
    let f = Fixture::new(true, false, false, u64::MAX);
    assert_eq!(
        f.execute(),
        Err(rome_dex::error::SwapError::ExceededSlippage.into())
    );
}

#[test]
fn execute_requires_a_writable_outer_pool() {
    let mut f = Fixture::new(true, false, false, 1);
    f.accounts[5].is_writable = false;
    assert_eq!(f.execute(), Err(ProgramError::InvalidAccountData));
}
