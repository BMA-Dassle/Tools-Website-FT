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
  /** THIS ET month — what the picker falls back to. */
  current?: true;
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

function monthOption(year: number, month: number, showYear: boolean, current = false): RangeOption {
  const key = `${year}-${String(month).padStart(2, "0")}`;
  return {
    value: key,
    label: showYear ? `${MON[month - 1]} ${String(year).slice(2)}` : MON[month - 1],
    key,
    kind: "month",
    ...(current ? { current: true as const } : {}),
  };
}

/**
 * Two months back, this month, THREE forward, then this quarter and the next.
 *
 * It was three back and ONE forward, which is the shape of a window for a
 * business that sells today for today. Group events are not that: a September
 * board is mostly November and December, and the owner could not reach either
 * — "I should be able to select dates in q4 like nov and dec" (2026-09-14).
 *
 * So the window leans FORWARD, which is where the money being worked actually
 * sits, and the next quarter joins this one so "how is Q4 shaping up" is one
 * press rather than three months compared by hand. One month of hindsight is
 * given up for it; the month just gone is still there, and anything older is a
 * `?month=` URL away.
 */
export function rangeOptions(now: Date): RangeOption[] {
  const { year, month } = etParts(now);
  const months: RangeOption[] = [];
  for (let by = -2; by <= 3; by++) {
    const s = shift(year, month, by);
    months.push(monthOption(s.year, s.month, s.year !== year, by === 0));
  }
  const quarter = Math.floor((month - 1) / 3) + 1;
  for (const [qy, q] of quarterPair(year, quarter)) {
    months.push({
      value: `${qy}-Q${q}`,
      label: `Q${q}`,
      key: `${qy}-Q${q}`,
      kind: "quarter",
    });
  }
  return months;
}

/** This quarter and the next, rolling into next year after Q4. */
function quarterPair(year: number, quarter: number): Array<[number, number]> {
  const next = quarter === 4 ? ([year + 1, 1] as [number, number]) : [year, quarter + 1];
  return [[year, quarter], next as [number, number]];
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
  // The CURRENT month, found by its flag rather than by position. This was
  // `options[3]`, which silently became the wrong month the moment the window
  // was widened for Q4 — an index into a list somebody else may re-shape is a
  // bug waiting for its edit.
  const current = options.find((o) => o.current);
  return current?.value ?? options[0]?.value ?? "";
}
