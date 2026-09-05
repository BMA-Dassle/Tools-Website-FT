/**
 * Who is in which kart — the join that makes the whole feature possible.
 *
 * THE PROBLEM. The guest identifies themselves by kart number, but half the
 * events that concern them never mention a kart:
 *
 *     ParticipantBlueFlagNotification  { ParticipantId: 60307227, SessionId: … }   no kart
 *     CrashNotification                { RentalObjectName: "15" }                   no participant, no session
 *
 * Neither can reach a driver on its own. Both can once we know that kart 15 is
 * participant 60307227 in session 58691643.
 *
 * THE SOLUTION. Three record types carry BOTH halves, and all three were
 * verified against 32h of real traffic (2026-09-05):
 *
 *   TimingPassingNotification  RentalObjectName + ParticipantId + SessionId   280 bindings
 *   AssignmentNotification     RentalObjectName + ParticipantId               276 bindings
 *   RaceAdvice.Drivers[]       Kart.Name + DriverId + PersonId + Alias        278 bindings
 *
 * Against that index, the blue flag thrown at "Osborn" resolved to kart 15 by
 * two independent paths, and 41 of 41 distinct crashing karts resolved to a
 * driver. Coverage is not the weak point.
 *
 * PRECEDENCE. RaceAdvice is the strongest source — it is a full roster with the
 * BMI PersonId — but it is also a snapshot that repeats, so it must not overwrite
 * a fresher assignment. A passing is the strongest EVIDENCE, because it means the
 * kart physically crossed the loop with that transponder. So: last write wins on
 * recency, with a passing allowed to overwrite anything and a RaceAdvice row only
 * filling gaps it can see.
 *
 * EVERYTHING IS A STRING. `PersonId` runs 17 digits for cloud-minted people and
 * a Number round-trip lands on a neighbour — see the bridge's `raw-ids.ts`.
 *
 * FAILS TO NULL. Redis unreachable, no binding yet, a kart nobody is in — all of
 * it degrades to "we cannot say", and the driver view falls back to showing only
 * the kart-keyed events, which need no binding at all.
 */
import redis from "@/lib/redis";
import type { KartBinding, KartNumber } from "./types";
import { trackForResource, type VenueRecord } from "./classify";

/** Kart → who is in it. */
const bindKey = (kart: KartNumber) => `kart:bind:${kart}`;
/** Participant → which kart, so a participant-keyed event can be routed. */
const partKey = (participantId: string) => `kart:bindp:${participantId}`;
/** Session → the karts in it, so a session-wide flag reaches every driver on
 *  that grid. CheckeredFlag and SessionPaused name only a session. */
const sessionKey = (sessionId: string) => `kart:session:${sessionId}`;
/** Resource (track) → the karts on it. EmergencyOnNotification names only a
 *  ResourceId, so a red flag has no other way to find its drivers. */
const resourceKey = (resourceId: string) => `kart:resource:${resourceId}`;

/**
 * A binding outlives a heat but not a day. Long enough that a driver can open
 * the screen after their race and still be recognised; short enough that
 * tomorrow's guest in kart 15 is never mistaken for today's.
 */
const BINDING_TTL_SECONDS = 6 * 60 * 60;

/** Where a candidate binding came from, strongest evidence first. */
type BindingSource = "passing" | "assignment" | "advice";

const SOURCE_RANK: Record<BindingSource, number> = { passing: 3, assignment: 2, advice: 1 };

