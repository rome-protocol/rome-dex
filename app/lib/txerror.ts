// txerror.ts — turn raw wallet/RPC errors into safe, human status.
// Two jobs: (1) detect a user-cancelled wallet prompt so we show a calm
// "cancelled" rather than a scary error; (2) extract a short reason from the
// giant ethers/RPC/mollusk error blobs so the UI never renders a wall of JSON.

export interface TxStatusInfo {
  cancelled: boolean;
  message: string;
}

// EVM wallet (EIP-1193) user-rejection: code 4001; ethers v6: "ACTION_REJECTED".
// Solana wallets: throw with "User rejected"/"rejected the request".
function isUserCancel(e: unknown): boolean {
  const any = e as { code?: unknown; message?: unknown } | null;
  const code = any?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return true;
  const msg = String(any?.message ?? e ?? "");
  return /user rejected|user denied|rejected the request|request rejected|user cancel/i.test(msg);
}

// Pull a human reason out of the noisy blob. Prefers an on-chain revert reason,
// then a mollusk failure code, then a JSON-RPC message, else a short generic.
function extractReason(e: unknown): string {
  const raw = typeof e === "string" ? e : (e as { message?: string })?.message ?? String(e);

  // A precompile the EVM lane called doesn't implement the method — a lane
  // capability gap, not a user mistake. Recommend the lane that can do it.
  if (/unimplemented[\s\S]*method is not supported by \w*Program/i.test(raw)) {
    return "This action isn't available on the EVM lane yet — nothing on-chain moved. Try it from the Solana lane.";
  }

  // On-chain program failure surfaced by the proxy, e.g.
  // "mollusk error: Failure(InvalidAccountData) [program Fv2…]" or Failure(Custom(1)).
  const mollusk = raw.match(/Failure\((?:Custom\((\d+)\)|([A-Za-z0-9]+))\)/);
  if (mollusk) return `On-chain check failed: ${humanizeMollusk(mollusk[1] != null ? `Custom${mollusk[1]}` : mollusk[2])}`;

  const reverted = raw.match(/execution reverted:?\s*([^"'{}\n]+?)(?:["'{]|$)/i);
  if (reverted && reverted[1].trim() && !/SimulateTransactionError/i.test(reverted[1])) {
    return `Reverted: ${reverted[1].trim().slice(0, 140)}`;
  }

  // Nested JSON-RPC message
  const rpcMsg = raw.match(/"message"\s*:\s*"([^"]+)"/);
  if (rpcMsg) return trimReason(rpcMsg[1]);

  const short = (e as { shortMessage?: string })?.shortMessage;
  if (short) return trimReason(short);

  return trimReason(raw);
}

function humanizeMollusk(code: string): string {
  const map: Record<string, string> = {
    InvalidAccountData: "an account isn't set up yet — try again",
    ExceededSlippage: "price moved past your slippage limit",
    Custom1: "not enough token balance (or the price moved out of range)",
    Custom4: "insufficient balance or allowance",
  };
  return map[code] ?? code;
}

function trimReason(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 160 ? one.slice(0, 157) + "…" : one;
}

/** The one helper components call in a catch: safe, short, cancel-aware. */
export function toTxStatus(e: unknown): TxStatusInfo {
  if (isUserCancel(e)) return { cancelled: true, message: "Transaction cancelled — no changes made." };
  // Always log the raw error so the true cause is in the console even when we
  // can only surface a short, generic message to the UI.
  if (typeof console !== "undefined") console.error("[rome-dex] tx error:", e);
  // GUIDE: a deliberate pre-flight stop with a recommended action — nothing was
  // submitted. Surface the guidance verbatim, never as a scary revert.
  const rawMsg = typeof e === "string" ? e : ((e as { message?: string })?.message ?? "");
  const guide = rawMsg.match(/GUIDE:\s*([\s\S]+)/);
  if (guide) return { cancelled: false, message: guide[1].replace(/\s+/g, " ").trim() };
  const reason = extractReason(e);
  if (reason && reason.trim()) return { cancelled: false, message: reason };
  // Never render an empty box (standing rule). Some wallet/RPC errors carry an
  // empty message; fall back to the error's name/type + a console pointer.
  const name = (e as { name?: string } | null)?.name;
  return {
    cancelled: false,
    message: `Something went wrong${name && name !== "Error" ? ` (${name})` : ""} — see the browser console for details.`,
  };
}
