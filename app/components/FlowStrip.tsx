"use client";

// FlowStrip — the shared presentational layer for the truthful-flow tracker.
// One step row, one status tag, one receipt footer, rendered the same way for
// every surface: the swap hero (LegStrip) composes these pieces at full size;
// the compact panels (liquidity, orders) render the default <FlowStrip>. All of
// them show OUTCOMES only — the copy each surface passes in never leaks dev
// telemetry (guarded by e2e/render.spec).

import type { FlowState, FlowStep, FlowLane } from "@/lib/flowState";

/** Per-surface copy. Everything the shared pieces render is passed in, so the
 *  same components narrate a swap, a deposit, or an order without knowing which. */
export interface FlowCopy {
  /** Eyebrow above the steps, e.g. "Adding liquidity · step by step". */
  eyebrow: string;
  /** Word after the ✓ on success, e.g. "swapped" / "added" / "placed". */
  doneVerb: string;
  /** Idle tag when a prep prompt precedes the action, e.g. "includes a one-time approval". */
  extraTag: string;
  /** Left-cell hint shown in the idle look-ahead (the honest wallet-prompt count). */
  idleHint: string;
  /** Right-cell hint on success. */
  successHint: string;
  /** Left-cell hint while running. */
  runningHint?: string;
  /** Right-cell hint on error. */
  errorHint?: string;
  /** Right-cell hint shown idle + running. */
  assurance?: string;
  /** Success link label. */
  txLinkText?: string;
}

const DEFAULTS = {
  runningHint: "Keep your wallet open — it will ask when it's your turn",
  errorHint: "You can try again",
  assurance: "If anything fails, nothing moves",
  txLinkText: "View your transaction ↗",
};

/** The status tag (top-right of the strip). */
export function FlowTag({ flow, testid, copy }: { flow: FlowState; testid: string; copy: FlowCopy }) {
  if (flow.phase === "running") return <span className="atomtag">● happening now…</span>;
  if (flow.phase === "success") return <span className="atomtag" data-testid={`${testid}-done`}>✓ {copy.doneVerb}</span>;
  if (flow.phase === "error") return <span className="atomtag flow-stopped" data-testid={`${testid}-failed`}>✕ stopped</span>;
  if (flow.needsApproval) return <span className="atomtag">● {copy.extraTag}</span>;
  return <span className="atomtag">{flow.lane === "sol" ? "● one signature" : "● one confirmation"}</span>;
}

/** One journey step (dot + rail + title/sub + state glyph). */
export function FlowStepRow({
  step, lane, index, last, testid,
}: { step: FlowStep; lane: FlowLane; index: number; last?: boolean; testid: string }) {
  const glyph =
    step.state === "done" ? "✓"
    : step.state === "failed" ? "✕"
    : step.state === "skipped" ? "—"
    : step.state === "active" ? "●"
    : String(index);
  return (
    <div className="leg" data-testid={`${testid}-step-${step.id}`} data-flow-state={step.state}>
      <div className="rail">
        <div className={`dot ${lane}`}>{lane === "evm" ? "◆" : "◎"}</div>
        {!last && <div className="spine" />}
      </div>
      <div className="body">
        <div className="t">{step.title}</div>
        {step.sub && <div className="dt">{step.sub}</div>}
      </div>
      <div className={`cu flow-cell flow-${step.state}`}>{glyph}</div>
    </div>
  );
}

const footRow: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", marginTop: 14, paddingTop: 12,
  borderTop: "1px solid var(--line)", fontSize: 13.5, color: "var(--muted)", gap: 12, flexWrap: "wrap",
};

/** The receipt footer: tx link on success, "nothing moved" on failure, honest
 *  guidance otherwise. */
export function FlowReceipt({ flow, testid, copy }: { flow: FlowState; testid: string; copy: FlowCopy }) {
  return (
    <div style={footRow}>
      {flow.phase === "success" && flow.txHash ? (
        <>
          <a
            data-testid={`${testid}-tx-link`}
            href={flow.explorer}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontWeight: 600 }}
          >
            {copy.txLinkText ?? DEFAULTS.txLinkText}
          </a>
          <span>{copy.successHint}</span>
        </>
      ) : flow.phase === "error" ? (
        <>
          <span style={{ color: "var(--down, #e5484d)" }}>{flow.note ?? "Stopped — nothing moved."}</span>
          <span>{copy.errorHint ?? DEFAULTS.errorHint}</span>
        </>
      ) : flow.phase === "running" ? (
        <>
          <span>{copy.runningHint ?? DEFAULTS.runningHint}</span>
          <span>{copy.assurance ?? DEFAULTS.assurance}</span>
        </>
      ) : (
        <>
          <span>{copy.idleHint}</span>
          <span>{copy.assurance ?? DEFAULTS.assurance}</span>
        </>
      )}
    </div>
  );
}

/**
 * The compact strip for self-contained panels (liquidity, orders). Renders only
 * when a plan exists (`flow.steps`). `laneOf` defaults to the flow's lane for
 * every step; the swap hero overrides it (its pool step is always Solana).
 */
export default function FlowStrip({
  flow, testid, copy, laneOf, containerTestId,
}: {
  flow: FlowState;
  testid: string;
  copy: FlowCopy;
  laneOf?: (step: FlowStep) => FlowLane;
  containerTestId?: string;
}) {
  if (!flow.steps) return null;
  const laneFor = laneOf ?? ((): FlowLane => (flow.lane === "sol" ? "sol" : "evm"));
  return (
    <div className="flow-strip-inline" data-testid={containerTestId}>
      <div className="leg-head">
        <span className="eyebrow">{copy.eyebrow}</span>
        <FlowTag flow={flow} testid={testid} copy={copy} />
      </div>
      <div className="legs">
        {flow.steps.map((s, i) => (
          <FlowStepRow key={s.id} step={s} lane={laneFor(s)} index={i + 1} last={i === flow.steps!.length - 1} testid={testid} />
        ))}
      </div>
      <FlowReceipt flow={flow} testid={testid} copy={copy} />
    </div>
  );
}
