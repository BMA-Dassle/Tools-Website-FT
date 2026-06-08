/**
 * Move-aware pre-race SMS body builders. Extracted from the pre-race cron so
 * the move framing is unit-testable as pure string logic. Used only when a
 * racer is detected as moved to a different heat (same stable participantId,
 * different session).
 *
 * GSM-7 SAFE: ASCII only. No em-dash / arrows / middots, and the ET time is
 * assembled from parts with a plain space (newer ICU emits a narrow no-break
 * space before AM/PM). Any non-GSM-7 char forces the whole SMS to UCS-2
 * (70 chars/segment), which carriers reject as too-long (see tasks/lessons.md).
 */

import type { GroupTicketMember, ParticipantTicketRef } from "@/lib/race-tickets";

const ET_TZ = "America/New_York";

function formatTimeET(iso: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: ET_TZ,
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const dayPeriod = get("dayPeriod");
    return `${get("hour")}:${get("minute")}${dayPeriod ? ` ${dayPeriod}` : ""}`;
  } catch {
    return "";
  }
}

/** Full name preferred, first-name fallback. */
function racerName(m: { firstName: string; lastName: string }): string {
  return `${m.firstName} ${m.lastName}`.trim() || m.firstName || "Racer";
}

/** Compact heat label - works for a GroupTicketMember or a ParticipantTicketRef
 *  (both carry heatNumber/track/raceType/scheduledStart). */
export function heatLabelShort(h: {
  heatNumber: number;
  track: string;
  raceType: string;
  scheduledStart: string;
}): string {
  return `Heat ${h.heatNumber} ${h.track} ${h.raceType} ${formatTimeET(h.scheduledStart)}`;
}

/**
 * Single-racer MOVE body. Always names the racer, with Was/Now on their own
 * lines for scannability.
 */
export function buildSingleMoveSmsBody(
  member: GroupTicketMember,
  from: ParticipantTicketRef,
  shortUrl: string,
  cta: string,
): string {
  return [
    `FastTrax: race time change for ${racerName(member)}`,
    `Was ${heatLabelShort(from)}`,
    `Now ${heatLabelShort(member)}`,
    ``,
    shortUrl,
    cta,
  ].join("\n");
}

/**
 * Combined MOVE body for a phone bucket where at least one racer moved. Each
 * racer is named; movers show "was X, now Y", everyone else their heat. Same
 * one-SMS / one-/g page grouping as the normal grouped path.
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
    opts.guardian ? `FastTrax: race time change for your racers` : `FastTrax: race time change`,
  ];
  for (const e of sorted) {
    if (e.movedFrom) {
      lines.push(
        `- ${racerName(e.member)}: was ${heatLabelShort(e.movedFrom)}, now ${heatLabelShort(e.member)}`,
      );
    } else {
      lines.push(`- ${racerName(e.member)}: ${heatLabelShort(e.member)}`);
    }
  }
  lines.push(``);
  lines.push(shortUrl);
  lines.push(cta);
  return lines.join("\n");
}
