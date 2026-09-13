/**
 * `dblock(dateStr, lg)` from crm-shared.js:207 — the month / day / weekday
 * block beside a row. Pure: the caller passes `daysOut` (days from today in
 * ET) when it wants the "soon" tint and the tooltip; the component never asks
 * for the clock.
 */
export const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface DateParts {
  month: string;
  day: number;
  weekday: string;
}

/** "2026-10-17" → { month: "Oct", day: 17, weekday: "Sat" }; a bad string → null. */
export function dateParts(ymd: string): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Calendar arithmetic only (local Date from parts, never an instant).
  const local = new Date(y, mo - 1, d);
  return { month: MON[mo - 1] ?? "", day: d, weekday: DOW[local.getDay()] ?? "" };
}

export interface DateBlockProps {
  /** YYYY-MM-DD */
  date: string;
  lg?: boolean;
  /** Days from today; 0–14 marks the block "soon". */
  daysOut?: number;
  className?: string;
}

export function DateBlock({ date, lg = false, daysOut, className }: DateBlockProps) {
  const parts = dateParts(date);
  const soon = daysOut !== undefined && daysOut >= 0 && daysOut <= 14;
  const cls = ["dblock", lg ? "lg" : "", soon ? "soon" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const title = daysOut === undefined ? undefined : `${daysOut} days out`;
  return (
    <div className={cls} title={title}>
      <span className="m">{parts?.month ?? "—"}</span>
      <span className="d">{parts?.day ?? "?"}</span>
      <span className="w">{parts?.weekday ?? ""}</span>
    </div>
  );
}
