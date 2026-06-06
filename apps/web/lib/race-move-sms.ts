/**
 * Move-aware pre-race SMS body builders. Extracted from the pre-race cron so
 * the move framing ("{Name}: moved — was X, now Y") is unit-testable as pure
 * string logic. Used only when a racer is detected as moved to a different
 * heat (same stable participantId, different session).
 */

import type { GroupTicketMember, ParticipantTicketRef } from "@/lib/race-tickets";

const ET_TZ = "America/New_York";

function formatTimeET(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: ET_TZ,
    });
  } catch {
    return "";
  }
}

function racerLabel(m: { firstName: string; lastName: string }): string {
  return `${m.firstName} ${m.lastName}`.trim() || m.firstName || "Racer";
}

/** Compact heat label — works for a GroupTicketMember or a ParticipantTicketRef
 *  (both carry heatNumber/track/raceType/scheduledStart). */
export function heatLabelShort(h: {
  heatNumber: number;
  track: string;
  raceType: string;
  scheduledStart: string;
}): string {
  return `Heat ${h.heatNumber} ${h.track} ${h.raceType} ${formatTimeET(h.scheduledStart)}`;
}

/** "{Name}: moved — was {old heat}, now {new heat}" line for grouped bodies. */
export function moveLine(member: GroupTicketMember, from: ParticipantTicketRef): string {
  return `${racerLabel(member)}: moved — was ${heatLabelShort(from)}, now ${heatLabelShort(member)}`;
}

/**
 * Single-racer MOVE body. Names the racer (guardian flavor) or uses "Your"
 * (racer flavor), and spells out the change from→to. GSM-7, kept short.
 */
export function buildSingleMoveSmsBody(
  member: GroupTicketMember,
  from: ParticipantTicketRef,
  shortUrl: string,
  cta: string,
  opts: { guardian?: boolean } = {},
): string {
  const who = opts.guardian ? `${member.firstName}'s` : "Your";
  return [
    `FastTrax — ${who} race moved.`,
    `Was ${heatLabelShort(from)}, now ${heatLabelShort(member)}.`,
    ``,
    shortUrl,
    cta,
  ].join("\n");
}

/**
 * Combined MOVE body for a phone bucket where at least one racer moved. Moved
 * racers get a "moved — was X, now Y" line; everyone else their normal line,
 * under a header that flags a change occurred. Same one-SMS / one-/g page
 * grouping as the normal grouped path.
 */
export function buildGroupMoveSmsBody(
  entries: { member: GroupTicketMember; movedFrom?: ParticipantTicketRef | null }[],
  shortUrl: string,
  cta: string,
  opts: { guardian?: boolean } = {},
): string {
  const sorted = [...entries].sort(
    (a, b) =>
      new Date(a.member.scheduledStart).getTime() - new Date(b.member.scheduledStart).getTime(),
  );
  const lines: string[] = [
    opts.guardian
      ? `FastTrax e-tickets for your racers (a race time changed):`
      : `FastTrax e-tickets (a race time changed):`,
  ];
  for (const e of sorted) {
    if (e.movedFrom) lines.push(`- ${moveLine(e.member, e.movedFrom)}`);
    else lines.push(`- ${racerLabel(e.member)}: ${heatLabelShort(e.member)}`);
  }
  lines.push(``);
  lines.push(shortUrl);
  lines.push(cta);
  return lines.join("\n");
}
