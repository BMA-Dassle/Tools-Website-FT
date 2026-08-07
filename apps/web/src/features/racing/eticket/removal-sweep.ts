/**
 * Retract an e-ticket when the racer is taken off the heat.
 *
 * WHY THIS EXISTS. `pre-race-tickets` sends an e-ticket up to 2 hours before a
 * heat, and that SMS is the one artifact in the whole flow that cannot correct
 * itself. The `/t/{id}` and `/g/{id}` pages already poll session-participants
 * every 20s and flip to InvalidCard when the holder leaves the roster — but only
 * if the guest reopens the link. The text in their pocket keeps saying "you're
 * racing Heat 43 at 7:24" forever.
 *
 * Measured 2026-08-05..06: 29 sends named a heat the recipient is now off. Every
 * one went out BEFORE the heat ran — median ~50 min of lead time, up to 135. So
 * there is a real, actionable window here, and nothing was using it.
 *
 * HOW REMOVAL IS DETECTED — BY COMPARING, BECAUSE PANDORA WON'T TELL US.
 * `excludeRemoved=true` drops participants at `F_PAR_STATE = 5`, but that field
 * is NOT in the response body: a removed racer's record is byte-identical in
 * shape to an active one (no state, no flag, no timestamp — verified against
 * live payloads). So the only way to know is to pull the roster twice and diff:
 *
 *     removed = (excludeRemoved=false) \ (excludeRemoved=true)
 *
 * That diff is a POSITIVE signal — "Pandora affirmatively has this person on
 * this session at state 5" — which is what makes it safe to act on. Inferring
 * removal from mere ABSENCE would be indistinguishable from Pandora blinking,
 * and would text a racer mid-outage that their race had vanished. We never do
 * that: if either call fails, or the all-state roster comes back empty, the
 * session is skipped whole. Fail closed, always.
 *
 * A MOVE IS NOT A REMOVAL — THIS IS THE WHOLE BALL GAME.
 * Moving a racer from heat A to heat B removes them from A. `pre-race-tickets`
 * already owns that case end to end: `detectMove` spots it, the SMS reads
 * "was A -> now B", and `supersedeMovedTicket` stamps `movedTo` on the old
 * ticket. If this sweep also fired, a moved racer would get the move alert AND
 * a "you have been removed" alert for the same event — strictly worse than the
 * bug it is fixing. Four independent guards stop that, in `removalVerdict`.
 */
import redis from "@/lib/redis";
import { canonicalizePhone } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import { voxSend } from "@/lib/sms-retry";
import { getParticipantTicketRef, getRaceTicket } from "@/lib/race-tickets";

const NOTIFIED_TTL = 60 * 60 * 24;
const SEEN_TTL = 60 * 60 * 6;
const SENT_TTL = 60 * 60 * 24;
const MAX_SEND_ATTEMPTS = 3;

/**
 * How long a removal has to persist before we tell the guest.
 *
 * Two jobs. Staff routinely remove-and-re-add a racer while shuffling a heat,
 * and a sweep that texted on the first sighting would fire on that flicker. And
 * `pre-race-tickets` runs every 2 minutes, so a genuine MOVE needs a few ticks
 * to be seen, alerted on, and stamped — this hands it that time and lets the
 * move path win every race by construction.
 */
export const REMOVAL_GRACE_MS = 6 * 60 * 1000;

/** Kill switch only — ON unless explicitly disabled (owner rule 2026-07-31). */
export function removalSweepEnabled(): boolean {
  return process.env.ETICKET_REMOVAL_SWEEP !== "false";
}

/** What we remember about a racer we actually texted, so the sweep can reach
 *  them again without re-deriving anything from Pandora. */
export interface NotifiedRacer {
  personId: string;
  /** Destination phone the e-ticket actually went to (guardian's when the
   *  pre-race picker fell back). Canonical E.164. */
  phone: string;
  firstName: string;
  /** Stable across a heat move — the key the move guards read. Absent on
   *  tickets minted before this field existed. */
  participantId?: string;
  ticketId?: string;
  group?: boolean;
  track: string;
  heatNumber: number | string;
  scheduledStart: string;
}

function notifiedKey(sessionId: string | number): string {
  return `eticket:notified:${sessionId}`;
}
function notifiedSessionsKey(ymd: string): string {
  return `eticket:notified:sessions:${ymd}`;
}
function seenKey(sessionId: string | number, personId: string | number): string {
  return `eticket:removal-seen:${sessionId}:${personId}`;
}
function sentKey(sessionId: string | number, personId: string | number): string {
  return `eticket:removal-sent:${sessionId}:${personId}`;
}
function attemptKey(sessionId: string | number, personId: string | number): string {
  return `eticket:removal-attempts:${sessionId}:${personId}`;
}

