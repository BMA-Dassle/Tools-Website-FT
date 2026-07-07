"use client";

/**
 * Small presentational chips for the admin reservations board.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import type { Reservation } from "~/features/reservations-admin/types";

/**
 * Compact chip rendering the guest-survey funnel state. Three flavors:
 *   - "sent"      gray  — delivered but customer hasn't opened yet
 *   - "opened"    blue  — clicked the link, hasn't submitted
 *   - "completed" green — submitted + tells you which reward they picked
 *
 * Hidden when survey is null (no survey sent for this reservation).
 */
export function SurveyChip({ survey }: { survey: Reservation["survey"] }) {
  if (!survey) return null;
  const palette =
    survey.status === "completed"
      ? { bg: "rgba(34,197,94,0.15)", fg: "#22c55e", border: "rgba(34,197,94,0.35)" }
      : survey.status === "opened"
        ? { bg: "rgba(59,130,246,0.15)", fg: "#3b82f6", border: "rgba(59,130,246,0.35)" }
        : { bg: "rgba(148,163,184,0.15)", fg: "#94a3b8", border: "rgba(148,163,184,0.35)" };
  const label =
    survey.status === "completed"
      ? survey.rewardKind === "pinz"
        ? `Survey: 500 Pinz`
        : survey.rewardKind === "gift_card"
          ? `Survey: $5 GC`
          : survey.rewardKind === "declined"
            ? `Survey: done`
            : `Survey: done`
      : survey.status === "opened"
        ? `Survey: opened`
        : `Survey: sent`;
  const tooltipBits: string[] = [`sent ${new Date(survey.sentAt).toLocaleString()}`];
  if (survey.openedAt) tooltipBits.push(`opened ${new Date(survey.openedAt).toLocaleString()}`);
  if (survey.completedAt)
    tooltipBits.push(`completed ${new Date(survey.completedAt).toLocaleString()}`);
  if (survey.channel) tooltipBits.push(`via ${survey.channel}`);
  return (
    <span
      title={tooltipBits.join(" · ")}
      style={{
        display: "inline-block",
        padding: "1px 5px",
        borderRadius: 4,
        fontSize: "0.6rem",
        fontWeight: 600,
        backgroundColor: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}
