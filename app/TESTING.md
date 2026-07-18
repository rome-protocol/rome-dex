# rome-dex — hands-on wallet test (local)

Drive the live rome-dex on Hadrian from your **own** MetaMask + Phantom. The app
runs locally; it talks to the live chain. No backend key needed for real-wallet
mode (that's only the "Demo mode" fallback).

## 1. Run the app
```bash
cd app
rm -rf .next          # avoids the stale-build HTTP 500 gotcha
npm run dev           # → http://localhost:3200
```
Open http://localhost:3200. With MetaMask/Phantom installed, the Connect pills
use your real accounts (the mock address only appears if no wallet is injected).

## 2. Add the Rome network to MetaMask (once)
Settings → Networks → Add network manually:

| Field | Value |
|---|---|
| Network name | Rome Hadrian |
| RPC URL | `https://hadrian-lt.testnet.romeprotocol.xyz/` |
| Chain ID | `200010` |
| Currency symbol | `USDC` (gas token; display-only) |
| Block explorer | `https://via-hadrian.testnet.romeprotocol.xyz/` |

Phantom needs no setup — the Solana lane signs native rome-dex instructions on
the devnet substrate directly.

## 3. Fund your wallet
Tell me your MetaMask address (and Phantom pubkey if testing that lane) and I run:
```bash
cd harness
HADRIAN_PRIVATE_KEY=<your-funded-devnet-key> \
  node fund-wallet.mjs <yourEvmAddr> [yourPhantomPubkey]
```
This sends gas to your EVM address and mints 5,000 test wUSDC into the right
place for each lane (EVM: your `external_auth` PDA's ATA — where the router pulls
from; Solana: your own ATA).

## 4. What to try
- **Swap (EVM lane):** Connect MetaMask → type an amount of USDC → **Review swap**.
  First swap prompts an **Approve** ("Approve rome-dex to trade your USDC") — a
  one-time SPL delegate to the router PDA — then the swap itself. Both are single
  MetaMask signatures. Watch it land as ONE atomic Solana tx (via the explorer
  link).
- **Swap (Solana lane):** Connect Phantom → same flow, native signature.
- **Fee tiers:** Auto picks best price; or pin 0.05 / 0.30 / 1.00%.
- **Pools / Pool detail:** browse live reserves; add / remove / **zap** liquidity.
- **Positions / Analytics:** your LP value is live; volume/APR are sample-flagged
  until the indexer ships.

## Notes
- Router: `0xAB59357C2671Aa08b72781BcB12EFF7e0ffBd9f2` (chain 200010). The EVM lane
  goes through it → ~132B calldata, single atomic leg.
- If a swap says "wrong network", switch MetaMask to Rome Hadrian (step 2).
- 2-pool atomic routing is gated on the proxy ALT-cover pickup —
  single-pool swaps/liquidity/zap are fully live now.
