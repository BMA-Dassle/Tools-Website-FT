import { randomBytes } from "crypto";
import redis from "@/lib/redis";

/**
 * Shared ticket record used by the pre-race and now-checking-in flows.
 * One ticket per (sessionId, personId) pair; both flows reuse the same id
 * so the `/t/{id}` URL is stable across the racer's journey.
 */

export interface RaceTicket {
  /** Pandora returns sessionId as string on the sessions-list endpoint and as number on the current-races endpoint — accept both. */
  sessionId: number | string;
  locationId: string;
  personId: number | string;
  /** Per-participation record id from Pandora. Stable across a heat
   *  move (unlike sessionId) — embedded in the check-in QR so a moved
   *  racer's ticket resolves to their LIVE session at scan time.
   *  Optional for back-compat with tickets minted before this field. */
  participantId?: number | string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  scheduledStart: string; // ISO
  track: string; // "Blue" | "Red" | "Mega"
  raceType: string; // "Starter" | "Intermediate" | "Pro"
  heatNumber: number;
  /** Optional — filled in if we can correlate to a Square reservation */
  resNumber?: string;
  /** True when the SMS / email was routed to a guardian instead of
   *  the racer (minor with no usable own contact). The `phone` and
   *  `email` fields above hold the destination contact (guardian's
   *  in this case) so the resend path works without further lookups. */
  viaGuardian?: boolean;
  /** Guardian's first name when known — used by the /t/{id} page to
   *  render a "Sent to {GuardianFirstName} (parent)" line so the
   *  parent immediately understands. */
  guardianFirstName?: string;
  /** Set when this ticket's racer was moved to a different heat. The
   *  /t/{id} page renders a "your race moved" card (instead of the
   *  ambiguous InvalidCard) pointing at the new ticket. Carries the NEW
   *  heat's display detail + ticket id. */
  movedTo?: MovedTo;
}

/** New-heat detail stamped onto a superseded ticket (RaceTicket.movedTo /
 *  GroupTicketMember.movedTo) and shared by the move-detection / SMS path. */
export interface MovedTo {
  ticketId: string;
  /** True when the new ticket is a family group page (/g/{ticketId}); false /
   *  absent for a single ticket (/t/{ticketId}). Drives the "View updated
   *  e-ticket" link target on the moved card. */
  group?: boolean;
  sessionId: number | string;
  heatNumber: number;
  track: string;
  raceType: string;
  scheduledStart: string;
}

const TICKET_TTL = 60 * 60 * 12; // 12 hours
const LOOKUP_TTL = 60 * 60 * 12;

function ticketKey(id: string) {
  return `ticket:${id}`;
}

function lookupKey(sessionId: number | string, personId: number | string) {
  return `ticket:bySession:${sessionId}:${personId}`;
}

function participantRefKey(participantId: number | string) {
  return `ticket:byParticipant:${participantId}`;
}

const PARTICIPANT_REF_TTL = 60 * 60 * 24; // 24h — long enough to span a day's moves

/**
 * Per-participation pointer to the last heat we issued a ticket for today.
 * Keyed by the STABLE participantId (survives a move), so the pre-race cron
 * can tell "same participant, different session" (a MOVE) apart from a brand
 * new participantId (a second booking). Carries enough heat detail to render
 * the move "was X → now Y".
 */
export interface ParticipantTicketRef {
  sessionId: number | string;
  ticketId: string;
  /** True when the last-issued ticket for this participant was a group page
   *  (/g) rather than a single ticket (/t) — tells the supersede path which
   *  store to stamp the moved card on. */
  group?: boolean;
  heatNumber: number;
  track: string;
  raceType: string;
  scheduledStart: string;
}

export async function getParticipantTicketRef(
  participantId: number | string,
): Promise<ParticipantTicketRef | null> {
  try {
    const raw = await redis.get(participantRefKey(participantId));
    if (!raw) return null;
    return JSON.parse(raw) as ParticipantTicketRef;
  } catch {
    return null;
  }
}

