"use client";

/**
 * Schedule tab — the resource schedule table, moved out of Overview
 * (owner 2026-07-13: big events carry dozens of lane/track lines and
 * drowned everything else on the Overview tab).
 */
import { fmtEventTime } from "~/features/daily-events/format";
import { safe } from "~/features/daily-events/print-html";
import type { ReservationDetail, Schedule } from "~/features/daily-events/types";
import DetailSection from "../DetailSection";
import { TH, TH_R, td } from "../ui";

export default function ScheduleTab({ detail }: { detail: ReservationDetail }) {
  const schedules: Schedule[] = Array.isArray(detail.schedules) ? detail.schedules : [];

  if (schedules.length === 0) {
    return (
      <div style={{ color: "var(--ba-muted)", fontSize: "0.875rem", padding: "1.5rem 0" }}>
        No schedule lines on this event.
      </div>
    );
  }

  return (
    <DetailSection id="schedules" title={`Schedules · ${schedules.length}`}>
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
            {schedules.map((s: Schedule, i: number) => (
              <tr key={safe(s.id) || i}>
                <td style={td(i, { whiteSpace: "nowrap" })}>{fmtEventTime(safe(s.start))}</td>
                <td style={td(i, { whiteSpace: "nowrap" })}>{fmtEventTime(safe(s.stop))}</td>
                <td style={td(i)}>{safe(s.resourceName)}</td>
                <td style={td(i, { color: "var(--ba-muted)" })}>{safe(s.productLines)}</td>
                <td style={td(i, { textAlign: "right" })}>{safe(s.persons)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DetailSection>
  );
}
