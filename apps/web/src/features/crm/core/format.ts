/**
 * Pure formatters shared by every CRM screen (ported from `crm-shared.js`
 * `money`, `moneyK`, `pct`, `dur`). Cents in, strings out; no Date math here
 * (that is `./dates.ts`).
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `$1,250` — whole dollars, the board's default. */
export function money(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return USD.format(Math.round(cents / 100));
}

/** `$1,250.50` — where cents matter (payments, balances). */
export function moneyExact(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return USD_CENTS.format(cents / 100);
}

/** `$1.3k` above a thousand, else `money`. Card corners and column sums. */
export function moneyK(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) return `$${(dollars / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return USD.format(Math.round(dollars));
}

/** Integer percent, clamped to 0–100; 0 when the denominator is 0. */
export function pct(numerator: number, denominator: number): number {
  if (!denominator || !Number.isFinite(numerator / denominator)) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

/** `45 min`, `2 h 05 min`, `3 d` — the age/duration chip. */
export function durationLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 60 * 24) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${String(rest).padStart(2, "0")} min` : `${h} h`;
  }
  return `${Math.floor(m / (60 * 24))} d`;
}

/** `Kelsea Kosco` → `KK`; `Guest Services` → `GS`; a single word → its first two letters. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `60 guests` */
export function guestsLabel(n: number): string {
  return plural(n, "guest");
}
