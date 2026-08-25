//! CU A/B rig: measures the compute-unit cost of `[profile.release]
//! overflow-checks = true` by running the SAME instruction against two builds
//! of the same program (#122).
//!
//! Why this exists: overflow-checks emit a branch per arithmetic op, and the
//! profile applies to the whole dependency graph (spl-math's U256, uint's
//! U512), so the cost cannot be reasoned about from the source — it has to be
//! measured. The gating path is the CLMM swap, because #94's unbounded
//! tick-crossing griefing already presses on the EVM lane's atomic budget
//! (the Solana-lane 600K figure is the app's own client-side
//! `setComputeUnitLimit`, not a router or protocol budget — see
//! `SOLANA_LANE_LIMIT` below).
//!
//! What this is and is not. Mollusk runs the real Agave program-runtime, so
//! `compute_units_consumed` is the runtime's own accounting for the
//! instruction — not an emulator estimate. But it measures ONE instruction in
//! isolation: no per-tx overhead, no account loading, no signature costs, and
//! nothing about how rome-evm splits an EVM-lane transaction into legs. So the
//! ABSOLUTE numbers here are not receipts and must not be quoted as such. The
//! DELTA is a same-runtime, same-input A/B and is the number that gates.
//!
//! Usage:  cargo run --release -- <base-so-dir> <flagged-so-dir>
//! Each dir must contain rome_dex_clmm.so.

mod pack;

use mollusk_svm::{program, Mollusk};
use rome_dex_clmm::state::{Pool, Tick, POOL_SEED, POSITION_SEED, TICK_ARRAY_SEED, TICK_ARRAY_HEADER_LEN, TICK_ARRAY_SIZE, TICK_LEN};
use sha2::{Digest, Sha256};
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
};
use std::collections::HashMap;

const ATA_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const FEE_PIPS: u32 = 3000;
const TICK_SPACING: u16 = 64;
const Q64: u128 = 1u128 << 64;
const LAMPORTS: u64 = 10_000_000_000;
/// rome-evm's atomic transaction budget, observed on Hadrian (1,399,550).
const EVM_LANE_BUDGET: u64 = 1_400_000;
/// Measured CLMM EVM-lane CPI swap max-leg on Hadrian (produced by
/// `harness/clmm.test.mjs` with SWAP_IN = 50_000, a deliberately tiny probe).
/// So this is a NEAR-ZERO-CROSSING baseline: adding a multi-crossing delta to
/// it is conservative for the flag, but the sum is NOT a worst-case max-leg.
/// A 12-crossing EVM-lane swap would itself sit near 289,638 + (408,845 −
/// 230,948) ≈ 467K before any flag — that gap is #94's problem, not this measurement's.
/// Re-measure if the harness pool or probe size changes.
const EVM_LANE_BASELINE: u64 = 289_638;
/// Gate: keep at least half the EVM lane's budget spare.
const EVM_LANE_CEILING: u64 = 700_000;
/// What the app requests on its own SOLANA-lane txs (clmm-actions.ts:76).
/// A client parameter, not a protocol limit — Solana's per-tx max is 1.4M.
const SOLANA_LANE_LIMIT: u64 = 600_000;

struct World {
    accounts: HashMap<Pubkey, Account>,
    program_id: Pubkey,
    pool: Pubkey,
    vault_0: Pubkey,
    vault_1: Pubkey,
    user_0: Pubkey,
    user_1: Pubkey,
    payer: Pubkey,
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: spl_token::state::AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    Account { lamports: LAMPORTS, data, owner: spl_token::id(), executable: false, rent_epoch: 0 }
}

