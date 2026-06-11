/**
 * HP Arena e-ticket SMS body builders — HeadPinz-branded siblings of the
 * racing bodies in the pre-race cron + lib/race-move-sms.ts. Pure string
 * logic so the GSM-7 / length constraints are unit-testable.
 *
 * GSM-7 SAFE: ASCII only, and bodies must stay under 2 segments
 * (306 chars concatenated). Carriers reject long messages with
 * "code 4505" — the full session info lives on the ticket page, the
 * SMS only carries who/what/when + the link (see tasks/lessons.md).
 *
 * The ET time is assembled from parts with a plain space — newer ICU
 * emits a narrow no-break space before AM/PM, which would silently
 * force the whole SMS to UCS-2.
 */

import type { GroupTicketMember, ParticipantTicketRef } from "@/lib/race-tickets";

const ET_TZ = "America/New_York";

// Terse on purpose — every char here is paid on EVERY body, and the
// worst-case group-move body (two long names, two session labels each)
// must stay inside 2 GSM-7 segments (306 chars). The "gear up" detail
// lives on the ticket page.
export const ARENA_SHORT_CTA = "Arrive 15 min early";

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

function playerName(m: { firstName: string; lastName: string }): string {
  return `${m.firstName} ${m.lastName}`.trim() || m.firstName || "Player";
}

/** Compact session label — "Laser Tag Session 7 at 4:30 PM". `track`
 *  carries the activity display name on arena members. */
export function sessionLabelShort(s: {
  track: string;
  heatNumber: number;
  scheduledStart: string;
}): string {
  return `${s.track} Session ${s.heatNumber} at ${formatTimeET(s.scheduledStart)}`;
}

export function buildArenaSingleSmsBody(member: GroupTicketMember, shortUrl: string): string {
  return [
    `HeadPinz HP Arena e-ticket`,
    sessionLabelShort(member),
    playerName(member),
    ``,
    shortUrl,
    ARENA_SHORT_CTA,
  ].join("\n");
}

export function buildArenaGroupSmsBody(members: GroupTicketMember[], shortUrl: string): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const bySession = new Map<string, GroupTicketMember[]>();
  for (const m of sorted) {
    const k = String(m.sessionId);
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(m);
  }
  const lines: string[] = [`HeadPinz HP Arena e-tickets`];
  const blocks: string[][] = [];
  for (const group of bySession.values()) {
    const block = [sessionLabelShort(group[0])];
    for (const m of group) block.push(`- ${playerName(m)}`);
    blocks.push(block);
  }
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) lines.push(``);
    lines.push(...blocks[i]);
  }
  lines.push(``);
  lines.push(shortUrl);
  lines.push(ARENA_SHORT_CTA);
  return lines.join("\n");
}

/** Guardian-flavored single-player body — minor without their own
 *  contact, SMS routed to a parent. */
export function buildArenaGuardianSingleSmsBody(
  member: GroupTicketMember,
  shortUrl: string,
): string {
  return [
    "HP Arena e-ticket for your player",
    "",
    `- ${member.firstName} - ${sessionLabelShort(member)}`,
    "",
    shortUrl,
    ARENA_SHORT_CTA,
  ].join("\n");
}

/** Guardian-flavored multi-player body — 2+ kids on one parent phone. */
export function buildArenaGuardianGroupSmsBody(
  members: GroupTicketMember[],
  shortUrl: string,
): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const lines = ["HP Arena e-tickets for your players", ""];
  for (const m of sorted) {
    lines.push(`- ${m.firstName} - ${sessionLabelShort(m)}`);
  }
  lines.push("");
  lines.push(shortUrl);
  lines.push(ARENA_SHORT_CTA);
  return lines.join("\n");
}

/** Single-player MOVE body — same Was/Now framing as racing moves. */
export function buildArenaSingleMoveSmsBody(
  member: GroupTicketMember,
  from: ParticipantTicketRef,
  shortUrl: string,
): string {
  return [
    `HeadPinz: session time change for ${playerName(member)}`,
    `Was ${sessionLabelShort(from)}`,
    `Now ${sessionLabelShort(member)}`,
    ``,
    shortUrl,
    ARENA_SHORT_CTA,
  ].join("\n");
}

/** Combined MOVE body for a phone bucket where at least one player moved. */
export function buildArenaGroupMoveSmsBody(
  entries: { member: GroupTicketMember; movedFrom?: ParticipantTicketRef | null }[],
  shortUrl: string,
  opts: { guardian?: boolean } = {},
): string {
  const sorted = [...entries].sort(
    (a, b) =>
      new Date(a.member.scheduledStart).getTime() - new Date(b.member.scheduledStart).getTime(),
  );
  const lines: string[] = [
    opts.guardian
      ? `HeadPinz: session time change for your players`
      : `HeadPinz: session time change`,
  ];
  for (const e of sorted) {
    if (e.movedFrom) {
      lines.push(
        `- ${playerName(e.member)}: was ${sessionLabelShort(e.movedFrom)}, now ${sessionLabelShort(e.member)}`,
      );
    } else {
      lines.push(`- ${playerName(e.member)}: ${sessionLabelShort(e.member)}`);
    }
  }
  lines.push(``);
  lines.push(shortUrl);
  lines.push(ARENA_SHORT_CTA);
  return lines.join("\n");
}
