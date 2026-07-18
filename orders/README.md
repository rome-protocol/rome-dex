# rome-dex `orders` — limit orders + DCA (dual-lane, permissionless keeper)

A lean native Solana program (not a fork) that parks a swap intent into a
per-order escrow, executed later by a **permissionless keeper**. Same
authority-agnostic seam as the DEX core and `farm/`: the order `owner` is one
signer, so it works identically for a Solana wallet and an EVM user's Rome
`external_auth` PDA. Program id `ordWTztCBW7fpoq6eLHQBp2aeoB17CAbmAx6FjtfQ7C`.

## Model
- **Limit**: `tranche_in == amount_in_total`, `interval_secs == 0` (one shot).
- **DCA**: `tranche_in < amount_in_total`, `interval_secs > 0` (a tranche per interval).
- Owner states `min_out_per_tranche` = the **net** floor they must receive. The
  DEX swap minimum is **grossed up** (`grossup_swap_min`) so that after the
  keeper fee (≤ 0.50%, `MAX_KEEPER_FEE_BPS`) the owner still nets ≥ their limit.
- The keeper cannot fill worse than the limit: `Execute` CPIs the DEX swap with
  the grossed-up minimum as the swap's own slippage floor → an underpriced /
  premature fill reverts on-chain.

## Instructions
| tag | ix | signer | notes |
|---|---|---|---|
| 0 | `Place` | owner + payer | funds owner→input escrow; creates order PDA; validates escrows |
| 1 | `Execute` | none (permissionless) | CPI DEX swap; split gross → keeper fee + owner net |
| 2 | `Cancel` | owner | refund input escrow to owner, mark Cancelled |
| 3 | `CrankExpired` | none (permissionless) | refund to owner after expiry, mark Expired |

Order PDA: `[b"order", owner, nonce]`. Escrows are ATAs owned by that PDA (input
holds un-executed funds; output receives gross swap proceeds, then is split).

## Security invariants (audit lessons baked in)
1. **Pinned CPI target** — the swap program id must equal the hardcoded DEX id
   (`check_dex_program`); the token program must equal SPL (`check_token_program`).
   This is the arbitrary-CPI class that hit `farm/` (a no-op substitute program).
2. **Match, don't trust** — every account `Execute`/`Cancel`/`CrankExpired`
   touches (escrow, output escrow, dst, pool) is matched against immutable
   `Order` state, never taken from the (untrusted) keeper.
3. **Effects-first** — `remaining_in` is debited and the order re-packed before
   the swap CPI, so a re-entrant/double execute sees the reduced remainder.
4. **Fee bounded + owner-favouring** — `keeper_fee_bps ≤ 50`, fee rounds down,
   swap min grossed up (ceil) → net ≥ limit for all inputs (proptest).
5. **No stranded funds** — `Cancel` works in any open state; `CrankExpired`
   refunds permissionlessly, and only ever to the owner's own account.

## Build / test
```
cd orders && cargo test --lib   # 19 unit + adversarial tests
cargo build-sbf                 # → target/deploy/rome_dex_orders.so
```
Program keypair: `orders-keypair.json` (gitignored; used by PR ② deploy).

## Roadmap
- **PR ① (this)** — program + pure-logic + adversarial unit suite.
- **PR ②** — deploy to Hadrian + `harness/orders.test.mjs`: on-chain dual-lane
  place/execute/cancel, premature-execute reverts, account-substitution reverts,
  DCA gate, expiry crank; measure Execute CU (orders→DEX invoke_signed depth).
- **PR ③** — permissionless `harness/keeper.mjs` (poll → quote → execute).
- **PR ④** — UI: Market/Limit/DCA tabs + open-orders table on Positions.
