"use client";

// The swap-journey strip — the hero of the swap screen, and a truthful one:
//   • LOOK-AHEAD  — with a live quote it shows exactly what will happen for
//     THIS wallet (the one-time approval step appears only when a real
//     allowance read says that prompt is coming);
//   • LIVE        — during execution each step advances from actual wallet /
//     chain callbacks, never from assumptions;
//   • RECEIPT     — on success the transaction hash lands here; on failure it
//     says plainly that nothing moved.
// With no wallet or no amount it falls back to a generic three-step journey.
// The plan/live/receipt rendering is the shared FlowStrip pieces; only the
// swap's copy + pool-step lane rule live here. No dev telemetry anywhere.

import { useWallet } from "./WalletContext";
import { useSwapFlow, type FlowStep, type FlowState } from "./SwapFlow";
import { FlowTag, FlowStepRow, FlowReceipt, type FlowCopy } from "./FlowStrip";
import type { FlowLane } from "@/lib/flowState";

export default function LegStrip({ tokenIn, tokenOut, tier }: { tokenIn: string; tokenOut: string; tier: string }) {
  const wallet = useWallet();
  const flow = useSwapFlow()?.flow;

  if (flow && flow.steps) return <TrackedJourney flow={flow} />;

  // ── Generic journey (no wallet / no amount yet) ──────────────────────────
  const lane = wallet.evm ? "evm" : wallet.solana ? "sol" : "evm";

  if (lane === "sol") {
    return (
      <div className="leg-strip card" style={{ padding: "20px 22px" }}>
        <div className="leg-head">
          <span className="eyebrow">Your swap · step by step</span>
          <span className="atomtag">● one signature</span>
        </div>
        <div className="legs">
          <Leg lane="sol" title={`${tokenIn} → ${tokenOut} on the shared pool`} sub={`live pool pricing · ${tier} fee tier`} cell="1" last />
        </div>
        <div style={footRow}>
          <span>Your Solana wallet trades the pool directly</span>
          <span>Never less than your quoted minimum</span>
        </div>
      </div>
    );
  }

  return (
    <div className="leg-strip card" style={{ padding: "20px 22px" }}>
      <div className="leg-head">
        <span className="eyebrow">Your swap · step by step</span>
        <span className="atomtag">● settles as one transaction · entirely or not at all</span>
      </div>
      <div className="legs">
        <Leg lane="evm" title={`${tokenIn} leaves your wallet`} sub="your token is the real thing on both sides — nothing wrapped" cell="1" />
        <Leg lane="sol" title={`${tokenIn} → ${tokenOut} on the shared pool`} sub={`live pool pricing · ${tier} fee tier`} cell="2" />
        <Leg lane="evm" title={`${tokenOut} lands in your wallet`} sub="never less than your quoted minimum" cell="3" last />
      </div>
      <div style={footRow}>
        <span>You confirm in your wallet — the pool does the rest</span>
        <span>If any step fails, nothing moves</span>
      </div>
    </div>
  );
}

// ── The tracked journey (plan → live → receipt), built from shared pieces ──

function TrackedJourney({ flow }: { flow: FlowState }) {
  const copy: FlowCopy = {
    eyebrow: "Your swap · step by step",
    doneVerb: "swapped",
    extraTag: "includes a one-time approval",
    idleHint: flow.needsApproval
      ? "Two wallet prompts: the one-time approval, then the swap"
      : flow.lane === "sol"
      ? "One quick signature in your wallet"
      : "One confirmation in your wallet",
    successHint: "Done — settled as one transaction",
  };
  return (
    <div className="leg-strip card" style={{ padding: "20px 22px" }}>
      <div className="leg-head">
        <span className="eyebrow">{copy.eyebrow}</span>
        <FlowTag flow={flow} testid="flow" copy={copy} />
      </div>
      <div className="legs">
        {flow.steps!.map((s, i) => (
          <FlowStepRow key={s.id} step={s} lane={legLane(s, flow)} index={i + 1} last={i === flow.steps!.length - 1} testid="flow" />
        ))}
      </div>
      <FlowReceipt flow={flow} testid="flow" copy={copy} />
    </div>
  );
}

/** Wallet-side steps take the lane color; the pool step is always Solana. */
function legLane(step: FlowStep, flow: FlowState): FlowLane {
  if (step.id === "swap") return "sol";
  return flow.lane === "sol" ? "sol" : "evm";
}

const footRow: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", marginTop: 14, paddingTop: 12,
  borderTop: "1px solid var(--line)", fontSize: 13.5, color: "var(--muted)", gap: 12, flexWrap: "wrap",
};

function Leg({ lane, title, sub, cell, last }: { lane: "evm" | "sol"; title: string; sub: string; cell: string; last?: boolean }) {
  return (
    <div className="leg">
      <div className="rail">
        <div className={`dot ${lane}`}>{lane === "evm" ? "◆" : "◎"}</div>
        {!last && <div className="spine" />}
      </div>
      <div className="body">
        <div className="t">{title}</div>
        <div className="dt">{sub}</div>
      </div>
      <div className="cu">{cell}</div>
    </div>
  );
}
