// Shared EIP-1559 (type-2) gas resolver for the Rome CPI lane.
//
// Hadrian runs an EIP-1559 + congestion-aware fee market:
//   • eth_estimateGas simulates real swap calldata correctly (returns a sane
//     number, no panic) → gasLimit = estimate × 1.3, with the 300M ceiling kept
//     ONLY as a last-resort fallback when estimateGas errors.
//   • maxPriorityFeePerGas is a USER-CONTROLLABLE tip. Default = live
//     eth_maxPriorityFeePerGas (congestion-aware; 0 when idle); the UI can
//     override it via priorityFeeGwei.
//   • maxFeePerGas = baseFee×2 + maxPriorityFeePerGas, where baseFee is the
//     latest block's baseFeePerGas (fallback to feeHistory tail, floored at
//     BASE_FEE_FLOOR so the tx is never rejected for a too-low / zero fee).
//
// Verified on Hadrian: type-2 swaps land, estimateGas×1.3 is a workable limit,
// baseFee ≈ 0–1000 wei, maxFee = 2000 accepted.

import { padRomeGas } from "@rome-protocol/sdk";

export const GAS_CEILING = 300_000_000n;          // fallback gasLimit if estimate errors
// The ×1.3 estimate pad is provided by @rome-protocol/sdk padRomeGas().
export const BASE_FEE_FLOOR = 1_000n;             // wei — keeps maxFee > 0 on idle devnet
const GWEI = 1_000_000_000n;

async function rpc(method: string, params: unknown[], url: string): Promise<{ result?: unknown; error?: unknown }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return r.json();
}

export interface GasCall {
  from: string;
  to: string;
  data: string;
  value?: bigint;
  /** Optional user-chosen priority tip in gwei. Overrides the network default. */
  priorityFeeGwei?: number;
}

export interface GasFields {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
}

/** Latest block baseFee, falling back to the feeHistory tail, floored at BASE_FEE_FLOOR. */
async function resolveBaseFee(evmRpc: string): Promise<bigint> {
  try {
    const blk = await rpc("eth_getBlockByNumber", ["latest", false], evmRpc);
    const bf = (blk.result as { baseFeePerGas?: string } | undefined)?.baseFeePerGas;
    if (typeof bf === "string") {
      const v = BigInt(bf);
      if (v > 0n) return v;
    }
  } catch { /* fall through */ }
  try {
    const fh = await rpc("eth_feeHistory", ["0x5", "latest", [50]], evmRpc);
    const arr = (fh.result as { baseFeePerGas?: string[] } | undefined)?.baseFeePerGas;
    if (Array.isArray(arr) && arr.length) {
      const v = BigInt(arr[arr.length - 1]);
      if (v > 0n) return v;
    }
  } catch { /* fall through */ }
  return BASE_FEE_FLOOR;
}

/** Network-default priority tip (congestion-aware; 0 when idle). */
async function resolveDefaultPriority(evmRpc: string): Promise<bigint> {
  try {
    const p = await rpc("eth_maxPriorityFeePerGas", [], evmRpc);
    if (typeof p.result === "string") return BigInt(p.result);
  } catch { /* keep 0 */ }
  return 0n;
}

function priorityFromGwei(gwei: number): bigint {
  return BigInt(Math.round(gwei * Number(GWEI)));
}

/**
 * Resolve EIP-1559 fee fields + gasLimit for a Rome CPI tx.
 * gasLimit = eth_estimateGas(realTx) × 1.3; ceiling (300M) only on estimate error.
 * maxPriorityFeePerGas = priorityFeeGwei (if given) else network default.
 * maxFeePerGas = baseFee×2 + maxPriorityFeePerGas (baseFee floored, never 0).
 */
export async function resolveGas(call: GasCall, evmRpc: string): Promise<GasFields> {
  const value = "0x" + (call.value ?? 0n).toString(16);

  const [baseFee, networkPriority] = await Promise.all([
    resolveBaseFee(evmRpc),
    resolveDefaultPriority(evmRpc),
  ]);

  const maxPriorityFeePerGas =
    call.priorityFeeGwei != null && call.priorityFeeGwei >= 0
      ? priorityFromGwei(call.priorityFeeGwei)
      : networkPriority;

  const base = baseFee > 0n ? baseFee : BASE_FEE_FLOOR;
  const maxFeePerGas = base * 2n + maxPriorityFeePerGas;

  let gasLimit = GAS_CEILING;
  try {
    const est = await rpc("eth_estimateGas", [{ from: call.from, to: call.to, data: call.data, value }], evmRpc);
    if (!est.error && typeof est.result === "string") {
      const scaled = padRomeGas(BigInt(est.result)); // ×1.3 via @rome-protocol/sdk
      gasLimit = scaled > GAS_CEILING ? GAS_CEILING : scaled;
    }
  } catch { /* keep ceiling fallback */ }

  return { maxFeePerGas, maxPriorityFeePerGas, gasLimit };
}

/** The congestion-aware default tip, in gwei, for surfacing in the UI. */
export async function networkPriorityFeeGwei(evmRpc: string): Promise<number> {
  const p = await resolveDefaultPriority(evmRpc);
  return Number(p) / Number(GWEI);
}