interface StoredBinding extends KartBinding {
  source: BindingSource;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Every binding a single record implies. A RaceAdvice snapshot yields one per
 * driver on the grid; the others yield at most one.
 */
export function bindingsFrom(rec: VenueRecord, atMs: number): StoredBinding[] {
  const type = str(rec.$type);
  if (!type) return [];

  if (type === "TimingPassingNotification" || type === "EnterTapNotification") {
    const kart = str(rec.RentalObjectName);
    const participantId = str(rec.ParticipantId);
    if (!kart || !participantId) return [];
    const resourceId = str(rec.ResourceId);
    return [
      {
        kart,
        participantId,
        participantName: str(rec.ParticipantName),
        personId: null,
        sessionId: str(rec.SessionId),
        sessionName: str(rec.SessionName),
        resourceId,
        track: trackForResource(resourceId),
        updatedAtMs: atMs,
        source: "passing",
      },
    ];
  }

  if (type === "AssignmentNotification") {
    const kart = str(rec.RentalObjectName);
    const participantId = str(rec.ParticipantId);
    if (!kart || !participantId) return [];
    return [
      {
        kart,
        participantId,
        // Assignment often carries an EMPTY ParticipantName — seen live. Do not
        // let "" overwrite a real name learned from a passing.
        participantName: str(rec.ParticipantName),
        personId: null,
        sessionId: str(rec.SessionId),
        sessionName: str(rec.SessionName),
        resourceId: str(rec.ResourceId),
        track: trackForResource(rec.ResourceId),
        updatedAtMs: atMs,
        source: "assignment",
      },
    ];
  }

  if (type === "RaceAdvice" && Array.isArray(rec.Drivers)) {
    const sessionId = str(rec.RaceId);
    const sessionName = str(rec.Name);
    const resourceId = str(rec.ResourceId);
    const track = trackForResource(resourceId);
    const out: StoredBinding[] = [];
    for (const d of rec.Drivers as VenueRecord[]) {
      const kartObj = d?.Kart as VenueRecord | undefined;
      const kart = str(kartObj?.Name);
      if (!kart) continue;
      out.push({
        kart,
        participantId: str(d.DriverId),
        participantName: str(d.Alias),
        personId: str(d.PersonId),
        sessionId,
        sessionName,
        resourceId,
        track,
        updatedAtMs: atMs,
        source: "advice",
      });
    }
    return out;
  }

  return [];
}

/**
 * Merge a candidate over what is stored.
 *
 * Field-by-field rather than wholesale: a RaceAdvice roster is the only thing
 * that knows the PersonId, and a passing is the only thing that proves the kart
 * moved, so neither should erase the other. A null never overwrites a value.
 */
export function mergeBinding(prev: StoredBinding | null, next: StoredBinding): StoredBinding {
  if (!prev) return next;
  // A materially older candidate is stale news — a replayed catch-up dump.
  if (next.updatedAtMs < prev.updatedAtMs - 1000) {
    return {
      ...prev,
      personId: prev.personId ?? next.personId,
    };
  }
  const strongerOrEqual = SOURCE_RANK[next.source] >= SOURCE_RANK[prev.source];
  // A different session with stronger evidence means the kart has moved on.
  const sessionChanged =
    next.sessionId !== null && prev.sessionId !== null && next.sessionId !== prev.sessionId;
  if (sessionChanged && strongerOrEqual) {
    return { ...next, personId: next.personId ?? null };
  }
  return {
    kart: next.kart,
    participantId: next.participantId ?? prev.participantId,
    participantName: next.participantName ?? prev.participantName,
    personId: next.personId ?? prev.personId,
    sessionId: next.sessionId ?? prev.sessionId,
    sessionName: next.sessionName ?? prev.sessionName,
    resourceId: next.resourceId ?? prev.resourceId,
    track: next.track ?? prev.track,
    updatedAtMs: Math.max(next.updatedAtMs, prev.updatedAtMs),
    source: strongerOrEqual ? next.source : prev.source,
  };
}

/** Fold every binding a record implies into Redis. Never throws. */
export async function learnBindings(rec: VenueRecord, atMs: number): Promise<void> {
  const candidates = bindingsFrom(rec, atMs);
  if (candidates.length === 0) return;
  for (const cand of candidates) {
    try {
      const rawPrev = await redis.get(bindKey(cand.kart));
      const prev = rawPrev ? (JSON.parse(rawPrev) as StoredBinding) : null;
      const merged = mergeBinding(prev, cand);
      await redis.set(bindKey(cand.kart), JSON.stringify(merged), "EX", BINDING_TTL_SECONDS);
      if (merged.participantId) {
        await redis.set(partKey(merged.participantId), merged.kart, "EX", BINDING_TTL_SECONDS);
      }
      // Fan-out sets, so a session-wide or track-wide flag can find its drivers.
      if (merged.sessionId) {
        await redis.sadd(sessionKey(merged.sessionId), merged.kart);
        await redis.expire(sessionKey(merged.sessionId), BINDING_TTL_SECONDS);
      }
      if (merged.resourceId) {
        await redis.sadd(resourceKey(merged.resourceId), merged.kart);
        await redis.expire(resourceKey(merged.resourceId), BINDING_TTL_SECONDS);
      }
    } catch {
      // A binding we fail to learn costs one alert its routing, never a crash.
    }
  }
}

/** Every kart currently believed to be in a session. */
export async function kartsInSession(sessionId: string): Promise<KartNumber[]> {
  try {
    return await redis.smembers(sessionKey(sessionId));
  } catch {
    return [];
  }
}

/** Every kart currently believed to be on a track. */
export async function kartsOnResource(resourceId: string): Promise<KartNumber[]> {
  try {
    return await redis.smembers(resourceKey(resourceId));
  } catch {
    return [];
  }
}

/** What we currently believe about a kart. Null when we cannot say. */
export async function readBinding(kart: KartNumber): Promise<KartBinding | null> {
  try {
    const raw = await redis.get(bindKey(kart));
    if (!raw) return null;
    const p = JSON.parse(raw) as StoredBinding;
    // `source` is merge bookkeeping, not domain — rebuilt rather than spread so
    // nothing new on the stored shape leaks out to callers by accident.
    return {
      kart: p.kart,
      participantId: p.participantId,
      participantName: p.participantName,
      personId: p.personId,
      sessionId: p.sessionId,
      sessionName: p.sessionName,
      resourceId: p.resourceId,
      track: p.track,
      updatedAtMs: p.updatedAtMs,
    };
  } catch {
    return null;
  }
}

/** Which kart a participant is in, for routing a participant-keyed event. */
export async function kartForParticipant(participantId: string): Promise<KartNumber | null> {
  try {
    return await redis.get(partKey(participantId));
  } catch {
    return null;
  }
}
