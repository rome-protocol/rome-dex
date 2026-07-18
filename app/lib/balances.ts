"use client";

// Client-side SPL balance read via the Solana RPC (same path SwapPanel uses).

import { PublicKey } from "@solana/web3.js";

/** Token balance (raw smallest unit) of an associated-token account. 0 if missing. */
export async function ataBalance(solanaRpc: string, ata: PublicKey): Promise<bigint> {
  try {
    const res = await fetch(solanaRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountBalance",
        params: [ata.toBase58()],
      }),
    });
    const d = await res.json();
    const amount = d?.result?.value?.amount;
    return amount ? BigInt(amount) : 0n;
  } catch {
    return 0n;
  }
}
