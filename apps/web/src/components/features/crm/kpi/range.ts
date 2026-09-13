/**
 * The window picker's options — the prototype's `Sep · Oct · Q4` segment
 * (crm-shared.js:377), which only toasted. PURE, so the choice of months can
 * be asserted without rendering anything.
 *
 * Three months back to one forward plus the current quarter: the owner reviews
 * the month just gone and plans the one ahead, and a free-text month picker on
 * a phone is a worse way to do either. Everything is an ET calendar month —
 * the same `?month=`/`?quarter=` the API parses, so a chosen window is a
 * shareable URL.
 */

export interface RangeOption {
  /** The `Seg` value; the same string as `key` so a URL round-trips. */
  value: string;
  label: string;
  key: string;
  kind: "month" | "quarter";
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function etParts(now: Date): { year: number; month: number } {
  const [y, m] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number);
  return { year: y ?? 1970, month: m ?? 1 };
}

function shift(year: number, month: number, by: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + by;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function monthOption(year: number, month: number, showYear: boolean): RangeOption {
  const key = `${year}-${String(month).padStart(2, "0")}`;
  return {
    value: key,
    label: showYear ? `${MON[month - 1]} ${String(year).slice(2)}` : MON[month - 1],
    key,
    kind: "month",
  };
}

/** Three months back, this month, next month, then this quarter. */
export function rangeOptions(now: Date): RangeOption[] {
  const { year, month } = etParts(now);
  const months: RangeOption[] = [];
  for (let by = -3; by <= 1; by++) {
    const s = shift(year, month, by);
    months.push(monthOption(s.year, s.month, s.year !== year));
  }
  const quarter = Math.floor((month - 1) / 3) + 1;
  months.push({
    value: `${year}-Q${quarter}`,
    label: `Q${quarter}`,
    key: `${year}-Q${quarter}`,
    kind: "quarter",
  });
  return months;
}

/**
 * Which option the segment shows as pressed. The SERVER's resolved window key
 * wins, because a hand-typed `?month=1999-13` falls back to the current month
 * and the control must say what is actually on screen — not what the URL asked
 * for. Falls back to the URL, then to whatever the options call "now".
 */
export function windowKeyOf(
  resolved: string | null,
  month: string | null,
  quarter: string | null,
  options: readonly RangeOption[],
): string {
  for (const candidate of [resolved, quarter, month]) {
    if (candidate && options.some((o) => o.value === candidate)) return candidate;
  }
  return options[3]?.value ?? options[0]?.value ?? "";
}
