"use client";

/**
 * Small presentational chips for the admin reservations board.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import type { Reservation } from "~/features/reservations-admin/types";
import {
  onsitePillCopy,
  type ReservationSyncState,
} from "~/features/reservations-admin/bmi-sync-view";

/**
 * "On-site" pill — has the LOCAL (Pandora) work for this reservation landed?
 * Owner 2026-08-12: "add a pill to each bmi reservation that is green when
 * on-site is done. will help watch for these problems."
 *
 * Under cloud-first the guest's booking finishes on the BMI cloud, and the
 * center's own server catches up seconds-to-minutes later (waiver record,
 * licence, grid seat). Green means every one of those landed.
 *
 * THREE states, not two — and the absent case is the important one. A
 * reservation with no queue rows might have needed nothing, or might have had
 * its followups never enqueued; those are indistinguishable here, so it renders
 * as "?" rather than green. Painting it green would make the pill claim more
 * than it knows, which is the exact failure mode of every status field we have
 * had to un-trust (lessons § "a status field IS a claim").
 */
export function OnsiteSyncChip({ sync }: { sync: ReservationSyncState | null | undefined }) {
  if (!sync) return null;
  const { label, tone, title } = onsitePillCopy(sync);
  const palette =
    tone === "green"
      ? { bg: "rgba(34,197,94,0.15)", fg: "#22c55e", border: "rgba(34,197,94,0.35)" }
      : tone === "amber"
        ? { bg: "rgba(240,179,65,0.15)", fg: "#f0b341", border: "rgba(240,179,65,0.35)" }
        : tone === "red"
          ? { bg: "rgba(239,68,68,0.15)", fg: "#f87171", border: "rgba(239,68,68,0.35)" }
          : { bg: "rgba(148,163,184,0.12)", fg: "#94a3b8", border: "rgba(148,163,184,0.28)" };
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-[2px] text-[11px] font-semibold"
      style={{ background: palette.bg, color: palette.fg, borderColor: palette.border }}
      title={title}
    >
      {label}
    </span>
  );
}

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
