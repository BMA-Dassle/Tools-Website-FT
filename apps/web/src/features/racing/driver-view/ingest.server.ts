import "server-only";

/**
 * The webhook's fold: venue records in, driver-facing state out.
 *
 * Runs inside the kart webhook's `after()`, beside the race clocks, so the
 * bridge gets its 200 immediately. It does three things per record, in order,
 * and none of them may throw:
 *
 *   1. LEARN. Update the kart ↔ participant ↔ session binding, because that is
 *      what lets a participant-keyed blue flag reach a kart-keyed screen.
 *   2. ROUTE. Work out which kart(s) the record concerns, then classify it for
 *      each one. A record about nobody we know simply produces nothing.
 *   3. KEEP. Push onto the kart's live feed in Redis, and write the permanent
 *      row to Neon.
 *
 * ORDER MATTERS between 1 and 2. A driver's very first passing is both the thing
 * that creates the binding and a lap in its own right, so learning must happen
 * before routing or the first lap of every heat lands unrouted.
 *
 * THE FEED IS SMALL ON PURPOSE. Fifty alerts per kart, six hours. It exists so a
 * screen that just opened knows what is currently true and what it missed while
 * backgrounded — not as a log. The log is Neon.
 */
import redis from "@/lib/redis";
import { classify, readPassing, type RoutingContext, type VenueRecord } from "./classify";
import {
  kartForParticipant,
  kartsInSession,
  kartsOnResource,
  learnBindings,
  readBinding,
} from "./binding";
import {
  clearKart,
  INCIDENT_IDLE_MS,
  isStale,
  joinIncident,
  type IncidentState,
} from "./incident-session";
import { isPersonalBest, numberLaps } from "./laps";
import { isMuted } from "./muted";
import { readSessionLaps, saveEvent, saveLap } from "./store.server";
import type { DriverAlert, KartNumber } from "./types";

const feedKey = (kart: KartNumber) => `kart:feed:${kart}`;
const FEED_MAX = 50;
const FEED_TTL_SECONDS = 6 * 60 * 60;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Which karts a record concerns.
 *
 * Most specific wins: a record naming a kart is about that kart and nothing
 * else. Only when it names neither a kart nor a participant do we fan out to a
 * whole grid, and even then it is scoped — a session first, a track only when
 * there is no session to go on (which is exactly and only `Emergency*`).
 */
async function targetKarts(rec: VenueRecord): Promise<KartNumber[]> {
  const kart = str(rec.RentalObjectName);
  if (kart) return [kart];

  const participantId = str(rec.ParticipantId);
  if (participantId) {
    const bound = await kartForParticipant(participantId);
    return bound ? [bound] : [];
  }

  const sessionId = str(rec.SessionId);
  if (sessionId) return kartsInSession(sessionId);

  const resourceId = str(rec.ResourceId);
  if (resourceId) return kartsOnResource(resourceId);

  return [];
}

const incidentKey = (sessionId: string) => `kart:incident:${sessionId}`;
const INCIDENT_TTL_SECONDS = 30 * 60;

async function readIncident(sessionId: string): Promise<IncidentState | null> {
  try {
    const raw = await redis.get(incidentKey(sessionId));
    return raw ? (JSON.parse(raw) as IncidentState) : null;
  } catch {
    return null;
  }
}

async function writeIncident(state: IncidentState): Promise<void> {
  try {
    await redis.set(
      incidentKey(state.sessionId),
      JSON.stringify(state),
      "EX",
      INCIDENT_TTL_SECONDS,
    );
  } catch {
    /* losing an incident costs a duplicate yellow, never a crash */
  }
}

/**
 * A crash, folded into the session's ONE open incident.
 *
 * The old shape wrote a caution per kart per re-fire and produced 8,615 rows in
 * a night — 2,239 in one session. Now the first crash of an incident raises the
 * yellow and is the only thing written down; every later crash, from any kart,
 * joins it silently. See incident-session.ts.
 */
