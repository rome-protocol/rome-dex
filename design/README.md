# Rome DEX — Design Components

Standalone, self-contained HTML preview cards for the Rome DEX UI, authored against the
**Rome Protocol Design System** (claude.ai/design). Each file is a single `<!DOCTYPE html>`
with an inline `<style>`, Google-font `@import`, and no external dependencies — open any file
directly in a browser to preview.

## Brand tokens (shared across all files)

- **Colors** — `--rome-purple #5E0A60` (accent/links/primary button), `--rome-purple-hover #4a0849`,
  `--rome-dark-purple #140218`, `--rome-cream #FBF8F4` (page bg), `--rome-paper #F4F0EA`,
  `--rome-ink #1A1814` (text), `--rome-stone-400 #6E6657` (muted), pastels
  pink `#F9E3F2` / blue `#DBEFF7` / lavender `#D5D3EA`, hairline border `rgba(20,2,24,.08)`.
- **Fonts** — Literata (serif headlines + amounts), DM Sans (body/UI), IBM Plex Mono
  (addresses, numerals, hashes, uppercase eyebrows).
- **Style** — editorial + flat: no shadows, no outlines. Serif headlines, cream page,
  purple accents, pill buttons (radius 999px), hairline borders, uppercase mono eyebrows
  (letter-spacing .14em), all numbers/addresses in IBM Plex Mono.

Component styling reuses/adapts the already-Rome-branded reference at
`the design reference` (card, amount-row, pill button, dark plum stat card, mono eyebrow).

## Components

| File | Component | Description | Design-system group |
|---|---|---|---|
| `swap.html` | **Swap card** | Token-in / token-out selectors, serif amount input, flip control, rate + minimum-received + price-impact facts, pill "Swap" button, and a dual-wallet (MetaMask + Phantom) lane indicator with the "both lanes trade the same pool" line. | DEX / Trade |
| `liquidity.html` | **Add & remove liquidity** | Add tab (dual token inputs, pool-share + LP-minted facts) and Remove tab (position readout, percentage selector, receive amounts) with primary + ghost pill buttons. | DEX / Pools |
| `pool.html` | **Pool / position view** | Pair header, reserves + TVL / volume / fees metrics, pool address, and a dark plum "Your position" card (pooled amounts, pool share, fees earned) in mono + serif. | DEX / Pools |
| `connect.html` | **Dual-wallet connect header** | Brand bar with MetaMask + Phantom wallet chips, hero explainer, per-lane connect cards (EVM lane signs RLP / Solana lane signs DoTx), and a "both wallets trade & LP the same pool" banner — the dual-lane story. | DEX / Shell & Navigation |

## Relationship to live app components

These snapshots mirror the live app components in `app/components/`:

| Design file | Live component | Notes |
|---|---|---|
| `swap.html` | `SwapPanel.tsx` | Populated quote state, seg-ctrl tabs, token-pill badges, live-dot indicator |
| `pool.html` | `PoolView.tsx` | Dark plum stat card, pool-stat-grid layout, pulsing live-dot |
| `liquidity.html` | `LiquidityPanel.tsx` | Add + remove panels, seg-ctrl, token-pill badges, pct chips |
| `connect.html` | `Header.tsx` + `WalletContext.tsx` | Dual-lane connect bar with MetaMask connected / Phantom disconnected states |

CSS variables, font choices, radius tokens, and component patterns (seg-ctrl, token-pill, live-dot, pool-stat-grid, dual-lane-bar) are shared between the design files and `app/globals.css`. Any visual change to the live app should be reflected here.

## Notes

- All amounts, rates, addresses, chain ids, and hashes are rendered in IBM Plex Mono per brand.
- Numbers shown are illustrative placeholders for design preview only (no real on-chain data).
- Files are self-contained by design so they upload cleanly as individual design cards.
- Each file starts with `<!-- @dsCard group="rome-dex" -->` as required by the design system.
