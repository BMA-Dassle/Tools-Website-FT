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
