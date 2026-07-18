"use client";

// clmmPositions.ts — the device-local index of CLMM position BANDS, shared by
// the /clmm panel and the /positions page.
//
// Design (born from a live loss-of-visibility report): the chain is the truth,
// this store is only an INDEX of "bands worth checking" — every render verifies
// each band on-chain (readPosition) before showing anything, so stale entries
// self-hide and entries are safe to keep liberally. Rules that make positions
// hard to lose:
//   • keyed by owner AND pool (the old owner-only key mixed pools);
//   • recorded BEFORE submit — a landed-but-UI-errored tx stays indexed;
//   • legacy owner-only entries are merged in (chain-verified like the rest);
//   • removed only on a confirmed close, or explicitly by the user.

export type Band = { lower: number; upper: number };

const KEY = (owner: string, pool: string) => `clmm-positions:${owner}:${pool}`;
const LEGACY_KEY = (owner: string) => `clmm-positions:${owner}`;

function read(key: string): Band[] {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(arr) ? arr.filter((b) => Number.isInteger(b?.lower) && Number.isInteger(b?.upper)) : [];
  } catch {
    return [];
  }
}

/** Bands worth checking for (owner, pool) — pool-keyed entries ∪ legacy
 *  owner-only entries (pre-multipool). Every band is chain-verified by the
 *  caller before display, so the legacy merge can't show a wrong position. */
export function trackedBands(owner: string, pool: string): Band[] {
  const merged = [...read(KEY(owner, pool)), ...read(LEGACY_KEY(owner))];
  const seen = new Set<string>();
  return merged.filter((b) => {
    const k = `${b.lower}:${b.upper}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function saveBand(owner: string, pool: string, b: Band): void {
  try {
    const cur = read(KEY(owner, pool));
    if (!cur.some((x) => x.lower === b.lower && x.upper === b.upper)) {
      localStorage.setItem(KEY(owner, pool), JSON.stringify([...cur, b]));
    }
  } catch { /* storage unavailable — chain state is unaffected */ }
}

export function removeBand(owner: string, pool: string, b: Band): void {
  try {
    localStorage.setItem(KEY(owner, pool), JSON.stringify(read(KEY(owner, pool)).filter((x) => !(x.lower === b.lower && x.upper === b.upper))));
    // Drop it from the legacy index too, or the merge resurrects it.
    localStorage.setItem(LEGACY_KEY(owner), JSON.stringify(read(LEGACY_KEY(owner)).filter((x) => !(x.lower === b.lower && x.upper === b.upper))));
  } catch { /* ignore */ }
}
