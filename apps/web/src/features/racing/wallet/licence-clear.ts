/**
 * Clear the live fields on a wallet racing licence once the heat they refer to
 * has actually happened.
 *
 * WHY THIS EXISTS. `pre-race-tickets` writes NEXT RACE and `checkin-alerts`
 * writes "Check in now" — and nothing unwrote them. A pass would sit there
 * telling a racer to check in for a heat that finished hours ago, which is
 * worse than a pass with no live fields at all: it misleads, and it teaches
 * people to ignore the notifications that matter.
 *
 * WHY NOT A TIMER — this is the whole design point (owner, 2026-08-05: "we run
 * really late, can't we do it off them raced or not"). An elapsed-time sweep is
 * wrong in BOTH directions, and real data from a single day proves it:
 *
 *   Heat 11 · scheduled 17:00 · actualStart 17:08 · actualEnd 17:18   (8 min LATE)
 *   Heat  1 · scheduled 15:00 · actualStart 14:43 · actualEnd 14:51  (17 min EARLY)
 *
 * A 25-minute window would have cleared heat 11's alert while its racers were
 * still standing at the desk waiting, and left heat 1's up long after everyone
 * had raced. So we key off what BMI actually recorded:
 *
 *   actualStart set  → the race is under way; check-in is over BY DEFINITION
 *   actualEnd   set  → the race is done; it is no longer anybody's "next race"
 *
 * Those come straight off `/v2/bmi/sessions/{locationId}` and need nothing of
 * ours to stay in sync. A heat delayed an hour keeps its alert up for exactly
 * that hour, with no configuration.
 *
 * Same rules as the rest of the wallet code: never fail a caller, never read
 * the pass to decide anything, and skip anyone without one.
 */
import { getPassesWithLiveFields, markPushed } from "~/features/racing/data/racer-wallet-db";
import { updateLicencePass, licencePassEnabled } from "~/features/racing/wallet/licence-pass";

const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
/** Every FastTrax track — a racer's heat could be on any of them. */
const RESOURCES = ["Blue Track", "Red Track", "Mega Track"] as const;

/**
 * What NEXT RACE says when the window is empty.
 *
 * NOT "None booked" — that is a claim about the racer's whole schedule, and we
 * only ever have two hours of evidence (pre-race-tickets' WINDOW_AHEAD_MS). A
 * racer booked for 6pm would have been told at 2pm that they had nothing, which
 * is simply false. This says exactly what we know and nothing more.
 *
 * 18 characters — inside the 22 that fit a secondary field; 26 truncated on
 * device.
 */
export const NO_NEXT_RACE = "None in next 2 hrs";

/** Written when the racer's heat actually starts — the fourth and last alert of
 *  a race, and what stops "Check in now" lingering after they are on track. */
export const GREEN_FLAG = "Green flag — you're racing";

interface SessionRow {
  sessionId?: string | number;
  actualStart?: string | null;
  actualEnd?: string | null;
}

/** ET calendar date, N days back from now. */
function etYmd(daysBack = 0): string {
  const d = new Date(Date.now() - daysBack * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Hour 0-23 in ET, for the after-midnight and dead-hours decisions. */
export function etHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  ) % 24;
}

/**
 * Sessions across all tracks for the given ET days, keyed by id. One fetch per
 * track per day — the same cron-warmed proxy `checkin-race-flags` reads.
 *
 * WHY MORE THAN ONE DAY. The range is `{ymd}T00:00:00`..`{ymd}T23:59:59`, so a
 * heat that ENDS after midnight drops off "today's" query the instant the ET
 * date rolls. Its session then cannot be found, and the guard below —
 * deliberately, so a Pandora blip never wipes a live pass — clears nothing. The
 * result was a pass still advertising last night's race all through the next
 * day. Not hypothetical: heats here run a median 19.8 minutes late and up to 41
 * (2026-08-06), so the last few of an evening routinely spill past midnight.
 *
 * Yesterday is only added in the small hours, so the per-minute cron pays for
 * one extra day's fetches during the window where it actually matters.
 */