export async function setParticipantTicketRef(
  participantId: number | string,
  ref: ParticipantTicketRef,
): Promise<void> {
  await redis.set(participantRefKey(participantId), JSON.stringify(ref), "EX", PARTICIPANT_REF_TTL);
}

/**
 * Stamp a `movedTo` pointer on a superseded ticket so its /t/{oldId} page
 * shows the "your race moved" card instead of the ambiguous InvalidCard.
 * No-op if the old ticket has already expired. Preserves the rest of the
 * record (read-modify-write).
 */
export async function markTicketMoved(oldTicketId: string, movedTo: MovedTo): Promise<void> {
  try {
    const raw = await redis.get(ticketKey(oldTicketId));
    if (!raw) return;
    const ticket = JSON.parse(raw) as RaceTicket;
    ticket.movedTo = movedTo;
    // Preserve remaining TTL rather than resetting to a fresh 12h.
    const ttl = await redis.ttl(ticketKey(oldTicketId));
    await redis.set(
      ticketKey(oldTicketId),
      JSON.stringify(ticket),
      "EX",
      ttl && ttl > 0 ? ttl : TICKET_TTL,
    );
  } catch {
    /* best-effort — a missing/corrupt old ticket just means no moved card */
  }
}

function newTicketId(): string {
  // 8-char base64url is ~48 bits — plenty for our dedup window
  return randomBytes(6).toString("base64url").slice(0, 8);
}

/**
 * Reuse an existing ticket for the (sessionId, personId) pair or create a
 * new one. Returns the ticket id.
 */
export async function upsertRaceTicket(ticket: RaceTicket): Promise<string> {
  const lk = lookupKey(ticket.sessionId, ticket.personId);
  const existing = await redis.get(lk);
  let id: string;
  if (existing) {
    // Refresh the underlying record in case anything changed (phone was added, etc.)
    await redis.set(ticketKey(existing), JSON.stringify(ticket), "EX", TICKET_TTL);
    await redis.expire(lk, LOOKUP_TTL);
    id = existing;
  } else {
    id = newTicketId();
    await redis.set(ticketKey(id), JSON.stringify(ticket), "EX", TICKET_TTL);
    await redis.set(lk, id, "EX", LOOKUP_TTL);
  }
  // Point the participant index at this heat so the next cron tick can detect
  // a move (same participantId, different session). Move DETECTION reads this
  // index earlier in the cron run (before any upsert), so updating it here is
  // safe. Only when we have a stable participantId to key on.
  if (ticket.participantId != null && String(ticket.participantId).trim()) {
    await setParticipantTicketRef(ticket.participantId, {
      sessionId: ticket.sessionId,
      ticketId: id,
      group: false,
      heatNumber: ticket.heatNumber,
      track: ticket.track,
      raceType: ticket.raceType,
      scheduledStart: ticket.scheduledStart,
    });
  }
  return id;
}

