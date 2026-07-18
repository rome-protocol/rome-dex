"use client";

// SwapCard — the swap surface's tab switcher: Market | Limit | DCA.
//   • Market → the existing SwapPanel (unchanged), dual-lane.
//   • Limit / DCA → OrdersForm, native keeper-filled orders (Solana lane;
//     EVM-lane placement is gated with an honest note inside the form).
// Market is the default so the swap panel renders immediately on load.

import { useState } from "react";
import SwapPanel from "./SwapPanel";
import OrdersForm from "./OrdersForm";

type Tab = "market" | "limit" | "dca";

const TABS: { id: Tab; label: string }[] = [
  { id: "market", label: "Market" },
  { id: "limit", label: "Limit" },
  { id: "dca", label: "DCA" },
];

export default function SwapCard() {
  const [tab, setTab] = useState<Tab>("market");
  return (
    <div data-testid="swap-card">
      <div className="seg" style={{ width: "100%", marginBottom: 12 }} data-testid="order-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`order-tab-${t.id}`}
            aria-selected={tab === t.id}
            style={{ flex: 1 }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "market" ? <SwapPanel /> : <OrdersForm kind={tab} />}
    </div>
  );
}
