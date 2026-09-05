/**
 * MM/DD/YYYY ⇄ Date for the membership sheet's start/end fields. PURE. Local
 * time, start of day — a membership that starts "today" starts at midnight, and
 * one that ends "Sep 4, 2027" is still good on Sep 4 (end of that day).
 */

export function formatMdy(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/** Strict: two-digit month/day, four-digit year, real calendar date. */
export function parseMdy(s: string): Date | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(s || "");
  if (!m) return null;
  const mo = Number(m[1]);
  const day = Number(m[2]);
  const yr = Number(m[3]);
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  const d = new Date(yr, mo - 1, day);
  if (d.getFullYear() !== yr || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return d;
}

/** 23:59:59.999 local on that calendar day. */
export function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

/** "Sep 4, 2027" for the field's helper text. */
export function formatLong(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
