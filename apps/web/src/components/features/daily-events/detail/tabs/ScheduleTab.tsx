"use client";

/**
 * Schedule tab — the resource schedule table, moved out of Overview
 * (owner 2026-07-13: big events carry dozens of lane/track lines and
 * drowned everything else on the Overview tab).
 *
 * Identical lines across numbered resources collapse into range rows —
 * twenty "Lane N, 10:00 AM–1:00 PM" lines render as one "Lanes 5–24"
 * (owner request, same day). Grouping key = start + stop + products +
 * resource prefix; persons are summed across the group.
 */
import { fmtEventTime } from "~/features/daily-events/format";
import { safe } from "~/features/daily-events/print-html";
import type { ReservationDetail, Schedule } from "~/features/daily-events/types";
import DetailSection from "../DetailSection";
import { TH, TH_R, td } from "../ui";

interface DisplayRow {
  key: string;
  start: string;
  stop: string;
  resource: string;
  productLines: string;
  persons: number;
}

/** "5,6,7,9,10" → "5–7, 9–10" (already-sorted unique numbers). */
function formatRanges(nums: number[]): string {
  const parts: string[] = [];
  let runStart = nums[0];
  let prev = nums[0];
  for (let i = 1; i <= nums.length; i++) {
    const n = nums[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(runStart === prev ? String(runStart) : `${runStart}–${prev}`);
    runStart = prev = n;
  }
  return parts.join(", ");
}

export function collapseSchedules(schedules: Schedule[]): DisplayRow[] {
  interface Group extends DisplayRow {
    prefix: string;
    nums: number[];
    single: boolean;
  }
  const order: Group[] = [];
  const byKey = new Map<string, Group>();

  schedules.forEach((s, i) => {
    const name = safe(s.resourceName);
    const m = name.match(/^(.*?)\s*(\d+)$/);
    const persons = Number(s.persons) || 0;
    const base: Omit<Group, "prefix" | "nums" | "single"> = {
      key: safe(s.id) || String(i),
      start: safe(s.start),
      stop: safe(s.stop),
      resource: name,
      productLines: safe(s.productLines),
      persons,
    };
    if (!m) {
      order.push({ ...base, prefix: "", nums: [], single: true });
      return;
    }
    const groupKey = `${base.start}|${base.stop}|${base.productLines}|${m[1]}`;
    const existing = byKey.get(groupKey);
    if (existing) {
      existing.nums.push(Number(m[2]));
      existing.persons += persons;
    } else {
      const g: Group = { ...base, prefix: m[1], nums: [Number(m[2])], single: false };
      byKey.set(groupKey, g);
      order.push(g);
    }
  });

  return order.map((g) => {
    if (g.single || g.nums.length <= 1) return g;
    const nums = [...new Set(g.nums)].sort((a, b) => a - b);
    return { ...g, resource: `${g.prefix}s ${formatRanges(nums)}` };
  });
}

export default function ScheduleTab({ detail }: { detail: ReservationDetail }) {
  const schedules: Schedule[] = Array.isArray(detail.schedules) ? detail.schedules : [];

  if (schedules.length === 0) {
    return (
      <div style={{ color: "var(--ba-muted)", fontSize: "0.875rem", padding: "1.5rem 0" }}>
        No schedule lines on this event.
      </div>
    );
  }

  const rows = collapseSchedules(schedules);

  return (
    <DetailSection
      id="schedules"
      title={
        rows.length === schedules.length
          ? `Schedules · ${schedules.length}`
          : `Schedules · ${schedules.length} lines`
      }
    >
      <div style={{ overflowX: "auto", margin: "0 -16px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={TH}>Start</th>
              <th style={TH}>Stop</th>
              <th style={TH}>Resource</th>
              <th style={TH}>Products</th>
              <th style={TH_R}>Persons</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <td style={td(i, { whiteSpace: "nowrap" })}>{fmtEventTime(r.start)}</td>
                <td style={td(i, { whiteSpace: "nowrap" })}>{fmtEventTime(r.stop)}</td>
                <td style={td(i)}>{r.resource}</td>
                <td style={td(i, { color: "var(--ba-muted)" })}>{r.productLines}</td>
                <td style={td(i, { textAlign: "right" })}>{r.persons || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DetailSection>
  );
}
