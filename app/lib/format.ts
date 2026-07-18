// Shared display formatters. Amounts are raw smallest-unit BigInt strings.

/** Raw smallest-unit → trimmed human string, `sigfigs` fractional digits max. */
export function fmtRaw(raw: string | bigint | undefined | null, dec: number, sigfigs = 4): string {
  if (raw == null || raw === "") return "—";
  try {
    const n = typeof raw === "bigint" ? raw : BigInt(raw);
    const base = 10n ** BigInt(dec);
    const whole = n / base;
    const frac = (n % base).toString().padStart(dec, "0").slice(0, sigfigs).replace(/0+$/, "");
    return frac ? `${grp(whole)}.${frac}` : grp(whole);
  } catch {
    return "—";
  }
}

/** Raw smallest-unit → Number of whole tokens. */
export function rawToNum(raw: string | bigint | undefined | null, dec: number): number {
  if (raw == null || raw === "") return 0;
  try {
    const n = typeof raw === "bigint" ? raw : BigInt(raw);
    return Number(n) / 10 ** dec;
  } catch {
    return 0;
  }
}

/** Thousands-grouped integer bigint. */
function grp(v: bigint): string {
  return v.toLocaleString("en-US");
}

/** Compact USD, e.g. $2.41M, $812K, $3,910, $0.00. */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(v / 1_000).toFixed(0)}K`;
  if (abs >= 1_000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (abs > 0 && abs < 0.01) return "<$0.01";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact count, e.g. 1.20M, 16,004. */
export function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString("en-US", { maximumFractionDigits: abs < 10 ? 3 : 0 });
}

export function fmtPct(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}