fn mint_account(supply: u64) -> Account {
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint {
        mint_authority: COption::None,
        supply,
        decimals: 6,
        is_initialized: true,
        freeze_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    Account { lamports: LAMPORTS, data, owner: spl_token::id(), executable: false, rent_epoch: 0 }
}

/// Two mints in canonical order (mint_0 < mint_1), found by search so the
/// pool's ordering requirement holds without relying on luck.
fn ordered_mints() -> (Pubkey, Pubkey) {
    loop {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        if a.as_ref() < b.as_ref() {
            return (a, b);
        }
    }
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), spl_token::id().as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

fn sysvar_accounts(m: &Mollusk) -> Vec<(Pubkey, Account)> {
    vec![
        program::keyed_account_for_system_program(),
        mollusk_svm_programs_token::token::keyed_account(),
        (
            solana_sdk::sysvar::rent::id(),
            m.sysvars.keyed_account_for_rent_sysvar().1,
        ),
    ]
}

impl World {
    /// Builds the pool, three tick arrays, and `positions` liquidity ranges by
    /// executing the program's OWN instructions — no hand-written account
    /// state beyond SPL token accounts (packed with spl_token's own codec).
    /// A hand-crafted pool would be a fixture of my assumptions, not the
    /// program's actual output.
    fn setup(m: &Mollusk, program_id: Pubkey, ranges: &[(i32, i32)]) -> World {
        let (mint_0, mint_1) = ordered_mints();
        let payer = Pubkey::new_unique();
        let (pool, bump) = Pubkey::find_program_address(
            &[POOL_SEED, mint_0.as_ref(), mint_1.as_ref(), &FEE_PIPS.to_le_bytes()],
            &program_id,
        );
        let vault_0 = ata(&pool, &mint_0);
        let vault_1 = ata(&pool, &mint_1);
        let user_0 = Pubkey::new_unique();
        let user_1 = Pubkey::new_unique();

        let mut accounts: HashMap<Pubkey, Account> = HashMap::new();
        accounts.insert(mint_0, mint_account(u64::MAX / 4));
        accounts.insert(mint_1, mint_account(u64::MAX / 4));
        accounts.insert(vault_0, token_account(mint_0, pool, 1_000_000_000_000));
        accounts.insert(vault_1, token_account(mint_1, pool, 1_000_000_000_000));
        accounts.insert(user_0, token_account(mint_0, payer, 1_000_000_000_000));
        accounts.insert(user_1, token_account(mint_1, payer, 1_000_000_000_000));
        accounts.insert(payer, Account { lamports: LAMPORTS, ..Default::default() });
        accounts.insert(pool, Account { lamports: 0, ..Default::default() });

        let mut w = World { accounts, program_id, pool, vault_0, vault_1, user_0, user_1, payer };

        // 1. pool at tick 0
        w.exec(
            m,
            &pack::init_pool(bump, FEE_PIPS, TICK_SPACING, Q64),
            vec![
                AccountMeta::new(pool, false),
                AccountMeta::new_readonly(mint_0, false),
                AccountMeta::new_readonly(mint_1, false),
                AccountMeta::new(vault_0, false),
                AccountMeta::new(vault_1, false),
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            "init_pool",
        );

        // 2. three tick arrays covering the walk band
        let span = TICK_SPACING as i32 * 88;
        for k in [-2i32, -1, 0] {
            let start = k * span;
            let (ta, ta_bump) = Pubkey::find_program_address(
                &[TICK_ARRAY_SEED, pool.as_ref(), &start.to_le_bytes()],
                &program_id,
            );
            w.accounts.insert(ta, Account { lamports: 0, ..Default::default() });
            w.exec(
                m,
                &pack::init_tick_array(start, ta_bump),
                vec![
                    AccountMeta::new_readonly(pool, false),
                    AccountMeta::new(ta, false),
                    AccountMeta::new(payer, true),
                    AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
                ],
                "init_tick_array",
            );
        }

        // 3. one position per range, each initializing its two boundary ticks
        for (lo, hi) in ranges {
            let (pos, pos_bump) = Pubkey::find_program_address(
                &[
                    POSITION_SEED,
                    pool.as_ref(),
                    payer.as_ref(),
                    &lo.to_le_bytes(),
                    &hi.to_le_bytes(),
                ],
                &program_id,
            );
            w.accounts.insert(pos, Account { lamports: 0, ..Default::default() });
            w.exec(
                m,
                &pack::open_position(*lo, *hi, pos_bump),
                vec![
                    AccountMeta::new_readonly(pool, false),
                    AccountMeta::new(pos, false),
                    AccountMeta::new_readonly(payer, false),
                    AccountMeta::new(payer, true),
                    AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
                ],
                "open_position",
            );
            let ta_lo = w.tick_array_for(*lo);
            let ta_hi = w.tick_array_for(*hi);
            w.exec(
                m,
                &pack::increase_liquidity(50_000_000, u64::MAX, u64::MAX),
                vec![
                    AccountMeta::new(pool, false),
                    AccountMeta::new(pos, false),
                    AccountMeta::new(payer, true),
                    AccountMeta::new(user_0, false),
                    AccountMeta::new(user_1, false),
                    AccountMeta::new(vault_0, false),
                    AccountMeta::new(vault_1, false),
                    AccountMeta::new_readonly(spl_token::id(), false),
                    AccountMeta::new(ta_lo, false),
                    AccountMeta::new(ta_hi, false),
                ],
                "increase_liquidity",
            );
        }
        w
    }

    fn tick_array_for(&self, tick: i32) -> Pubkey {
        let span = TICK_SPACING as i32 * 88;
        let start = (tick as f64 / span as f64).floor() as i32 * span;
        Pubkey::find_program_address(
            &[TICK_ARRAY_SEED, self.pool.as_ref(), &start.to_le_bytes()],
            &self.program_id,
        )
        .0
    }

    fn metas_to_accounts(&self, metas: &[AccountMeta], m: &Mollusk) -> Vec<(Pubkey, Account)> {
        let mut out: Vec<(Pubkey, Account)> = metas
            .iter()
            .map(|k| (k.pubkey, self.accounts.get(&k.pubkey).cloned().unwrap_or_default()))
            .collect();
        for (k, a) in sysvar_accounts(m) {
            if metas.iter().any(|x| x.pubkey == k) && !out.iter().any(|(p, _)| *p == k) {
                out.push((k, a));
            }
        }
        // system / token program accounts must carry their executable stubs
        for (k, a) in sysvar_accounts(m) {
            if let Some(slot) = out.iter_mut().find(|(p, _)| *p == k) {
                slot.1 = a;
            }
        }
        out
    }

    fn exec(&mut self, m: &Mollusk, data: &[u8], metas: Vec<AccountMeta>, label: &str) -> u64 {
        let ix = Instruction::new_with_bytes(self.program_id, data, metas.clone());
        let accounts = self.metas_to_accounts(&metas, m);
        let res = m.process_instruction(&ix, &accounts);
        if !matches!(res.program_result, mollusk_svm::result::ProgramResult::Success) {
            panic!("{label} failed: {:?}", res.program_result);
        }
        for (k, a) in res.resulting_accounts {
            self.accounts.insert(k, a);
        }
        res.compute_units_consumed
    }

    fn pool_state(&self) -> Pool {
        Pool::unpack(&self.accounts[&self.pool].data).expect("pool unpack")
    }

    /// Counts ticks the engine ACTUALLY had to cross, by reading the tick
    /// arrays the program itself wrote and testing each slot's
    /// `liquidity_gross`. An earlier version filtered a hand-maintained list
    /// of expected ticks instead; that could report a healthy crossing count
    /// for a scenario whose ranges had drifted to initialize nothing, which
    /// is exactly the failure the count exists to catch.
    /// The interval is `(after, before]` — exclusive at the bottom, INCLUSIVE
    /// at the top. Settled analytically, not by inspection:
    ///
    /// - `next_target` for a down-swap takes `cand = tick.div_euclid(sp) * sp`,
    ///   the greatest aligned candidate <= the current tick
    ///   (`clmm/src/engine.rs:246`), so a tick sitting exactly at the opening
    ///   price IS selected as the first target, not skipped.
    /// - When that target's price equals the current price, `amount_in_to_target`
    ///   is 0, so `reached_target` is trivially true and `sqrt_price_next` is
    ///   set to it (`clmm/src/curve/swap_math.rs:85-98`) — the swap step
    ///   still "reaches" it even though no work was done.
    /// - Back in the loop, `sqrt_price == target_sqrt` fires, `cross()` runs,
    ///   and `tick = next_tick - 1` (`clmm/src/engine.rs:178`) — which is also
    ///   why the LOWER end is exclusive: the engine always rests strictly
    ///   below the last tick it crossed, so a crossed tick can never equal
    ///   `after` (the final tick).
    ///
    /// Two residual gaps, both currently fail-safe:
    /// - An up-swap (`zero_for_one = false`) always counts 0 here, because
    ///   the interval is empty when `after > before` — for the gate row this
    ///   trips the `>= 8` INVALID check, so it fails closed. All scenarios
    ///   below are down-swaps.
    /// - At the band edge, `current_tick.clamp(MIN_TICK, MAX_TICK)`
    ///   (`clmm/src/engine.rs:192`) could make a crossed tick equal the
    ///   clamped final tick and be excluded here. Theoretical only — no
    ///   scenario below runs near `MIN_TICK`.
    fn initialized_ticks_between(&self, lo_exclusive: i32, hi_inclusive: i32) -> usize {
        let span = TICK_SPACING as i32 * TICK_ARRAY_SIZE as i32;
        let mut n = 0;
        for k in [-2i32, -1, 0] {
            let start = k * span;
            let ta = Pubkey::find_program_address(
                &[TICK_ARRAY_SEED, self.pool.as_ref(), &start.to_le_bytes()],
                &self.program_id,
            )
            .0;
            let Some(acc) = self.accounts.get(&ta) else { continue };
            if acc.data.len() < TICK_ARRAY_HEADER_LEN + TICK_ARRAY_SIZE * TICK_LEN {
                continue;
            }
            for slot in 0..TICK_ARRAY_SIZE {
                let off = TICK_ARRAY_HEADER_LEN + slot * TICK_LEN;
                let tick = Tick::unpack(&acc.data[off..off + TICK_LEN]);
                if !tick.is_initialized() {
                    continue;
                }
                let idx = start + slot as i32 * TICK_SPACING as i32;
                if idx > lo_exclusive && idx <= hi_inclusive {
                    n += 1;
                }
            }
        }
        n
    }
}

struct Measured {
    cu: u64,
    tick_before: i32,
    tick_after: i32,
    crossings: usize,
}

fn run(so_dir: &str, ranges: &[(i32, i32)], amount_in: u64) -> Measured {
    std::env::set_var("SBF_OUT_DIR", so_dir);
    let program_id = Pubkey::new_unique();
    let mut m = Mollusk::new(&program_id, "rome_dex_clmm");
    mollusk_svm_programs_token::token::add_program(&mut m);

    let mut w = World::setup(&m, program_id, ranges);
    let before = w.pool_state();

    // walk order: array containing the current tick, then downward
    let a0 = w.tick_array_for(before.current_tick);
    let span = TICK_SPACING as i32 * 88;
    let a1 = w.tick_array_for(before.current_tick - span);
    let a2 = w.tick_array_for(before.current_tick - 2 * span);

    let cu = w.exec(
        &m,
        &pack::swap(true, amount_in, 1, 0),
        vec![
            AccountMeta::new(w.pool, false),
            AccountMeta::new(w.payer, true),
            AccountMeta::new(w.user_0, false),
            AccountMeta::new(w.user_1, false),
            AccountMeta::new(w.vault_0, false),
            AccountMeta::new(w.vault_1, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new(a0, false),
            AccountMeta::new(a1, false),
            AccountMeta::new(a2, false),
        ],
        "swap",
    );

    let after = w.pool_state();
    let crossings = w.initialized_ticks_between(after.current_tick, before.current_tick);
    Measured { cu, tick_before: before.current_tick, tick_after: after.current_tick, crossings }
}

fn artefact_facts(dir: &str) -> (String, u64, usize) {
    let p = format!("{dir}/rome_dex_clmm.so");
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("cannot read {p}: {e}"));
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let needle = b"attempt to add with overflow";
    let hits = bytes.windows(needle.len()).filter(|w| *w == needle).count();
    (hash[..16].to_string(), bytes.len() as u64, hits)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: cu-delta <base-so-dir> <flagged-so-dir>");
        std::process::exit(2);
    }
    let (base_dir, oc_dir) = (args[1].clone(), args[2].clone());

    pack::verify_encoding();
    println!("instruction encoding: round-trips through ClmmInstruction::unpack ✓\n");

    println!("ARTEFACTS");
    let mut bad = false;
    for (label, dir) in [("base", &base_dir), ("flagged", &oc_dir)] {
        let (h, len, hits) = artefact_facts(dir);
        println!("  {label:8} sha256={h}…  {len:>7} bytes  overflow-strings={hits}");
        if label == "base" && hits != 0 {
            eprintln!("  !! base build CONTAINS overflow strings — not a flagless build");
            bad = true;
        }
        if label == "flagged" && hits == 0 {
            eprintln!("  !! flagged build has NO overflow strings — flag did not reach it");
            bad = true;
        }
    }
    // CU_DELTA_SELFTEST exists for exactly one purpose: pointing both sides at
    // the SAME .so must yield a zero delta, proving the measurement responds to
    // the build rather than to run order or the fresh pubkeys each run makes.
    // It is therefore restricted to an identical pair. Without that restriction
    // it would launder a mislabelled REAL pair into an official-looking table
    // with a gate verdict attached.
    let selftest = std::env::var("CU_DELTA_SELFTEST").is_ok();
    if selftest {
        let (hb, _, _) = artefact_facts(&base_dir);
        let (ho, _, _) = artefact_facts(&oc_dir);
        if hb != ho {
            eprintln!(
                "CU_DELTA_SELFTEST requires both paths to be the SAME artefact \
                 (got {hb}… and {ho}…). It is a zero-delta self-check, not a way \
                 to measure a mislabelled pair."
            );
            std::process::exit(1);
        }
        println!("  (CU_DELTA_SELFTEST — identical artefact both sides; expect every Δ to be 0)");
    } else if bad {
        std::process::exit(1);
    }
    println!();

    // Ranges chosen so the sweep scenario has 8 initialized ticks strictly
    // below the opening tick, and the anchor scenario has none.
    // Adjacent stacked ranges: every tick the walk reaches is initialized AND
    // has liquidity on both sides of it, so the price steps down through all
    // eight instead of falling into an empty band and hitting the
    // past-window guard (InvalidTickArraySequence) before the sweep finishes.
    let mut sweep_ranges: Vec<(i32, i32)> = vec![(-64, 640)];
    sweep_ranges.extend((1..24).map(|k: i32| (-(k + 1) * 64, -k * 64)));
    // One wide range, both bounds inside the three arrays the rig builds
    // (5632 would need a fourth array at start=5632 and fails IllegalOwner).
    let anchor_ranges: Vec<(i32, i32)> = vec![(-5632, 5568)];

    println!("{:<22} {:>10} {:>10} {:>10} {:>8} {:>8}", "SCENARIO", "BASE CU", "FLAGGED", "Δ", "Δ%", "CROSS");
    let mut gate_delta: Option<u64> = None;
    let mut fail = false;

    for (name, ranges, amount, is_gate) in [
        ("clmm swap tick-sweep", &sweep_ranges, 2_000_000u64, true),
        ("clmm swap deep-sweep", &sweep_ranges, 4_000_000u64, false),
        ("clmm swap plain", &anchor_ranges, 1_000u64, false),
    ] {
        let b = run(&base_dir, ranges, amount);
        let o = run(&oc_dir, ranges, amount);
        assert_eq!(b.tick_after, o.tick_after, "{name}: builds diverged in behaviour");
        let d = o.cu as i64 - b.cu as i64;
        let pct = d as f64 * 100.0 / b.cu as f64;
        println!(
            "{name:<22} {:>10} {:>10} {:>+10} {:>7.2}% {:>8}",
            b.cu, o.cu, d, pct, b.crossings
        );

        // CU_DELTA_SELFTEST's whole point: an identical artefact on both
        // sides must measure a zero delta on every row. A nonzero Δ here
        // means the measurement is responding to something other than the
        // build (run order, fresh pubkeys, non-determinism) — a human
        // skimming the table for a stray zero is not a gate.
        if selftest && d != 0 {
            eprintln!(
                "\nCU_DELTA_SELFTEST FAIL: {name} measured Δ {d} CU — expected 0 for an \
                 identical artefact on both sides."
            );
            std::process::exit(1);
        }

        if is_gate {
            if b.crossings < 8 {
                eprintln!(
                    "\nINVALID: gate scenario crossed {} initialized ticks (need >= 8). \
                     Tick moved {} -> {}. A swap that crosses nothing measures nothing.",
                    b.crossings, b.tick_before, b.tick_after
                );
                std::process::exit(1);
            }
            if d < 0 {
                println!("  (flagged build measured CHEAPER by {} CU — projecting 0)", -d);
            }
            gate_delta = Some(d.max(0) as u64);
            if pct > 15.0 {
                eprintln!("\nGATE FAIL: Δ {pct:.2}% exceeds the 15% ceiling.");
                fail = true;
            }
        } else if name == "clmm swap plain" && !(50_000..=400_000).contains(&b.cu) {
            eprintln!(
                "\nINVALID: anchor scenario base CU {} outside 50K–400K — the rig is not \
                 exercising a realistic swap, so no number here is trustworthy.",
                b.cu
            );
            std::process::exit(1);
        }
    }

    // Two DIFFERENT ceilings, easily conflated:
    //   Solana lane  600,000 — the app's own setComputeUnitLimit request
    //                (app/lib/clmm-actions.ts:76), not a protocol limit;
    //                Solana's per-tx max is 1,400,000, so it is raisable.
    //   EVM lane   ~1,400,000 — rome-evm's atomic tx budget, which the router
    //                CPI executes inside. The router sets no CU limit itself.
    // The EVM lane shares one budget between rome-evm and the CPI, and
    // rome-evm's own build is unchanged, so the measured delta lands 1:1.
    // Skipped entirely under CU_DELTA_SELFTEST: an identical artefact has
    // nothing to project, and this printout is an official-looking verdict
    // that must never come out of a run that measured nothing.
    if !selftest {
        if let Some(d) = gate_delta {
            let projected = EVM_LANE_BASELINE + d;
            let pct = projected as f64 * 100.0 / EVM_LANE_BUDGET as f64;
            println!(
                "\nEVM lane:    projected max-leg {EVM_LANE_BASELINE} + {d} = {projected} CU              of ~{EVM_LANE_BUDGET} ({pct:.1}% used)"
            );
            if projected > EVM_LANE_CEILING {
                eprintln!("GATE FAIL: projected {projected} exceeds the {EVM_LANE_CEILING} ceiling.");
                fail = true;
            } else {
                println!(
                    "gate: PASS (<= {EVM_LANE_CEILING}). Margin shown is for the PROBE leg this \
                     baseline came from, not for a worst-case swap — see #94."
                );
            }
            println!(
                "Solana lane: the app requests {SOLANA_LANE_LIMIT} CU per tx; a swap costing more than \
                 that fails client-side, before Solana's real per-tx max (see #94)."
            );
        }
    }

    if fail {
        std::process::exit(1);
    }
}
