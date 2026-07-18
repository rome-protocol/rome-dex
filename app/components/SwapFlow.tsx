"use client";

// SwapFlow — shared state between the swap panel (which executes) and the
// journey strip (which narrates). The panel publishes a TRUTHFUL per-user plan
// before the trade (the one-time-approval step appears only when a real
// allowance read says it will happen), advances step states from actual
// execution callbacks as they fire, and lands the tx hash here on success.
//
// The state machine itself lives in lib/flowState.ts (pure, shared with the
// liquidity + orders panels via useActionFlow) — this file is just the swap's
// context wrapper over it.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  IDLE_FLOW,
  planFlow,
  startFlow,
  stepFlow,
  succeedFlow,
  failFlow,
  type FlowState,
  type FlowStep,
  type FlowStepState,
} from "@/lib/flowState";

// Re-exported so existing consumers (SwapPanel, LegStrip) keep importing flow
// types from here.
export type { FlowState, FlowStep, FlowStepState } from "@/lib/flowState";

/** Swap journey step ids, in order. `approve` is present only when truly needed. */
export type FlowStepId = "approve" | "confirm" | "swap" | "receive";

interface FlowApi {
  flow: FlowState;
  /** Replace the look-ahead plan (idle). */
  plan(lane: "evm" | "sol", steps: FlowStep[], needsApproval: boolean): void;
  /** Enter the running phase (keeps the current plan). */
  start(): void;
  /** Move one step to a state (and any earlier non-terminal steps accordingly). */
  step(id: FlowStepId, state: FlowStepState): void;
  /** Terminal success: every step done, hash + explorer link land in the strip. */
  succeed(txHash: string, explorer?: string): void;
  /** Terminal failure: the active step fails, the rest stay put. */
  fail(note: string): void;
  /** Back to the generic journey. */
  reset(): void;
}

const Ctx = createContext<FlowApi | null>(null);

export function SwapFlowProvider({ children }: { children: React.ReactNode }) {
  const [flow, setFlow] = useState<FlowState>(IDLE_FLOW);

  const plan = useCallback(
    (lane: "evm" | "sol", steps: FlowStep[], needsApproval: boolean) =>
      setFlow((f) => planFlow(f, lane, steps, needsApproval)),
    [],
  );
  const start = useCallback(() => setFlow((f) => startFlow(f)), []);
  const step = useCallback((id: FlowStepId, state: FlowStepState) => setFlow((f) => stepFlow(f, id, state)), []);
  const succeed = useCallback((txHash: string, explorer?: string) => setFlow((f) => succeedFlow(f, txHash, explorer)), []);
  const fail = useCallback((note: string) => setFlow((f) => failFlow(f, note)), []);
  const reset = useCallback(() => setFlow(IDLE_FLOW), []);

  const api = useMemo(
    () => ({ flow, plan, start, step, succeed, fail, reset }),
    [flow, plan, start, step, succeed, fail, reset],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** Null outside a provider — consumers fall back to the generic journey. */
export function useSwapFlow(): FlowApi | null {
  return useContext(Ctx);
}