async function handleCrash(rec: VenueRecord, arrivedAtMs: number): Promise<void> {
  const kart = str(rec.RentalObjectName);
  if (!kart) return;

  // CrashNotification carries NO SessionId and NO ResourceId — verified across
  // 32h of traffic. The only way to know which track it happened on is the
  // binding for the kart that crashed.
  const binding = await readBinding(kart);
  const sessionId = binding?.sessionId ?? null;

  const ctxFor = (k: KartNumber, b: Awaited<ReturnType<typeof readBinding>>): RoutingContext => ({
    kart: k,
    participantId: b?.participantId ?? null,
    sessionId: b?.sessionId ?? null,
    resourceId: b?.resourceId ?? null,
  });

  // The crashing kart always gets its own screen — it is the one with something
  // to do. Re-fires are harmless live (the standing rule collapses by kind) but
  // must not each become a row, so the stored id is the INCIDENT's.
  const own = classify(rec, ctxFor(kart, binding), arrivedAtMs);

  if (!sessionId) {
    // Unbound kart: no session, so no incident and no audience. Show its own
    // driver the crash screen and store nothing further.
    if (own) {
      await pushFeed(own);
      await saveEvent(own, {
        participantId: binding?.participantId ?? null,
        personId: binding?.personId ?? null,
        resourceId: binding?.resourceId ?? null,
      });
    }
    return;
  }

  const eventId = str(rec.Id) ?? `crash:${arrivedAtMs}`;
  const prev = await readIncident(sessionId);
  const joined = joinIncident(isStale(prev, arrivedAtMs) ? null : prev, {
    sessionId,
    kart,
    atMs: arrivedAtMs,
    eventId,
  });
  await writeIncident(joined.state);

  if (own) {
    await pushFeed(own);
    // One crash row per kart per incident, not per re-fire.
    if (joined.isNewKart) {
      await saveEvent(
        { ...own, eventId: `crash:${joined.state.id}:${kart}` },
        {
          participantId: binding?.participantId ?? null,
          personId: binding?.personId ?? null,
          resourceId: binding?.resourceId ?? null,
        },
      );
    }
  }

  // THE YELLOW: raised once, by the crash that opened the incident — and
  // currently muted altogether. On a Starter grid karts spin constantly, so
  // even one-per-incident is dozens an hour and a flag that is always up is not
  // a flag. See muted.ts; the incident above is still tracked, so nothing the
  // redesign needs is lost.
  if (!joined.isNew || isMuted("caution")) return;

  const others = (await kartsInSession(sessionId)).filter((k) => k !== kart);
  let stored = false;
  for (const other of others) {
    const b = await readBinding(other);
    const alert = classify(rec, ctxFor(other, b), arrivedAtMs);
    if (!alert) continue;
    // The yellow stands until the incident closes, not until this one crash's
    // 20s ExpireTime — "treated as a crash till all karts have cleared". The
    // cap is a safety valve for a close that never arrives.
    const caution: DriverAlert = {
      ...alert,
      expiresAtMs: arrivedAtMs + INCIDENT_IDLE_MS,
      eventId: `caution:${joined.state.id}:${other}`,
    };
    await pushFeed(caution);
    // ONE row for the whole incident, keyed on the incident rather than the
    // recipient — this is the line that used to multiply by the grid size.
    if (!stored) {
      stored = true;
      await saveEvent(
        { ...caution, eventId: `caution:${joined.state.id}`, kart, value: kart },
        {
          participantId: binding?.participantId ?? null,
          personId: null,
          resourceId: binding?.resourceId ?? null,
        },
      );
    }
  }
}

/**
 * A kart has recovered. The incident survives until they all have, and the
 * clear that empties it is what lifts the yellow from everyone.
 */
async function handleUnCrash(rec: VenueRecord, arrivedAtMs: number): Promise<void> {
  const kart = str(rec.RentalObjectName);
  if (!kart) return;
  const binding = await readBinding(kart);
  const sessionId = binding?.sessionId ?? null;

  const own = classify(
    rec,
    {
      kart,
      participantId: binding?.participantId ?? null,
      sessionId,
      resourceId: binding?.resourceId ?? null,
    },
    arrivedAtMs,
  );
  if (own) await pushFeed(own);

  if (!sessionId) return;
  const prev = await readIncident(sessionId);
  const { state, closed } = clearKart(prev, { sessionId, kart, atMs: arrivedAtMs });
  if (state) await writeIncident(state);
  if (!closed || !state) return;

  // Track is clean. Lift the yellow everywhere — `recovered` is in caution's
  // clear set, so this is what takes the screens back to the pit board.
  for (const other of await kartsInSession(sessionId)) {
    if (other === kart) continue;
    await pushFeed({
      kind: "recovered",
      level: "inline",
      atMs: arrivedAtMs,
      kart: other,
      sessionId,
      sessionName: null,
      note: null,
      value: null,
      expiresAtMs: null,
      eventId: `clear:${state.id}:${other}`,
      source: "UnCrashNotification",
    });
  }
}

async function pushFeed(alert: DriverAlert): Promise<void> {
  try {
    await redis.lpush(feedKey(alert.kart), JSON.stringify(alert));
    await redis.ltrim(feedKey(alert.kart), 0, FEED_MAX - 1);
    await redis.expire(feedKey(alert.kart), FEED_TTL_SECONDS);
  } catch {
    // A dropped feed entry costs one screen one alert. Never fatal.
  }
}

