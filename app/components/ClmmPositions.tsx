"use client";

// ClmmPositions — the /positions view of concentrated positions. Reads the
// device's band index (lib/clmmPositions) across EVERY known pool (config +
// device-created), verifies each band on-chain, and renders only what exists.
// Management (collect/withdraw/close) lives on /clmm — this section links there.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { clmmPools, type ClmmConfigFlat } from "@/lib/clmm";
import { trackedBands, type Band } from "@/lib/clmmPositions";
import { readPosition } from "@/lib/clmm-actions";
import { evmPdaFor } from "@/lib/walletActions";
import { tickToPrice, type ClmmPosition } from "@/lib/clmm-quote";
import { fmtRaw } from "@/lib/format";

interface Row { cfg: ClmmConfigFlat; band: Band; state: ClmmPosition }

function fmtPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "—";
  return p < 1 ? p.toPrecision(4) : p.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function ClmmPositions() {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  const pools = useMemo(() => (chain ? clmmPools(chain) : []), [chain]);

  const ownerKey = useMemo(() => {
    if (wallet.evm && chain) return evmPdaFor(wallet.evm, chain.romeEvmProgramId).toBase58();
    if (wallet.solana) { try { return new PublicKey(wallet.solana).toBase58(); } catch { return null; } }
    return null;
  }, [wallet.evm, wallet.solana, chain]);

  const [rows, setRows] = useState<Row[]>([]);
  const load = useCallback(async () => {
    if (!ownerKey || !chain || pools.length === 0) { setRows([]); return; }
    const owner = new PublicKey(ownerKey);
    const out: Row[] = [];
    for (const cfg of pools) {
      for (const band of trackedBands(ownerKey, cfg.pool)) {
        const st = await readPosition(chain, owner, band.lower, band.upper, cfg).catch(() => null);
        if (st && st.isInitialized) out.push({ cfg, band, state: st });
      }
    }
    setRows(out);
  }, [ownerKey, chain, pools]);
  useEffect(() => { load(); }, [load]);

  if (!ownerKey || rows.length === 0) return null;

  return (
    <section style={{ marginTop: 28 }} data-testid="clmm-positions-section">
      <div className="rowhead">
        <span className="side">Concentrated positions</span>
        <Link href="/clmm" className="side" style={{ fontSize: 13.5 }}>manage on the range screen →</Link>
      </div>
      {rows.map(({ cfg, band, state }) => {
        const owed = state.tokensOwed0 > 0n || state.tokensOwed1 > 0n;
        return (
          <div key={`${cfg.pool}:${band.lower}:${band.upper}`} className="route" style={{ marginTop: 8 }}
            data-testid={`clmm-portfolio-${band.lower}-${band.upper}`}>
            <div className="r"><span>Pool</span><b>{cfg.symbol0} / {cfg.symbol1} · {(cfg.feePips / 10_000).toFixed(2)}%</b></div>
            <div className="r"><span>Band</span><b>{fmtPrice(tickToPrice(band.lower, cfg.decimals0, cfg.decimals1))} – {fmtPrice(tickToPrice(band.upper, cfg.decimals0, cfg.decimals1))} {cfg.symbol1}/{cfg.symbol0}</b></div>
            {owed && <div className="r"><span>Uncollected fees</span><b>{fmtRaw(state.tokensOwed0, cfg.decimals0)} {cfg.symbol0} + {fmtRaw(state.tokensOwed1, cfg.decimals1)} {cfg.symbol1}</b></div>}
          </div>
        );
      })}
    </section>
  );
}