async function fetchSessionsForDays(
  origin: string,
  ymds: readonly string[],
): Promise<Map<string, SessionRow>> {
  const byId = new Map<string, SessionRow>();
  await Promise.all(
    ymds.flatMap((ymd) =>
      RESOURCES.map(async (resourceName) => {
        try {
          const qs = new URLSearchParams({
            locationId: FASTTRAX_LOCATION_ID,
            resourceName,
            startDate: `${ymd}T00:00:00`,
            endDate: `${ymd}T23:59:59`,
            prefer: "cache",
          }).toString();
          const res = await fetch(`${origin}/api/pandora/sessions?${qs}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return;
          const json = await res.json();
          for (const s of Array.isArray(json?.data) ? (json.data as SessionRow[]) : []) {
            const id = s.sessionId == null ? "" : String(s.sessionId);
            if (id) byId.set(id, s);
          }
        } catch {
          /* one track failing must not strand the others */
        }
      }),
    ),
  );
  return byId;
}

export interface ClearResult {
  checked: number;
  checkinCleared: number;
  nextRaceCleared: number;
}

/**
 * Sweep every pass carrying a live field and clear what has already happened.
 *
 * Deliberately does NOT clear a field whose session we cannot find. An unknown
 * session means the schedule fetch failed or the heat is on another day — and
 * wiping a racer's "check in now" because Pandora blinked would be exactly the
 * failure this is meant to prevent. Leaving it costs one stale minute; clearing
 * it wrongly costs a missed race.
 */
export async function clearFinishedLicenceFields(origin: string): Promise<ClearResult> {
  const out: ClearResult = { checked: 0, checkinCleared: 0, nextRaceCleared: 0 };
  if (!licencePassEnabled()) return out;

  const rows = await getPassesWithLiveFields();
  out.checked = rows.length;
  if (rows.length === 0) return out;

  // Before ~6am ET, last night's heats are the ones still in question — and
  // they are on YESTERDAY's schedule. See fetchSessionsForDays.
  const days = etHour() < 6 ? [etYmd(0), etYmd(1)] : [etYmd(0)];
  const sessions = await fetchSessionsForDays(origin, days);
  if (sessions.size === 0) return out; // schedule unavailable — clear nothing

  for (const row of rows) {
    // "Check in now" dies the moment the race STARTS. Check-in cannot still be
    // open for a heat already on track, however late it went off.
    if (row.checkinStatus && row.checkinSessionId) {
      const s = sessions.get(row.checkinSessionId);
      if (s && (s.actualStart || s.actualEnd)) {
        const ok = await updateLicencePass(row.personId, { checkinStatus: "" });
        if (ok) {
          await markPushed(row.personId, { checkinSessionId: null });
          out.checkinCleared++;
        }
      }
    }

    // NEXT RACE survives until the heat has actually ENDED — a race in progress
    // is still the racer's current race, and blanking it mid-session would read
    // as though their booking had vanished.
    if (row.nextRace && row.nextRace !== NO_NEXT_RACE && row.nextRaceSessionId) {
      const s = sessions.get(row.nextRaceSessionId);
      if (s && s.actualEnd) {
        // pre-race-tickets rewrites this the moment a later heat is in range,
        // so this only ever shows for a racer with genuinely nothing left.
        const ok = await updateLicencePass(row.personId, { nextRace: NO_NEXT_RACE });
        if (ok) {
          await markPushed(row.personId, { nextRaceSessionId: null });
          out.nextRaceCleared++;
        }
      }
    }
  }
  return out;
}

/**
 * THE OVERNIGHT FAILSAFE — the belt to the sweep above's braces.
 *
 * Everything above is EVIDENCE-BASED: it clears a field only once BMI has
 * recorded the heat starting or ending. That is the right rule while the centre
 * is open, and it is why a race running an hour late keeps its alert for exactly
 * that hour. But every one of its exits is a "clear nothing" exit — an
 * unreachable Pandora, a session on a day we did not query, a heat that never
 * got an `actualEnd` written because it was cancelled or abandoned mid-run. Each
 * of those is correct in the moment and leaves the field set forever.
 *
 * By 3am the centre has been shut for hours, so the question stops being "did
 * this heat finish?" and becomes "can ANY of this still be true?" — and the
 * answer is no. Nobody's next race is last night's, and nobody is checking in.
 * So this clears unconditionally, with no schedule lookup at all: there is
 * nothing to fetch that could make a stale field legitimate, and requiring
 * evidence is exactly what let it survive.
 *
 * GUARDED TO THE DEAD HOURS. It refuses to run outside 2-5am ET even if
 * invoked, because the one thing that must never happen is this wiping "Check in
 * now" off a pass while its racer is standing at the desk. A cron
 * misconfiguration, a manual curl, or a DST shift cannot turn it into that.
 *
 * ONE NOTE ON NOTIFICATIONS. `nextRace` carries no changeMessage, so clearing it
 * is silent. `checkinStatus` DOES ("FastTrax: %@"), so a pass that still has a
 * live check-in value at 3am may raise one lock-screen alert as it is cleared.
 * That is accepted: a pass reading "Check in now — Red Heat 60" all through the
 * following day is the worse outcome, and after the yesterday-schedule fix above
 * almost nothing should still be set by the time this runs. NOT yet observed on
 * a device — the first real firing is the test.
 */
export async function clearStaleLicenceFieldsOvernight(): Promise<
  ClearResult & { skipped?: string }
> {
  const out: ClearResult = { checked: 0, checkinCleared: 0, nextRaceCleared: 0 };
  if (!licencePassEnabled()) return out;

  const hour = etHour();
  if (hour < 2 || hour > 5) {
    return { ...out, skipped: `outside the 2-5am ET window (ET hour ${hour})` };
  }

  const rows = await getPassesWithLiveFields();
  out.checked = rows.length;

  for (const row of rows) {
    if (row.checkinStatus) {
      const ok = await updateLicencePass(row.personId, { checkinStatus: "" });
      if (ok) {
        await markPushed(row.personId, { checkinSessionId: null });
        out.checkinCleared++;
      }
    }
    if (row.nextRace && row.nextRace !== NO_NEXT_RACE) {
      const ok = await updateLicencePass(row.personId, { nextRace: NO_NEXT_RACE });
      if (ok) {
        await markPushed(row.personId, { nextRaceSessionId: null });
        out.nextRaceCleared++;
      }
    }
  }
  return out;
}