/** Newest first. Used by the API route the driver view polls. */
export async function readFeed(kart: KartNumber): Promise<DriverAlert[]> {
  try {
    const raw = await redis.lrange(feedKey(kart), 0, FEED_MAX - 1);
    const out: DriverAlert[] = [];
    for (const r of raw) {
      try {
        out.push(JSON.parse(r) as DriverAlert);
      } catch {
        /* one bad entry must not lose the rest */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Fold one venue message — a single record or the array the venue re-sends —
 * into bindings, feeds and rows. Never throws.
 */
export async function ingestVenueMessage(message: unknown, arrivedAtMs: number): Promise<void> {
  const records: VenueRecord[] = Array.isArray(message)
    ? (message as VenueRecord[])
    : message && typeof message === "object"
      ? [message as VenueRecord]
      : [];

  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    try {
      await ingestRecord(rec, arrivedAtMs);
    } catch (err) {
      console.error("[driver-view] ingest failed for", str(rec.$type), err);
    }
  }
}

async function ingestRecord(rec: VenueRecord, arrivedAtMs: number): Promise<void> {
  // 1. LEARN — before routing, so a heat's first passing binds itself.
  await learnBindings(rec, arrivedAtMs);

  const type = str(rec.$type);

  // 2a. A crossing is a lap, not an alert. Store it, then decide whether it was
  //     a personal best — which needs the laps that came before it, so it can
  //     only be answered here and not by the pure classifier.
  if (type === "TimingPassingNotification") {
    const kart = str(rec.RentalObjectName);
    if (!kart) return;
    const passing = readPassing(rec, kart);
    if (!passing || !passing.atUtc) return;

    const binding = await readBinding(kart);
    const priorRows = passing.sessionId ? await readSessionLaps(passing.sessionId, kart) : [];
    const priorLaps = numberLaps(priorRows);

    await saveLap({
      passingId: passing.passingId,
      sessionId: passing.sessionId,
      sessionName: passing.sessionName,
      resourceId: passing.resourceId,
      kart,
      participantId: passing.participantId,
      participantName: passing.participantName,
      personId: binding?.personId ?? null,
      lapTimeMs: passing.lapTimeMs,
      passingTimeUtc: passing.atUtc,
    });

    // A brand-new best on the first timed lap is not news — `isPersonalBest`
    // returns false with nothing to beat, which is the behaviour we want.
    if (isPersonalBest(priorLaps, passing.lapTimeMs) && passing.lapTimeMs !== null) {
      const alert: DriverAlert = {
        kind: "personalBest",
        level: "inline",
        atMs: Date.parse(passing.atUtc) || arrivedAtMs,
        kart,
        sessionId: passing.sessionId,
        sessionName: passing.sessionName,
        note: null,
        value: String(passing.lapTimeMs),
        expiresAtMs: null,
        // Derived, so it needs its own stable key or a replayed passing would
        // announce the same best twice.
        eventId: `pb:${passing.passingId}`,
        source: "TimingPassingNotification",
      };
      await pushFeed(alert);
      await saveEvent(alert, {
        participantId: passing.participantId,
        personId: binding?.personId ?? null,
        resourceId: passing.resourceId,
      });
    }
    return;
  }

  // 2b. Crashes have their own path: one incident, one yellow, however many
  //     karts and however many times the venue re-announces it.
  if (type === "CrashNotification") return handleCrash(rec, arrivedAtMs);
  if (type === "UnCrashNotification") return handleUnCrash(rec, arrivedAtMs);

  // 2c. Everything else is an alert, routed to whoever it concerns.
  const audience = await targetKarts(rec);
  if (audience.length === 0) return;

  for (const kart of audience) {
    const binding = await readBinding(kart);
    const ctx: RoutingContext = {
      kart,
      participantId: binding?.participantId ?? null,
      sessionId: binding?.sessionId ?? null,
      resourceId: binding?.resourceId ?? null,
    };
    const alert = classify(rec, ctx, arrivedAtMs);
    if (!alert) continue;

    // The venue's record id is unique per EVENT, not per recipient. A session
    // flag fanned out to eight karts would collide on the primary key and only
    // the first would be kept, so the stored key is scoped by kart.
    const scoped: DriverAlert = { ...alert, eventId: `${alert.eventId}:${kart}` };

    await pushFeed(scoped);
    await saveEvent(scoped, {
      participantId: binding?.participantId ?? null,
      personId: binding?.personId ?? null,
      resourceId: binding?.resourceId ?? str(rec.ResourceId),
    });
  }
}
