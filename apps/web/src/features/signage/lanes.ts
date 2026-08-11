/**
 * Lane labels for the walls. PURE.
 *
 * A VIP party big enough to matter holds several lanes, and the data arrives
 * as whatever string the lane opener wrote — "1,2,3,4", "1-4", "11 & 12". The
 * wall must read the way a person says it: "Lanes 1–4" for a consecutive run,
 * "Lanes 11 & 14" otherwise, "Lane 11" for one (owner 2026-08-11).
 */
export function formatLanes(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // "1-4" written BY the opener already means a range — expand it before
  // extracting, or it reads back as the two lanes 1 and 4.
  const expanded = String(raw).replace(/(\d+)\s*[-–]\s*(\d+)/g, (_, a: string, b: string) => {
    const lo = Math.min(Number(a), Number(b));
    const hi = Math.max(Number(a), Number(b));
    if (hi - lo > 60) return `${a} ${b}`; // nonsense span — treat as two lanes
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).join(" ");
  });
  const nums = Array.from(expanded.matchAll(/\d+/g), (m) => Number(m[0]));
  if (nums.length === 0) {
    // Not numeric at all — show it verbatim rather than hiding it.
    const text = String(raw).trim();
    return text ? `Lane ${text}` : null;
  }
  const lanes = Array.from(new Set(nums)).sort((a, b) => a - b);
  if (lanes.length === 1) return `Lane ${lanes[0]}`;
  const consecutive = lanes.every((n, i) => i === 0 || n === lanes[i - 1] + 1);
  if (consecutive) return `Lanes ${lanes[0]}–${lanes[lanes.length - 1]}`;
  return `Lanes ${lanes.join(" & ")}`;
}

/**
 * Collapse a LIST of resource names into one line a person would say.
 *
 * The welcome board was showing "First up: Lane 5" for a party holding six lanes,
 * because it read only the first schedule line (owner 2026-08-11: the reservation
 * says Lanes 5–10). A group function books one schedule line PER LANE, so the
 * names arrive as ["Lane 5", "Lane 6", … "Lane 10"] and have to be folded back up.
 *
 * Groups by the text before the trailing number, so mixed bookings stay honest:
 *   ["Lane 5" … "Lane 10"]            → "Lanes 5–10"
 *   ["Lane 5","Lane 6","Lane 9"]      → "Lanes 5–6 & 9"
 *   ["Lane 5","HP Arena"]             → "Lane 5 · HP Arena"
 *   ["HP Arena"]                      → "HP Arena"
 *
 * Same shape as collapseSchedules in the daily-events ScheduleTab, which is where
 * staff already read "Lanes 5–10" — but pure and here, so the wall and the admin
 * detail page describe a booking the same way.
 */
export function formatResourceList(names: readonly (string | null | undefined)[]): string | null {
  const clean = names.map((n) => String(n ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return null;

  // Preserve first-seen order of the groups; a party's lanes should read before
  // its arena slot if that is how it was booked.
  const order: string[] = [];
  const groups = new Map<string, number[]>();
  const singles: string[] = [];

  for (const name of clean) {
    const m = /^(.*?)\s*(\d+)$/.exec(name);
    if (!m || !m[1]) {
      // No trailing number ("HP Arena"), or a bare number with no prefix.
      if (!singles.includes(name)) singles.push(name);
      continue;
    }
    const prefix = m[1];
    if (!groups.has(prefix)) {
      groups.set(prefix, []);
      order.push(prefix);
    }
    groups.get(prefix)!.push(Number(m[2]));
  }

  const parts: string[] = [];
  for (const prefix of order) {
    const nums = Array.from(new Set(groups.get(prefix) ?? [])).sort((a, b) => a - b);
    if (nums.length === 0) continue;
    if (nums.length === 1) {
      parts.push(`${prefix} ${nums[0]}`);
      continue;
    }
    parts.push(`${prefix}s ${joinRanges(nums)}`);
  }
  parts.push(...singles);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "5,6,7,9,10" → "5–7 & 9–10". Runs collapse; gaps are spoken as "&". */
function joinRanges(nums: readonly number[]): string {
  const runs: [number, number][] = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`)).join(" & ");
}
