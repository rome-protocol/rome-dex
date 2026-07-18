// flowState.ts — the ONE truthful-flow state machine, shared by every surface
// that narrates a multi-step signing journey (the swap hero, the liquidity
// panel, the orders form). It is pure (no React): a plan is a look-ahead built
// from a REAL chain read, steps advance from ACTUAL execution callbacks, and a
// terminal state carries either the tx hash (success) or a plain "nothing
// moved" note (failure). SwapFlow wraps these in a context; useActionFlow wraps
// them in local component state. Behaviour is identical either way.

/** Step lifecycle. `skipped` = the plan predicted a step that execution proved
 *  unnecessary (e.g. an approval that turned out already granted). */
export type FlowStepState = "todo" | "active" | "done" | "failed" | "skipped";

/** One step in the journey. `id` is a plain string so each surface names its
 *  own steps (swap: approve/confirm/swap/receive; orders: setup/confirm/live). */
export interface FlowStep {
  id: string;
  title: string;
  sub?: string;
  state: FlowStepState;
}

export type FlowLane = "evm" | "sol";
export type FlowPhase = "idle" | "running" | "success" | "error";

export interface FlowState {
  /** idle = look-ahead only; running = executing; success/error = terminal. */
  phase: FlowPhase;
  lane: FlowLane | null;
  /** null → the surface renders its generic fallback (no wallet / no amount). */
  steps: FlowStep[] | null;
  /** Whether the plan includes a prep prompt (a one-time approval, or the
   *  account setup an EVM order needs) BEFORE the main action — from preflight,
   *  never assumed. Drives the honest wallet-prompt count in the copy. */
  needsApproval: boolean;
  txHash?: string;
  explorer?: string;
  /** Failure/cancel message (already humanized). */
  note?: string;
}

export const IDLE_FLOW: FlowState = {
  phase: "idle",
  lane: null,
  steps: null,
  needsApproval: false,
};

/** Replace the look-ahead plan. Never clobbers a live run. */
export function planFlow(
  f: FlowState,
  lane: FlowLane,
  steps: FlowStep[],
  needsApproval: boolean,
): FlowState {
  return f.phase === "running" ? f : { phase: "idle", lane, steps, needsApproval };
}

/** Enter the running phase, keeping the current plan and clearing any receipt. */
export function startFlow(f: FlowState): FlowState {
  return { ...f, phase: "running", txHash: undefined, explorer: undefined, note: undefined };
}

/**
 * Move one step to a state. Earlier steps are reconciled by what actually
 * happened: an ACTIVE one that we've now advanced past finished (done); a TODO
 * one we skipped never ran (skipped — e.g. a predicted approval that execution
 * found unnecessary). No-op if the id isn't in the plan.
 */
export function stepFlow(f: FlowState, id: string, state: FlowStepState): FlowState {
  if (!f.steps) return f;
  const idx = f.steps.findIndex((s) => s.id === id);
  if (idx < 0) return f;
  const steps = f.steps.map((s, i) => {
    if (i < idx && s.state === "active") return { ...s, state: "done" as const };
    if (i < idx && s.state === "todo") return { ...s, state: "skipped" as const };
    if (i === idx) return { ...s, state };
    return s;
  });
  return { ...f, steps };
}

/** Terminal success: every non-skipped step settles to done; hash + link land. */
export function succeedFlow(f: FlowState, txHash: string, explorer?: string): FlowState {
  return {
    ...f,
    phase: "success",
    txHash,
    explorer,
    steps: f.steps?.map((s) => (s.state === "skipped" ? s : { ...s, state: "done" as const })) ?? null,
  };
}

/** Terminal failure: the active step fails, the rest stay put, the note lands. */
export function failFlow(f: FlowState, note: string): FlowState {
  return {
    ...f,
    phase: "error",
    note,
    steps: f.steps?.map((s) => (s.state === "active" ? { ...s, state: "failed" as const } : s)) ?? null,
  };
}