export function etYmd(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Record that we successfully told this racer about this heat.
 *
 * Called from the pre-race cron's send paths. Deliberately a small HASH per
 * session plus one SET of session ids per day rather than a scannable key
 * pattern — a SCAN over the shared Redis is both slow and, given the June OOM,
 * not something to add lightly. Whole structure is a few KB a day and expires
 * on its own.
 */
export async function recordNotified(
  sessionId: string | number,
  racer: NotifiedRacer,
  now = new Date(),
): Promise<void> {
  try {
    const ymd = etYmd(now);
    await redis.hset(notifiedKey(sessionId), String(racer.personId), JSON.stringify(racer));
    await redis.expire(notifiedKey(sessionId), NOTIFIED_TTL);
    await redis.sadd(notifiedSessionsKey(ymd), String(sessionId));
    await redis.expire(notifiedSessionsKey(ymd), NOTIFIED_TTL);
  } catch {
    // Best effort. A missed index entry costs one un-retracted ticket, never a
    // failed send — this is called AFTER the SMS has already gone out.
  }
}

/** Drop a racer from the notify index — they have been dealt with. */
export async function forgetNotified(
  sessionId: string | number,
  personId: string | number,
): Promise<void> {
  try {
    await redis.hdel(notifiedKey(sessionId), String(personId));
  } catch {
    /* best effort */
  }
}

export async function readNotified(sessionId: string | number): Promise<NotifiedRacer[]> {
  try {
    const all = await redis.hgetall(notifiedKey(sessionId));
    const out: NotifiedRacer[] = [];
    for (const raw of Object.values(all || {})) {
      try {
        out.push(JSON.parse(raw) as NotifiedRacer);
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function notifiedSessionIds(ymd = etYmd()): Promise<string[]> {
  try {
    return (await redis.smembers(notifiedSessionsKey(ymd))) || [];
  } catch {
    return [];
  }
}

// ── the decision ────────────────────────────────────────────────────────────

export type RemovalVerdict =
  | { act: false; reason: "still-on-roster" | "never-on-roster" | "moved" | "waiting-grace" }
  | { act: true };

export interface VerdictInput {
  /** personIds Pandora returns for this session with excludeRemoved=true. */
  active: Set<string>;
  /** personIds with excludeRemoved=false — the superset including state 5. */
  allStates: Set<string>;
  /** Every personId seen ACTIVE on any OTHER session swept this tick. A racer
   *  sitting on another heat's live roster was moved, not scratched. */
  activeElsewhere: Set<string>;
  /** `movedTo` present on this racer's ticket — the move path already
   *  superseded it and sent "was X -> now Y". */
  ticketMoved: boolean;
  /** Session the participant index now points at, if different from this one.
   *  Set by the move path when it re-tickets the racer on the new heat. */
  refSessionId?: string | null;
  /** When we FIRST saw this racer missing from the active roster (ms). */
  firstSeenMs: number | null;
  nowMs: number;
  graceMs?: number;
}

/**
 * Should we tell this racer their e-ticket is dead?
 *
 * Pure so the guard matrix is testable without Redis or Pandora. Order matters:
 * every "not a removal" answer is checked before the grace clock, so a moved
 * racer can never sit accruing grace and then get texted.
 */
export function removalVerdict(sessionId: string, p: string, i: VerdictInput): RemovalVerdict {
  // Still racing this heat — nothing to say.
  if (i.active.has(p)) return { act: false, reason: "still-on-roster" };

  // Absent from the ALL-STATE roster too. That is not evidence of removal, it
  // is absence of evidence: a partial payload, a filtered page, a Pandora
  // hiccup. Only `in allStates && !in active` means F_PAR_STATE = 5.
  if (!i.allStates.has(p)) return { act: false, reason: "never-on-roster" };

  // ── MOVE GUARDS. Any one of these means pre-race-tickets owns this racer.
  // G1 — they are live on another heat right now.
  if (i.activeElsewhere.has(p)) return { act: false, reason: "moved" };
  // G2 — the move path already stamped the old ticket with its "race moved" card.
  if (i.ticketMoved) return { act: false, reason: "moved" };
  // G3 — the participant index has been repointed at a different heat.
  if (i.refSessionId && String(i.refSessionId) !== String(sessionId)) {
    return { act: false, reason: "moved" };
  }

  // G4 — let it settle. Covers staff remove/re-add flicker, and guarantees the
  // 2-minute move path gets several ticks to claim this racer first.
  const grace = i.graceMs ?? REMOVAL_GRACE_MS;
  if (i.firstSeenMs == null || i.nowMs - i.firstSeenMs < grace) {
    return { act: false, reason: "waiting-grace" };
  }

  return { act: true };
}

// ── copy ────────────────────────────────────────────────────────────────────

function timeET(iso: string): string {
  try {
    const d = new Date(iso);
    // An unparseable date does NOT throw here — toLocaleTimeString happily
    // returns the string "Invalid Date", which would have gone out in a live
    // SMS. Check the timestamp, don't rely on the catch.
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return "";
  }
}

/**
 * ASCII ONLY — no middle dot, no em dash, no arrow. Every non-GSM-7 character
 * flips the whole message to UCS-2 (67 chars per segment instead of 153), which
 * is how the pre-race body quietly became a 3-segment send. Same lesson, same
 * rule: plain hyphens.
 */
export function buildRemovalSmsBody(r: NotifiedRacer): string {
  const name = (r.firstName || "Your racer").trim();
  const when = timeET(r.scheduledStart);
  return [
    `FastTrax: race update`,
    `${name} is no longer on ${r.track} Heat ${r.heatNumber}${when ? ` (${when})` : ""}.`,
    `That e-ticket is no longer valid.`,
    `If this is a surprise, see the Karting desk (1st Floor) and we will sort it out.`,
  ].join("\n");
}

// ── send ────────────────────────────────────────────────────────────────────

export interface RetractResult {
  ok: boolean;
  skipped?: "no-phone" | "already-sent" | "attempts-exhausted";
}

/**
 * Tell one racer their e-ticket is dead. Idempotent per (session, person).
 *
 * No retry-queue enrolment on failure, deliberately. A queued body is replayed
 * verbatim minutes-to-days later with no re-check (see lib/sms-quota.ts) — the
 * exact fire-and-forget shape this feature exists to correct. The sweep runs
 * every 2 minutes and will simply try again while the racer is still removed,
 * which self-limits to the window where the message is still true.
 */
export async function sendRemovalSms(
  sessionId: string | number,
  racer: NotifiedRacer,
  dryRun = false,
): Promise<RetractResult> {
  const phone = canonicalizePhone(racer.phone);
  if (!phone) return { ok: false, skipped: "no-phone" };

  if (!dryRun && (await redis.get(sentKey(sessionId, racer.personId)))) {
    return { ok: false, skipped: "already-sent" };
  }

  const attempts = Number((await redis.get(attemptKey(sessionId, racer.personId))) || 0);
  if (attempts >= MAX_SEND_ATTEMPTS) return { ok: false, skipped: "attempts-exhausted" };

  const body = buildRemovalSmsBody(racer);
  if (dryRun) {
    console.log(`[eticket-removals DRY] would sms ${phone}: ${body.replace(/\n/g, " | ")}`);
    return { ok: true };
  }

  const ts = new Date().toISOString();
  const result = await voxSend(phone, body);
  await logSms({
    ts,
    phone,
    source: "eticket-removal",
    status: result.status,
    ok: result.ok,
    error: result.ok ? undefined : (result.error || "").slice(0, 500),
    body,
    sessionIds: [sessionId],
    personIds: [racer.personId],
    memberCount: 1,
    provider: result.provider,
    failedOver: result.failedOver,
    providerMessageId: result.voxId,
  });

  if (result.ok) {
    await redis.set(sentKey(sessionId, racer.personId), "1", "EX", SENT_TTL);
    await forgetNotified(sessionId, racer.personId);
    return { ok: true };
  }
  await redis.set(attemptKey(sessionId, racer.personId), String(attempts + 1), "EX", SENT_TTL);
  return { ok: false };
}

// ── grace bookkeeping ───────────────────────────────────────────────────────

/** Stamp / read when this racer was first seen off the roster. */
export async function markSeenRemoved(
  sessionId: string | number,
  personId: string | number,
  nowMs: number,
): Promise<number> {
  try {
    const existing = await redis.get(seenKey(sessionId, personId));
    if (existing) {
      const n = Number(existing);
      if (Number.isFinite(n)) return n;
    }
    await redis.set(seenKey(sessionId, personId), String(nowMs), "EX", SEEN_TTL);
    return nowMs;
  } catch {
    return nowMs;
  }
}

/** They came back (or moved) — drop the grace clock so a later removal starts fresh. */
export async function clearSeenRemoved(
  sessionId: string | number,
  personId: string | number,
): Promise<void> {
  try {
    await redis.del(seenKey(sessionId, personId));
  } catch {
    /* best effort */
  }
}

/** Has the move path superseded this racer's ticket, or repointed their
 *  participant index at another heat? Both are "pre-race-tickets has this". */
export async function moveSignals(
  racer: NotifiedRacer,
): Promise<{ ticketMoved: boolean; refSessionId: string | null }> {
  let ticketMoved = false;
  let refSessionId: string | null = null;
  try {
    if (racer.ticketId && !racer.group) {
      const t = await getRaceTicket(racer.ticketId);
      if (t?.movedTo) ticketMoved = true;
    }
  } catch {
    /* treat as no signal */
  }
  try {
    if (racer.participantId) {
      const ref = await getParticipantTicketRef(racer.participantId);
      if (ref?.sessionId != null) refSessionId = String(ref.sessionId);
    }
  } catch {
    /* treat as no signal */
  }
  return { ticketMoved, refSessionId };
}
