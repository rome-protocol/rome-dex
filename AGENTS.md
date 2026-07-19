<!--
CANONICAL AGENTS.md (publishing initiative 3A.1). This is the template that
ships in every public Rome repo + create-rome-app scaffold. Public-safe: no
internal hostnames, infra/platform names, or internal repo paths. Links marked
(docs) resolve once the docs site publishes; the npm packages resolve at their
publish. Keep it short — an agent reads it before writing a line.
-->
# AGENTS.md — building on Rome with an AI coding agent

**Rome is EVM chains that run on Solana.** Your Solidity/EVM app executes inside a Solana program and can call Solana programs atomically (CPI). Two lanes reach the same chain and the same state: MetaMask/EVM tooling, and Phantom/Solana. This file is the set of Rome-specific rules to follow — vanilla-EVM habits produce plausible-but-wrong code here. Reads (`eth_call`, balances, logs) are standard; the differences are in **writes, gas, tooling, and CPI**.

## The rules that differ from vanilla EVM

### 1. Every Rome write goes through `submitRomeTx`
Do **not** send state-changing txs with raw `wagmi`/`ethers`/`viem` `writeContract`/`sendTransaction`. Rome writes have specific fee and submission semantics — use the SDK's `submitRomeTx` wrapper. Reads stay vanilla.

### 2. Gas: the estimate over-predicts; the charge is exact
`eth_estimateGas` can over-predict by a large factor — Rome charges the **exact** gas used, so do not hard-fail or size budgets off a high estimate. A plain **native-token transfer costs ~1.48M gas** on Rome (not 21k); budget for it in scripts and sweeps.

### 3. Foundry / Hardhat
`forge script` needs **`--skip-simulation`** (Rome's execution model breaks forge's local simulation). `forge create`, `cast`, and Hardhat work normally.

### 4. Calling Solana programs from Solidity (CPI — the differentiator)
Precompiles: **CPI `0xFF…08`**, **Helper `0xFF…09`**, **Withdraw `0x42…16`**. The account rules agents get wrong:
- the accounts array must be **non-empty**;
- the **operator and the program_id must NOT** appear in the accounts;
- to sign **as your contract**, use `HELPER.pda(address(this))` as the signer — the precompile signs as `msg.sender`, not `tx.origin`, so a router contract cannot sign a user's PDA.

Full ABI + per-selector billing: the precompile reference (docs).

### 5. Never hardcode addresses — read the registry
Chain ids, RPC URLs, contract addresses, token mints, and Solana program ids all come from **`@rome-protocol/registry`**. Hardcoded values drift and break across deploys.

### 6. Test both lanes with a fresh wallet
A Rome feature must work on the **EVM lane** (MetaMask) *and* the **Solana lane** (Phantom). Verify each with a brand-new wallet and a tiny amount before claiming done.

### 7. When a tx fails, use the taxonomy + the cross-VM map
Rome surfaces specific failures (starved pool-payer rent, StateHolder rent, emulation-vs-simulation mismatches, nonce races). Match them against the **error taxonomy** (docs). To see the Solana settlement of a Rome tx, map it with `solanaTxForEvmTx`.

## Live tools for your agent
> **Shipping with the Rome docs release** — the `rome-mcp` server and the `doctor` self-check below are being published alongside the docs site and are not on npm yet. Until then, read the registry directly via `@rome-protocol/registry` and verify manually (see below).

The **`rome-mcp`** server will give your agent live registry / balance / gas / bridge / faucet / docs access — a one-line `npx @rome-protocol/rome-mcp` install for Claude Code, Cursor, and Zed. It's **read-only + a rate-limited devnet faucet** (so an autonomous build→verify loop can self-fund fresh test wallets) and holds no keys — your app does the signing (via the SDK).

## Verify before you claim done
Before saying a change works: check RPC config, confirm every write goes through `submitRomeTx`, and run a **both-lane smoke** against devnet with a fresh wallet and a tiny amount. A one-command self-check (`npx @rome-protocol/doctor`) and a runnable funded end-to-end harness (fund → deploy → wrap → CPI-swap → assert) in `create-rome-app` scaffolds ship with the docs release.
