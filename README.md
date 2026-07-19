# rome-dex

> **Built on [Rome Protocol](https://docs.rome.builders)** — EVM chains that run natively inside the Solana runtime, where Solidity apps call Solana programs atomically (CPI) and Solana users drive EVM apps: two VMs, one chain, one block.

A **dual-lane, unified-liquidity AMM**: one liquidity pool, traded and LP'd by **both Solana wallets (Phantom) and EVM wallets (MetaMask)** at full functional + near-CU parity — no bridge, no wrapped-asset fragmentation, one set of reserves. It is the first Rome-native protocol built on the **Rome Parity Pattern**.

This is a **product**, not a demo: self-sustaining on both lanes (LP fees accrue to both-lane LPs identically; the EVM lane's cross-VM cost is user-borne gas, never a Rome subsidy).

**Live:** [`dex.devnet.romeprotocol.xyz`](https://dex.devnet.romeprotocol.xyz) — serving **Hadrian** (`200010`) and **Martius** (`121214`), switchable in the header.

---

## What it does

| Product | What | Route |
|---|---|---|
| **Swap** | Constant-product (x·y=k) swaps, exact-in and exact-out, multi-hop routing across pools | `/` |
| **Pools** | Browse pools, provide/withdraw liquidity, **create a pool** (simple or concentrated), trade any pool inline, **find a pool** by token pair | `/pools` |
| **CLMM** | Concentrated liquidity — pick a price range, full position lifecycle (open / increase / decrease / collect / close) | `/clmm` |
| **Farms** | Stake an LP token, earn emissions (MasterChef-style) | `/farms` |
| **Positions / Orders** | Your open positions; limit + DCA orders (keeper-filled) | `/positions` |

Every one of these works from **both** a MetaMask (EVM) wallet and a Phantom (Solana) wallet, against the same on-chain pool.

---

## Architecture

### Dual lanes, one pool

The AMM core is a **native Solana program** (a fork of Solana Labs' [`spl-token-swap`](https://github.com/solana-labs/solana-program-library/tree/master/token-swap), Apache-2.0 — we keep the audited x·y=k math and add the parity layer on top). It is reached two ways:

```
  Phantom (Solana wallet) ───────────────► native dex program ◄─────────── MetaMask (EVM wallet)
      signs the Solana tx directly            (one pool, one         Rome CPI precompile 0xFF..08:
                                               set of reserves)       the EVM tx calls the program,
                                                                      Rome auto-signs the user's PDA
```

The one enabling trick is **authority-agnostic instructions**: every instruction takes an `authority` signer and operates on that authority's token accounts — it doesn't care whether the authority is a Solana wallet pubkey or an EVM user's Rome `external_auth` PDA. On the EVM lane, MetaMask sends a normal transaction; Rome's CPI precompile (`0xFF..08`) invokes the Solana program and auto-signs the caller's PDA. Same pool, same reserves, same fee accrual — both lanes.

Because the LP token is a normal SPL mint, it is automatically an ERC-20 on Rome, so an LP position minted on one lane is spendable on the other.

For how EVM execution and CPI work on Solana, see the [Rome Protocol Documentation](https://docs.rome.builders).

### Deployment shape — what's shared vs per-chain

This is the key mental model (and the source of one gotcha, below). rome-dex has three deploy surfaces with **different cardinalities**:

```
              ┌──────────────── ONE per Solana cluster (shared) ────────────────┐
Solana        │  4 native programs:  dex · clmm · farm · orders                  │
cluster       │  + all pool / position / farm STATE (created once per cluster)   │
(devnet)      └─────────────────────────────────────────────────────────────────┘
                                     ▲ shared by every Rome chain on the cluster
                        ┌────────────┴────────────┐            MANY per cluster
                  Rome chain: Hadrian       Rome chain: Martius     (one set per chain)
                  rome-evm RPTWwELX…        rome-evm RomeTaTN…
                  2 EVM routers             2 EVM routers
                  + ERC-20 wrappers         + ERC-20 wrappers
                  + your gas / PDA          + your gas / PDA
                                     │
                        ┌────────────┴────────────┐            ONE (or more) per env
                        │  Frontend (Next.js)      │  points at a chain (EVM) + cluster
                        │  dex.devnet…xyz          │  (Solana), switchable at runtime
                        └──────────────────────────┘
```

- **Native programs + pools are cluster-level.** Deploy once per Solana cluster; **every Rome chain on that cluster shares the same programs and the same pools** (pool addresses are Solana pubkeys). Hadrian and Martius run on the same Solana devnet cluster, so **they share one liquidity layer** — a swap on Hadrian and a swap on Martius hit the same reserves.
- **The EVM half is per Rome chain.** Each Rome chain is its own EVM address space with its **own** rome-evm program, so it gets its own `RomeDexRouter` + `RomeClmmRouter` (leg-count optimizers for the built-in tier swaps), its own ERC-20 token wrappers, and your gas balance + `external_auth` PDA are per-chain.
- **The frontend is chain-config-driven.** One image reads a mounted `chains.yaml` (env `CHAINS_CONFIG_FILE`); the header chain switcher and every server route resolve the active chain per request (`?chain=<chainId>`). Adding a chain is a config edit, not a rebuild.

> **Pools are shared per Solana cluster.** A pool's address is a deterministic PDA of `(tokenA, tokenB, feeBps)`, so a given pair + fee is one pool across every Rome chain on the cluster. An existing pair is already tradeable from any chain — reach it via the main swap card or **"Find a pool"** on `/pools`; re-creating it is a no-op. Only a *genuinely new* token pair creates a new pool. (See "Creating a pool" below.)

### Routers vs direct-CPI

The two EVM routers (`RomeDexRouter`, `RomeClmmRouter`) fold a built-in-tier swap into fewer atomic Solana legs. They are an optimization, **not** a requirement: pools you create trade **direct-CPI** (no router), and CLMM liquidity ops are always direct-CPI (a position PDA's owner must sign, and a contract only auto-signs its *own* PDA). A new chain lights up the Solana lane on day zero (shared pools); deploying its routers lights up the router-folded EVM tier swaps.

### Repository layout

```
program/   Solana AMM core (forked spl-token-swap → authority-agnostic + exact-out + CreatePool)
clmm/      purpose-built concentrated-liquidity program (positions are PDAs, not NFTs)
farm/      MasterChef-style liquidity-mining program
orders/    limit + DCA orders (keeper-filled)
contracts/ EVM routers (RomeDexRouter, RomeClmmRouter) — Foundry
sdk/       dual-lane SDK + exact off-chain quote mirrors (quote.mjs / clmm-quote.mjs)
harness/   reusable dual-lane test harness — node:test suites, both lanes, live chain
app/       the Next.js dApp (:3200) — multi-chain, dual-wallet
```

---

## Using the app

Open [`dex.devnet.romeprotocol.xyz`](https://dex.devnet.romeprotocol.xyz) (or run locally, below).

1. **Pick a chain.** The header shows a chain switcher when more than one chain is configured (Hadrian / Martius). Your selection persists locally; server-side quotes and on-chain calls follow it.
2. **Connect a wallet.** Two independent pills — **EVM** (MetaMask / Coinbase / any EIP-6963 wallet; you pick which if several are installed) and **SOL** (Phantom). Connect either or both. Click a connected pill (or its **✕**) to disconnect. You need gas on the active chain for the lane you use.
3. **Swap** (`/`): pick tokens + amount, review the live quote + price impact (exact-in or exact-out), execute on whichever lane your wallet is.
4. **Provide liquidity** (`/pools`): open a pool row → add/withdraw. LP tokens are dual-lane (SPL = ERC-20).
5. **Create a pool** (`/pools` → *+ Create pool*): choose **Simple** (constant-product) or **Concentrated** (CLMM), pick the two tokens (or paste any mint — decimals are read on-chain), set the initial price/seed + fee tier, and submit on either lane. It appears under *"Pools you created"* (a device-local list — created pools aren't globally scannable). Pools are cluster-shared, so if the pair+fee already exists, use *"Find a pool"* instead of creating.
6. **Find a pool** (`/pools`): a pool is a deterministic PDA, so entering a token pair + fee + type derives its address and checks it exists on-chain — surfacing pools created elsewhere (or on another chain) so you can trade them.
7. **CLMM** (`/clmm`): pick a price range and manage a concentrated position (open / increase / decrease / collect / close), dual-lane.
8. **Farms** (`/farms`): stake an LP mint, accrue + claim emissions.

> **No oracle on some chains:** a chain without Oracle Gateway feeds shows blank USD prices — swaps and quotes are unaffected (they use pool reserves).

---

## Build & test

```bash
# Solana programs (native)
cd program && cargo build-sbf && cargo test --lib     # AMM core (+ clmm/ farm/ orders/ likewise)

# Dual-lane on-chain harness (live chain, sequential — shares live pools + one EOA nonce)
cd harness && npm i
HADRIAN_PRIVATE_KEY=<your-funded-devnet-key> \
  npm test            # or: npm run test:fresh  (brand-new-wallet acceptance)

# The dApp
cd app && npm i && npm run dev                          # :3200  (reads app/chains.yaml)
```

The default harness target is Hadrian (`EVM_RPC` overridable). **Quote source of truth:** `sdk/quote.mjs` / `sdk/clmm-quote.mjs` are byte-faithful mirrors of the on-chain math, guarded against realized on-chain amounts; the `app/lib/*quote*.ts` TS mirrors must track them.

## Deploy

The AMM programs, EVM routers, and frontend deploy via the standard Rome flow. The frontend is chain-config-driven — adding a chain to the switcher is a `chains.yaml` edit, not a rebuild — and live contract addresses resolve from [`@rome-protocol/registry`](https://github.com/rome-protocol/rome-registry).

## Provenance

The AMM core forks **[`spl-token-swap`](https://github.com/solana-labs/solana-program-library/tree/master/token-swap)** (Solana Labs, Apache-2.0). We keep the curve/fee math and add the parity layer — authority-agnostic instructions, an account-lean + ALT-friendly layout for a cheap EVM lane, `CreatePool` (no ephemeral signers, so the EVM lane can create pools), exact-out, and the dual-lane SDK/UI. The x·y=k curve is not the novel part — the two-lane parity layer is. See `LICENSE` + `NOTICE`.

## Building on Rome with an agent
See [`AGENTS.md`](./AGENTS.md) — the Rome-specific rules a coding agent needs.
