/**
 * Wed–Tue pay-period math, ported verbatim from the portal's
 * DailyEventsPage.tsx (getWeekPeriod / toDateStr / formatDisplayDate /
 * getDaysInPeriod). ET-aware: the period boundary is computed on the
 * America/New_York calendar date regardless of the viewer's timezone.
 */

export interface WeekPeriod {
  start: Date;
  end: Date;
}

/** Calculate Wed-Tue pay period for a given date (ET-aware). */
export function getWeekPeriod(date: Date): WeekPeriod {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value || "2026";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  const d = parts.find((p) => p.type === "day")?.value || "01";
  const etDateStr = `${y}-${m}-${d}`;
  const etDate = new Date(etDateStr + "T12:00:00Z");
  const day = etDate.getUTCDay();
  const daysSinceWed = (day + 4) % 7;
  const start = new Date(etDate);
  start.setUTCDate(start.getUTCDate() - daysSinceWed);
  start.setUTCHours(12, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(12, 0, 0, 0);
  return { start, end };
}

export function toDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function getDaysInPeriod(start: Date, end: Date): string[] {
  const days: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    days.push(toDateStr(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

export interface WeekTab {
  key: "last" | "current" | "next";
  label: string;
  period: WeekPeriod;
}

/** Last / Current / Next Wed–Tue periods around `now` (portal weekTabs). */
export function buildWeekTabs(now: Date): WeekTab[] {
  const currentPeriod = getWeekPeriod(now);
  const lastAnchor = new Date(currentPeriod.start);
  lastAnchor.setUTCDate(lastAnchor.getUTCDate() - 1);
  const nextAnchor = new Date(currentPeriod.end);
  nextAnchor.setUTCDate(nextAnchor.getUTCDate() + 1);
  return [
    { key: "last", label: "Last Week", period: getWeekPeriod(lastAnchor) },
    { key: "current", label: "Current Week", period: currentPeriod },
    { key: "next", label: "Next Week", period: getWeekPeriod(nextAnchor) },
  ];
}
