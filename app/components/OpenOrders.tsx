"use client";

// OpenOrders — the connected wallet's limit + DCA orders. Wallet-only: reads the
// tracked order PDAs from localStorage (keyed by the Solana owner pubkey) and
// hydrates live state via readOrders (getMultipleAccountsInfo). Open rows can be
// cancelled (refunds the input escrow). Orders are Solana-lane, so this reads
// the connected Solana wallet.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "./WalletContext";
import { useActiveChain } from "@/lib/chains/store";
import { poolForTier, evmPdaFor, type Pool } from "@/lib/walletActions";
import {
  loadTrackedOrders,
  readOrders,
  cancelOrder,
  cancelOrderEvm,
  OrderStatus,
  type StoredOrder,
  type OrderWithPda,
} from "@/lib/orders";
import { PairGlyphs } from "@/components/PairGlyphs";
import { fmtRaw } from "@/lib/format";
import { toTxStatus } from "@/lib/txerror";

interface Row {
  stored: StoredOrder;
  order: OrderWithPda;
  pool: Pool;
  lane: "sol" | "evm";
}

const STATUS_LABEL: Record<number, string> = {
  [OrderStatus.Open]: "Open",
  [OrderStatus.Filled]: "Filled",
  [OrderStatus.Cancelled]: "Cancelled",
  [OrderStatus.Expired]: "Expired",
};

function statusClass(effective: string): string {
  if (effective === "Open") return "sol";
  if (effective === "Filled") return "up";
  return "tier"; // Cancelled / Expired — muted
}

// Effective status: an Open order past its expiry is really Expired (pending a
// keeper crank), so surface that rather than a stale "Open".
function effectiveStatus(o: OrderWithPda, nowSecs: bigint): string {
  if (o.status === OrderStatus.Open && o.expiryTs > 0n && nowSecs >= o.expiryTs) return "Expired";
  return STATUS_LABEL[o.status] ?? "Open";
}

// Limit price implied by the order: minOutPerTranche / trancheIn, decimal-adjusted.
function impliedPrice(o: OrderWithPda, pool: Pool): string {
  if (o.minOutPerTranche <= 0n || o.trancheIn <= 0n) return "Market";
  const decSrc = o.aToB ? pool.decimalsA : pool.decimalsB;
  const decDst = o.aToB ? pool.decimalsB : pool.decimalsA;
  const P = 1_000_000n; // display precision
  const scaled = (o.minOutPerTranche * P * 10n ** BigInt(decSrc)) / (o.trancheIn * 10n ** BigInt(decDst));
  const price = Number(scaled) / Number(P);
  return price < 1 ? price.toFixed(6) : price.toFixed(4);
}

