/**
 * E-ticket quiet hours — the business-hours guarantee for the e-ticket
 * SMS/email rail (owner ask 2026-08-16: "no eticket should go out later
 * than business hours; anything still in the queue overnight must not
 * send").
 *
 * Three layers enforce it (belt-and-braces, same philosophy as
 * wallet-overnight-clear's in-code hour gate):
 *   1. The five e-ticket crons (pre-race-tickets, arena-tickets,
 *      checkin-alerts, arena-checkin-alerts, eticket-removals) skip the
 *      whole run during quiet hours.
 *   2. drainRetries / the quota-queue drain hold e-ticket entries during
 *      quiet hours (the retry queue is e-ticket-only; the quota queue is
 *      triaged per-entry by source), and drop e-ticket entries that have
 *      aged past usefulness even in business hours.
 *   3. The eticket-overnight-clear cron (2–5am ET) purges whatever is
 *      still queued, with audit rows for the admin board.
 *
 * Window: quiet from 2am to 9am ET by default. 2am (not midnight) is the
 * owner's call 2026-08-16: HPFM and HPN run past midnight some nights,
 * and suppressing an operational "NOW CHECKING IN" text for a guest
 * standing in the building is worse than a rare 1am queue flush. If ops
 * later prefers 4am, set ETICKET_QUIET_START_ET=4 — numeric env tuning
 * only, these are policy numbers, not feature flags. (A later start is
 * safe by construction: the stale-age drop at drain catches anything
 * queued between the ~3:20am purge and a 4am+ quiet start.)
 *
 * THE END OF THE WINDOW IS ALSO THE MORNING FLOOR (owner 2026-08-25:
 * "send the day's e-tickets no earlier than 9am"). It moved 8am → 9am,
 * and it stopped being just a clock gate — see heldUntilMorning below.
 * The two-hour pre-send horizon that used to make a run gate sufficient
 * is gone: since 0f9c0f599 (2026-08-19) the pre-session crons ticket ANY
 * session of the ET day the moment its roster is read, so the day rolls
 * at midnight and the 00:00–02:00 late-close carve-out started leaking
 * the whole day's tickets. Real on 2026-08-25: a racer was texted at
 * 12:01am about a heat checking in at 4:50pm. A flat "nothing before
 * 9am" would have fixed that by also killing the 12:45am laser-tag
 * tickets the carve-out exists for, so the floor is per-session instead:
 * before 9am we only announce sessions that start before 9am.
 */

import type { SmsRetryCron } from "@/lib/sms-retry";

/** Every source value the e-ticket rail logs/queues under. Booking
 *  confirmations, video links, etc. are deliberately NOT here — the
 *  quiet-hours guarantee is scoped to e-tickets. */
export const ETICKET_CRON_SOURCES: readonly SmsRetryCron[] = [
  "pre-race-cron",
  "checkin-cron",
  "arena-pre-cron",
  "arena-checkin-cron",
];

export function isEticketSource(source: string): boolean {
  return (ETICKET_CRON_SOURCES as readonly string[]).includes(source);
}

function intEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(raw) && raw >= 0 && raw <= 23 ? raw : fallback;
}

/** Quiet window start hour ET (inclusive). Default 2 = 2am — HPFM/HPN
 *  close after midnight some nights (owner 2026-08-16). */
export function quietStartHourET(): number {
  return intEnv("ETICKET_QUIET_START_ET", 2);
}

/** Quiet window end hour ET (exclusive), and the morning floor for the
 *  day's e-tickets. Default 9 = 9am (owner 2026-08-25). */
export function quietEndHourET(): number {
  return intEnv("ETICKET_QUIET_END_ET", 9);
}

export function hourET(now: Date = new Date()): number {
  return (
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).format(now),
    ) %
    // Node 24 formats midnight as "00", but hour12:false resolves to the h24
    // cycle in some ICU builds and yields "24" — which would read as "later
    // than every floor" and silently invert the late-night carve-out below.
    24
  );
}

/**
 * True when e-ticket sends must not go out right now. Handles windows
 * that wrap midnight (start 23, end 8) and the default same-day window
 * (start 2, end 8). start === end disables the gate.
 */
export function inEticketQuietHours(now: Date = new Date()): boolean {
  const start = quietStartHourET();
  const end = quietEndHourET();
  if (start === end) return false;
  const h = hourET(now);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/**
 * THE MORNING FLOOR, per session. True when this e-ticket must wait for
 * the day to open rather than go out now.
 *
 * Held when the clock is before the floor (9am ET) AND the session it
 * announces starts at or after the floor — i.e. it is one of the day's
 * sessions, being announced the night before or in the small hours.
 *
 * NEVER held when the session itself starts before the floor. That is the
 * night still finishing — a 12:45am laser-tag session ticketed at 12:00am
 * to a guest already in the building (57 such sends in the 45 days to
 * 2026-08-25). Holding those until 9am would deliver a ticket eight hours
 * after the session ran, which is worse than not sending at all. The rule
 * this encodes: never delay a ticket past the thing it is a ticket for.
 *
 * Fails OPEN on a missing or unparseable start — a ticket that goes out is
 * recoverable, one swallowed by a date-parse edge case is not. Disabled
 * along with the quiet gate when start === end.
 *
 * @param scheduledStart session start (ISO 8601 UTC, as Pandora returns it)
 */
export function heldUntilMorning(
  scheduledStart: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  const floor = quietEndHourET();
  if (floor === quietStartHourET()) return false; // gate disabled
  if (hourET(now) >= floor) return false; // the day is already open
  if (!scheduledStart) return false;
  const start = scheduledStart instanceof Date ? scheduledStart : new Date(scheduledStart);
  if (isNaN(start.getTime())) return false;
  return hourET(start) >= floor;
}

/**
 * Max useful age for a QUEUED e-ticket send, by source. Past this, the
 * message is wrong even during business hours (e-tickets reference a
 * session that has since started; check-in alerts are minutes-relevant),
 * so drains drop rather than deliver. Pre-session tickets go out up to
 * 2h before start — 3h of queue age puts the session ~1h in the past.
 */
export function maxQueueAgeMs(source: string): number {
  if (source === "checkin-cron" || source === "arena-checkin-cron") return 30 * 60 * 1000;
  return 3 * 60 * 60 * 1000;
}

/** Audit string logged when a queued e-ticket is dropped instead of
 *  sent. The admin board keys a pill off this exact prefix. */
export const ETICKET_EXPIRED_ERROR = "expired in queue — not sent (after hours / stale)";
