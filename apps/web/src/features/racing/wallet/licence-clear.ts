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

/**
 * Today's sessions across all tracks, keyed by id. One fetch per track — the
 * same cron-warmed proxy `checkin-race-flags` reads, so this is cheap.
 */
async function fetchTodaySessions(origin: string, ymd: string): Promise<Map<string, SessionRow>> {
  const byId = new Map<string, SessionRow>();
  await Promise.all(
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

  const ymd = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const sessions = await fetchTodaySessions(origin, ymd);
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