export async function getRaceTicket(id: string): Promise<RaceTicket | null> {
  try {
    const raw = await redis.get(ticketKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as RaceTicket;
  } catch {
    return null;
  }
}

/**
 * Group ticket — one per (canonical phone) when a phone number maps to 2+
 * racers in the current cron window. Renders at /g/{id}.
 */
export interface GroupTicketMember {
  sessionId: number | string;
  personId: number | string;
  /** See RaceTicket.participantId — stable across a heat move; embedded
   *  in the per-member check-in QR. Optional for back-compat. */
  participantId?: number | string;
  firstName: string;
  lastName: string;
  scheduledStart: string;
  track: string; // "Blue" | "Red" | "Mega"
  raceType: string;
  heatNumber: number;
  /** Set when THIS member was moved to a different heat — the /g page renders
   *  a "your race moved" card for just this member instead of InvalidCard. */
  movedTo?: MovedTo;
}

export interface GroupTicket {
  id: string;
  phone: string; // canonical +1... (the destination phone — guardian's when `recipient === "guardian"`)
  locationId: string;
  members: GroupTicketMember[];
  createdAt: string; // ISO
  /** Who this group ticket is addressed to. Defaults to "racer"
   *  when absent (back-compat for tickets minted before guardian
   *  fallback). When "guardian" the /g/{id} page swaps its heading
   *  to "Your racers' e-tickets" — the member list rendering is
   *  already multi-member-aware. */
  recipient?: "racer" | "guardian";
  /** Guardian's first name for body-builder use. Only meaningful
   *  when recipient === "guardian". */
  guardianFirstName?: string;
}

function groupKey(id: string) {
  return `group:${id}`;
}

/**
 * Create a new group ticket. No byPhone lookup — each cron run that needs a
 * group ticket gets a fresh id, and short-url dedup lets the old one expire.
 * Returns the new id.
 */
export async function upsertGroupTicket(
  input: Omit<GroupTicket, "id" | "createdAt">,
): Promise<string> {
  const id = newTicketId();
  const record: GroupTicket = { ...input, id, createdAt: new Date().toISOString() };
  await redis.set(groupKey(id), JSON.stringify(record), "EX", TICKET_TTL);
  // Point each member's participant index at this group page's heat so a
  // later move (same participantId, different session) is detectable even when
  // the racer was last reached via a family group ticket. The ref's ticketId
  // is the group id; markTicketMoved no-ops on it (group pages aren't
  // superseded with a movedTo card in this version — see cron notes).
  for (const m of record.members) {
    if (m.participantId == null || !String(m.participantId).trim()) continue;
    await setParticipantTicketRef(m.participantId, {
      sessionId: m.sessionId,
      ticketId: id,
      group: true,
      heatNumber: m.heatNumber,
      track: m.track,
      raceType: m.raceType,
      scheduledStart: m.scheduledStart,
    });
  }
  return id;
}

export async function getGroupTicket(id: string): Promise<GroupTicket | null> {
  try {
    const raw = await redis.get(groupKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as GroupTicket;
  } catch {
    return null;
  }
}

/**
 * Stamp a per-member `movedTo` on a group ticket so the moved member's card on
 * /g/{oldGroupId} shows "your race moved" instead of the ambiguous
 * InvalidCard. Matches the member by stable participantId. No-op if the group
 * or member is gone / expired. Preserves remaining TTL and the other members.
 */
export async function markGroupMemberMoved(
  oldGroupId: string,
  participantId: number | string,
  movedTo: MovedTo,
): Promise<void> {
  try {
    const raw = await redis.get(groupKey(oldGroupId));
    if (!raw) return;
    const group = JSON.parse(raw) as GroupTicket;
    const target = String(participantId);
    let changed = false;
    for (const m of group.members) {
      if (m.participantId != null && String(m.participantId) === target) {
        m.movedTo = movedTo;
        changed = true;
      }
    }
    if (!changed) return;
    const ttl = await redis.ttl(groupKey(oldGroupId));
    await redis.set(
      groupKey(oldGroupId),
      JSON.stringify(group),
      "EX",
      ttl && ttl > 0 ? ttl : TICKET_TTL,
    );
  } catch {
    /* best-effort — a missing/corrupt group just means no moved card */
  }
}

/**
 * Supersede whatever ticket last represented this participant — single OR group
 * — with a moved card pointing at the new heat. Routes by the old ref's
 * `group` flag so a racer who moved away from EITHER a single ticket or a
 * family group page gets the clear "your race moved" treatment.
 */
export async function supersedeMovedTicket(
  oldRef: ParticipantTicketRef,
  participantId: number | string,
  movedTo: MovedTo,
): Promise<void> {
  if (oldRef.group) {
    await markGroupMemberMoved(oldRef.ticketId, participantId, movedTo);
  } else {
    await markTicketMoved(oldRef.ticketId, movedTo);
  }
}
