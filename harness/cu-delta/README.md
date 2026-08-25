# cu-delta — CU cost of `overflow-checks` (#122)

Measures what `[profile.release] overflow-checks = true` costs in compute
units, by running the **same instruction** against two builds of the same
program under the real Agave runtime.

```sh
# build the pair (flagless vs flagged), then:
cargo run --release -- <base-so-dir> <flagged-so-dir>
```

Each dir must contain `rome_dex_clmm.so`. The rig refuses to measure a pair
that is not what it claims: the base build must contain **zero** overflow
panic strings and the flagged build exactly one, so a mislabelled pair fails
before any number is produced.

## What it measures, and what it does not

Mollusk executes the real program-runtime, so `compute_units_consumed` is the
runtime's own accounting — not an emulator estimate. But it measures **one
instruction in isolation**: no per-transaction overhead, no account loading,
no signature costs, and nothing about how rome-evm splits an EVM-lane
transaction into legs.

So the **absolute** numbers are not receipts and must not be quoted as such.
The **delta** is a same-runtime, same-input A/B and is the number that gates.
Iterative-lane leg re-splitting is structurally invisible here; that is why
#122 keeps an on-chain devnet receipt check as a separate pre-deploy gate.

## The two ceilings, which are easy to conflate

| lane | ceiling | what it actually is |
|---|---:|---|
| Solana | 600,000 | the **app's own** `setComputeUnitLimit` request (`app/lib/clmm-actions.ts:76`). A client parameter, not a protocol limit — Solana's per-tx max is 1,400,000, so it can be raised. |
| EVM (router CPI) | ~1,400,000 | rome-evm's atomic transaction budget, observed at 1,399,550. The router sets no CU limit of its own. |

The gate is the EVM-lane projection, because rome-evm's build is unchanged and
shares that budget with the CPI, so the measured delta lands on it 1:1. A row
whose base CU exceeds 600,000 would fail **client-side** on the Solana lane
before reaching any protocol limit — that is #94, not this change.

## What "crossings" means

One iteration of the swap loop where the price moves past an **initialized**
tick and the engine updates it. Not transaction legs — every crossing here
happens inside a single `Swap` instruction. Cost is near-linear at ~16.2K CU
per crossing, which is why the count is asserted rather than assumed.

## Why the scenarios are shaped this way

The delta scales with arithmetic ops actually executed, so a swap that crosses
no ticks measures almost nothing and would pass while hiding a regression on
the path that matters. The gate scenario therefore **asserts** it crossed at
least 8 initialized ticks and exits non-zero if it did not.

State is built by executing the program's own instructions — InitPool,
InitTickArray, OpenPosition, IncreaseLiquidity — rather than hand-writing
account bytes, which would be a fixture of assumptions instead of the
program's real output. Instruction encodings are round-tripped through the
program's own `ClmmInstruction::unpack` before any run.

## Mutation guards

The rig is only worth trusting if it can fail. All five verified:

| mutation | expected | observed |
|---|---|---|
| same `.so` on both sides (`CU_DELTA_SELFTEST=1`) | every Δ is 0 | `+0 / +0 / +0` |
| swap the two dirs | refused (mislabelled pair) | exit 1 |
| shrink the gate swap so it crosses nothing | non-zero exit | exit 1, `crossed 0 initialized ticks` |
| point the gate scenario at ranges that initialize nothing | non-zero exit | exit 1, `crossed 0` |
| byte-seed an initialized tick at the opening price (walk-neutral: same liquidity distribution, same price path, same artefacts — only `is_initialized(0)` flips) | every row's base CU rises by the cost of one crossing, CROSS rises by 1 | `408,845→413,177 / 624,307→628,639 / 230,948→235,280` (+4,332 CU uniformly), `CROSS 12/23/0 → 13/24/1` |

`CU_DELTA_SELFTEST` only accepts two paths to the **same** artefact (sha256
compared). Its single purpose is the zero-delta check; it is not a way to
measure a pair whose labels do not match its contents.

The opening-price seed is also the discriminating experiment behind the
crossing counter's `(after, before]` interval (inclusive at the top): a tick
sitting exactly at the opening price IS crossed by the engine, but it's a
**zero-width** crossing (no step iteration — the price is already there), so
it costs ~4.3K CU rather than the ~16.2K of a full-stride crossing.

The crossing count is read from the **tick arrays the program wrote**, not
from a list of ticks the rig expects to be initialized. An earlier version did
the latter, and a reviewer showed it would report a healthy count for a
scenario whose ranges had drifted to initialize nothing — reporting `CROSS=12`
and passing while the engine crossed zero.