export default function OpenOrders() {
  const wallet = useWallet();
  const { chain } = useActiveChain();
  // Dual-lane: orders are tracked under their owner key — the Solana or EVM lane
  // pubkey on the Solana lane, the external_auth PDA on the EVM lane. Read both.
  const solOwner = wallet.solana;
  const evmOwner = wallet.evm && chain ? evmPdaFor(wallet.evm, chain.romeEvmProgramId).toBase58() : null;
  const anyWallet = Boolean(solOwner || evmOwner);
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<{ kind: "err" | "cancelled" | "pending" | "ok"; msg: string } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!anyWallet || !chain) { setRows([]); setLoaded(true); return; }
    try {
      const sources: { key: string; lane: "sol" | "evm" }[] = [];
      if (solOwner) sources.push({ key: solOwner, lane: "sol" });
      if (evmOwner) sources.push({ key: evmOwner, lane: "evm" });
      const tracked = sources.flatMap((s) => loadTrackedOrders(s.key).map((t) => ({ t, lane: s.lane })));
      if (!tracked.length) { setRows([]); setLoaded(true); return; }
      const live = await readOrders(chain, tracked.map(({ t }) => t.pda));
      const byPda = new Map(live.map((o) => [o.pda, o]));
      const built: Row[] = [];
      for (const { t: stored, lane } of tracked) {
        const order = byPda.get(stored.pda);
        if (!order) continue; // account gone (closed) — drop from the view
        built.push({ stored, order, pool: poolForTier(chain, stored.tier, stored.pairId), lane });
      }
      setRows(built);
    } catch (e) {
      const { message } = toTxStatus(e);
      setStatus({ kind: "err", msg: message });
    } finally {
      setLoaded(true);
    }
  }, [solOwner, evmOwner, anyWallet, chain]);

  useEffect(() => { setLoaded(false); refresh(); }, [refresh]);

  async function onCancel(row: Row) {
    if (!chain) return;
    setCancelling(row.order.pda);
    setStatus({ kind: "pending", msg: "Cancelling order…" });
    try {
      const order = { pda: row.order.pda, inputEscrow: row.order.inputEscrow, aToB: row.order.aToB, pool: row.pool };
      if (row.lane === "evm" && wallet.evm) {
        await cancelOrderEvm(chain, { eoa: wallet.evm, order });
      } else if (row.lane === "sol" && wallet.solana) {
        await cancelOrder(chain, { ownerPubkey: wallet.solana, order });
      } else return;
      setStatus({ kind: "ok", msg: "Order cancelled — input refunded." });
      await refresh();
    } catch (e) {
      const { cancelled, message } = toTxStatus(e);
      setStatus({ kind: cancelled ? "cancelled" : "err", msg: message });
    } finally {
      setCancelling(null);
    }
  }

  const nowSecs = useMemo(() => BigInt(Math.floor(Date.now() / 1000)), []);

  return (
    <div style={{ marginTop: 28 }} data-testid="open-orders">
      <div className="sc-head" style={{ marginBottom: 14 }}>
        <div>
          <div className="eyebrow">Limit &amp; DCA</div>
          <h2 style={{ fontSize: 20 }}>Open orders</h2>
        </div>
      </div>

      {status && status.kind !== "pending" && (
        <div className={`note ${status.kind}`} data-testid="open-orders-status" style={{ marginBottom: 12 }}>
          {status.msg}
        </div>
      )}

      {!loaded ? (
        <div className="card" style={{ color: "var(--muted)" }}>Loading orders…</div>
      ) : rows.length === 0 ? (
        <div className="card" data-testid="open-orders-empty" style={{ color: "var(--muted)" }}>
          No open orders.
          {!anyWallet && <div style={{ marginTop: 6, fontSize: 13.5 }}>Connect an EVM or Solana wallet to view your limit &amp; DCA orders.</div>}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="tbl" data-testid="open-orders-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Side</th>
                <th>Type</th>
                <th className="th-right">Amount in</th>
                <th className="th-right">Limit price</th>
                <th className="th-right">Filled</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const { order, pool } = row;
                const decSrc = order.aToB ? pool.decimalsA : pool.decimalsB;
                const srcSym = order.aToB ? pool.symbolA : pool.symbolB;
                const dstSym = order.aToB ? pool.symbolB : pool.symbolA;
                const side = order.aToB ? "Sell" : "Buy";
                const filledPct = order.amountInTotal > 0n
                  ? Number(order.amountInTotal - order.remainingIn) * 100 / Number(order.amountInTotal)
                  : 0;
                const price = impliedPrice(order, pool);
                const eff = effectiveStatus(order, nowSecs);
                const isOpen = order.status === OrderStatus.Open;
                return (
                  <tr key={order.pda} data-testid={`order-row-${order.pda}`}>
                    <td>
                      <div className="pair">
                        <PairGlyphs a={pool.symbolA} b={pool.symbolB} />
                        <b>{pool.symbolA} / {pool.symbolB}</b>
                      </div>
                    </td>
                    <td>
                      <span className={order.aToB ? "down" : "up"} style={{ fontWeight: 600 }}>{side}</span>
                      <div style={{ fontSize: 13.5, color: "var(--faint)" }}>{srcSym} → {dstSym}</div>
                    </td>
                    <td><span className="badge tier">{row.stored.kind === "dca" ? "DCA" : "Limit"}</span></td>
                    <td className="r-right mono">{fmtRaw(order.amountInTotal, decSrc)} {srcSym}</td>
                    <td className="r-right mono">{price === "Market" ? "Market" : `${price} ${dstSym}`}</td>
                    <td className="r-right mono">{filledPct.toFixed(filledPct > 0 && filledPct < 1 ? 2 : 0)}%</td>
                    <td><span className={`badge ${statusClass(eff)}`} data-testid={`order-status-${order.pda}`}>{eff}</span></td>
                    <td className="r-right">
                      {isOpen && (
                        <button
                          className="btn ghost"
                          data-testid={`order-cancel-${order.pda}`}
                          style={{ padding: "7px 12px", fontSize: 13.5 }}
                          onClick={() => onCancel(row)}
                          disabled={cancelling === order.pda}
                        >
                          {cancelling === order.pda ? "Cancelling…" : "Cancel"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
