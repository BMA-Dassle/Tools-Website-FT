/**
 * Adaptive Card for a manager-initiated bowling time change on a VIP combo —
 * pure, no I/O. One card per explicit click (no dedup needed); posted to the
 * same movement chat so the receiving center knows the group's plan moved.
 */
import { fmtClock } from "~/features/reservations-admin/format";
import { BETA_DISCLAIMER } from "./config";

export interface TimeChangeParams {
  guestName: string;
  playerCount?: number;
  comboName: string;
  /** Offset-aware bowling slot ISOs (QAMF bookedAt shape). */
  oldIso: string;
  newIso: string;
  lane?: string;
  centerLabel: string;
}

export function timeChangeSummaryText(p: TimeChangeParams): string {
  return `${p.comboName}: ${p.guestName} bowling moved ${fmtClock(p.oldIso)} to ${fmtClock(p.newIso)} (BETA)`;
}

export function buildTimeChangeCard(p: TimeChangeParams): Record<string, unknown> {
  const party = p.playerCount ? `${p.guestName} · party of ${p.playerCount}` : p.guestName;
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "Container",
        style: "warning",
        bleed: true,
        items: [
          {
            type: "TextBlock",
            text: `${p.comboName.toUpperCase()} · BOWLING TIME CHANGED`,
            weight: "Bolder",
            size: "Small",
            spacing: "None",
            wrap: true,
          },
          {
            type: "TextBlock",
            text: `${party} — bowling moved to ${fmtClock(p.newIso)}`,
            weight: "Bolder",
            size: "Large",
            spacing: "Small",
            wrap: true,
          },
          {
            type: "TextBlock",
            text: "Changed by a manager in the reservations admin",
            isSubtle: true,
            size: "Small",
            spacing: "None",
            wrap: true,
          },
        ],
      },
      {
        type: "FactSet",
        spacing: "Medium",
        facts: [
          { title: "Old time", value: `${fmtClock(p.oldIso)}${p.lane ? ` · Lane ${p.lane}` : ""}` },
          { title: "New time", value: `${fmtClock(p.newIso)} (${p.centerLabel})` },
          { title: "Combo", value: p.comboName },
        ],
      },
      {
        type: "TextBlock",
        text: BETA_DISCLAIMER,
        isSubtle: true,
        size: "Small",
        spacing: "Medium",
        separator: true,
        wrap: true,
      },
    ],
  };
}
