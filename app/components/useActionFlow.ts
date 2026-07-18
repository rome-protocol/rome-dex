"use client";

// useActionFlow — the truthful-flow state machine as component-local state, for
// self-contained panels (liquidity, orders) that own their whole journey. Same
// API as the swap's SwapFlow context, but private to one panel so its strip
// never crosses wires with another surface on the same route. The transitions
// are the shared pure functions in lib/flowState.ts — one implementation.

import { useCallback, useMemo, useState } from "react";
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
  type FlowLane,
} from "@/lib/flowState";

export interface ActionFlowApi {
  flow: FlowState;
  plan(lane: FlowLane, steps: FlowStep[], needsApproval: boolean): void;
  start(): void;
  step(id: string, state: FlowStepState): void;
  succeed(txHash: string, explorer?: string): void;
  fail(note: string): void;
  reset(): void;
}

export function useActionFlow(): ActionFlowApi {
  const [flow, setFlow] = useState<FlowState>(IDLE_FLOW);

  const plan = useCallback(
    (lane: FlowLane, steps: FlowStep[], needsApproval: boolean) =>
      setFlow((f) => planFlow(f, lane, steps, needsApproval)),
    [],
  );
  const start = useCallback(() => setFlow((f) => startFlow(f)), []);
  const step = useCallback((id: string, state: FlowStepState) => setFlow((f) => stepFlow(f, id, state)), []);
  const succeed = useCallback((txHash: string, explorer?: string) => setFlow((f) => succeedFlow(f, txHash, explorer)), []);
  const fail = useCallback((note: string) => setFlow((f) => failFlow(f, note)), []);
  const reset = useCallback(() => setFlow(IDLE_FLOW), []);

  return useMemo(
    () => ({ flow, plan, start, step, succeed, fail, reset }),
    [flow, plan, start, step, succeed, fail, reset],
  );
}
