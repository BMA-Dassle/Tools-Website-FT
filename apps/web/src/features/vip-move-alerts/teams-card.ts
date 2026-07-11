/**
 * Adaptive Card builders for VIP movement alerts — pure, no I/O.
 *
 * One card per direction per cron tick, listing every party on the move:
 * what they just finished, what's next (time + lane), and the gap until the
 * next activity so the manager knows how much slack there is. v1.4 schema —
 * sendAdaptiveCardToChannel is card-only. No emoji (staff-facing).
 */
import { etWallMs, fmtClock, fmtDurShort } from "~/features/reservations-admin/format";
import type { ComboScheduleStep } from "~/features/reservations-admin/types";
import { BETA_DISCLAIMER } from "./config";
import type { MoveDirection, PendingMove } from "./detect";

/** "Starter Race · Blue — 8:00 PM · Lane 5" (parts present as available). */
function stepDesc(step: ComboScheduleStep): string {
  const parts = [step.label];
  if (step.iso) parts.push(fmtClock(step.iso));
  if (step.lane) parts.push(`Lane ${step.lane}`);
  return parts.join(" — ");
}

function nextUpDesc(to: ComboScheduleStep): string {
  if (!to.iso) return `${to.label} — time TBD (book if qualified)`;
  return stepDesc(to);
}

/** The manager's slack: gap from now to the next step's start. Both sides in
 *  the ET-wall frame (etWallMs) — race heats are naive ET, bowling slots are
 *  offset-aware, and nowMs comes from nowEtWallMs. Truth first: once the
 *  next step is actually underway the countdown is over. */
function timeToMove(to: ComboScheduleStep, nowMs: number): string {
  if (to.raceState === "on_track" || to.raceState === "finished") return "Next activity underway";
  if (to.legStatus === "arrived" || to.legStatus === "completed") return "Next activity underway";
  if (!to.iso) return "Next activity time not set";
  const startMs = etWallMs(to.iso);
  if (Number.isNaN(startMs)) return "Next activity time not set";
  const mins = (startMs - nowMs) / 60_000;
  if (mins <= 0) return "Next activity is due now — head over";
  return `Next activity starts in ${fmtDurShort(mins)}`;
}

function partyLabel(m: PendingMove): string {
  return m.playerCount ? `${m.guestName} · party of ${m.playerCount}` : m.guestName;
}

/** Header eyebrow from the combo registry name so a future combo shows its
 *  own branding: "ULTIMATE VIP EXPERIENCE · GUESTS ON THE MOVE". */
function eyebrow(moves: PendingMove[]): string {
  const names = [...new Set(moves.map((m) => m.comboName))];
  const name = names.length === 1 ? names[0] : "VIP";
  return `${name.toUpperCase()} · GUESTS ON THE MOVE`;
}

function headline(direction: MoveDirection): string {
  return direction === "karting_to_bowling"
    ? "Walk guests to HeadPinz Bowling"
    : "Walk guests back to FastTrax Karting";
}

function subtitle(direction: MoveDirection, moves: PendingMove[]): string {
  const partyWord = (n: number) => (n === 1 ? "1 party" : `${n} parties`);
  if (direction === "karting_to_bowling") {
    return `${partyWord(moves.length)} just finished racing at FastTrax`;
  }
  const soon = moves.filter((m) => m.endingSoon).length;
  const done = moves.length - soon;
  if (!soon) return `${partyWord(moves.length)} just finished bowling`;
  return `${partyWord(done)} finished bowling · ${soon} finishing within 5 min`;
}

export function moveSummaryText(direction: MoveDirection, moves: PendingMove[]): string {
  const names = [...new Set(moves.map((m) => m.comboName))];
  const name = names.length === 1 ? names[0] : "VIP";
  const dest = direction === "karting_to_bowling" ? "HeadPinz Bowling" : "FastTrax Karting";
  return `${name}: ${moves.length === 1 ? "1 party" : `${moves.length} parties`} moving to ${dest} (BETA)`;
}

export function buildMoveCard(
  direction: MoveDirection,
  moves: PendingMove[],
  nowMs: number,
  opts?: { boardUrl?: string | null },
): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: "Container",
      style: "accent",
      bleed: true,
      items: [
        {
          type: "TextBlock",
          text: eyebrow(moves),
          weight: "Bolder",
          size: "Small",
          spacing: "None",
          wrap: true,
        },
        {
          type: "TextBlock",
          text: headline(direction),
          weight: "Bolder",
          size: "Large",
          spacing: "Small",
          wrap: true,
        },
        {
          type: "TextBlock",
          text: subtitle(direction, moves),
          isSubtle: true,
          size: "Small",
          spacing: "None",
          wrap: true,
        },
      ],
    },
  ];

  for (const m of moves) {
    body.push(
      {
        type: "TextBlock",
        text: partyLabel(m),
        weight: "Bolder",
        spacing: "Medium",
        separator: true,
        wrap: true,
      },
      {
        type: "FactSet",
        spacing: "Small",
        facts: [
          {
            title: m.endingSoon ? `Ends in ~${m.endingSoon.minsLeft}m` : "Just finished",
            value: stepDesc(m.from),
          },
          { title: "Next up", value: nextUpDesc(m.to) },
          { title: "Time to move", value: timeToMove(m.to, nowMs) },
        ],
      },
    );
  }

  body.push(
    {
      type: "TextBlock",
      text: "This alert does not replace manager-to-manager communication. Please reply to this message when you are actually walking the guests over.",
      size: "Small",
      spacing: "Medium",
      separator: true,
      wrap: true,
    },
    {
      type: "TextBlock",
      text: BETA_DISCLAIMER,
      isSubtle: true,
      size: "Small",
      spacing: "Small",
      wrap: true,
    },
  );

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    actions: opts?.boardUrl
      ? [{ type: "Action.OpenUrl", title: "Open VIP board", url: opts.boardUrl }]
      : [],
  };
}
