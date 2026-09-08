import "server-only";

/**
 * WHO IS RUNNING THIS GROUP — the staff member attached to one race session,
 * from the moment they identify themselves at a briefing tablet until the
 * group leaves the pit.
 *
 * This is the display half. The durable record is the `staff_user_id` /
 * `staff_first_name` columns on `briefing_assignments`, written in the same
 * breath (house rule: persist first, display second). This key exists because
 * the pit board reads on a 2-second pulse across three tracks and must not put
 * a Postgres round-trip on that path.
 *
 * FIRST PRESS WINS. The host is claimed with NX, so the person who pulls the
 * group in owns them for the night. Without that, a manager reaching over to
 * press "Play it again" would silently take the group off the person actually
 * walking them to the karts — and the pit board would then name the wrong
 * person on the wall while everybody watched. A deliberate hand-over is a
 * different action and should look like one; this function is not it — see
 * `reassignSessionHost` below, which is, and the modal that has to say yes first.
 *
 * ONLY A FIRST NAME IS KEPT for display (owner: "just first"). The 7shifts user
 * id rides along as the key any later report would join on — punch IDs get
 * reissued, first names collide, and neither is safe to key on.
 */

import redis from "@/lib/redis";
import type { StaffIdentity } from "./punch-index";

/** A race day plus slack for a late night. Matches camera-assign's window. */
const TTL_SECONDS = 24 * 60 * 60;

function hostKey(sessionId: string): string {
  return `staff:session-host:${sessionId}`;
}

export interface SessionHost {
  /** 7shifts user id — the join key for anything durable. */
  userId: number;
  /** The only thing a screen shows. */
  firstName: string;
  /** ISO. When they claimed the group. */
  assignedAt: string;
}

/**
 * Claim a session for a staff member. Returns whoever holds it afterwards —
 * the caller when the claim was free, the existing holder when it was not.
 *
 * Never throws: a Redis blip must not turn into a refused briefing. The Neon
 * row is the record; this is the fast copy.
 */
export async function assignSessionHost(
  sessionId: string,
  staff: StaffIdentity,
): Promise<SessionHost> {
  const host: SessionHost = {
    userId: staff.userId,
    firstName: staff.firstName,
    assignedAt: new Date().toISOString(),
  };
  if (!sessionId) return host;

  try {
    const claimed = await redis.set(
      hostKey(sessionId),
      JSON.stringify(host),
      "EX",
      TTL_SECONDS,
      "NX",
    );
    if (claimed === "OK") return host;
    const existing = await readSessionHost(sessionId);
    return existing ?? host;
  } catch {
    return host;
  }
}

/** The staff member on a session, or null. Never throws. */
export async function readSessionHost(sessionId: string | null): Promise<SessionHost | null> {
  if (!sessionId) return null;
  try {
    const raw = await redis.get(hostKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionHost;
  } catch {
    return null;
  }
}

/**
 * Hosts for many sessions in ONE round trip — for boards that list a day of
 * heats. A per-row `readSessionHost` on the check-in board would be one Redis
 * call per heat on every poll.
 */
export async function readSessionHosts(
  sessionIds: (string | null | undefined)[],
): Promise<Record<string, SessionHost>> {
  const ids = [...new Set(sessionIds.filter((s): s is string => !!s))];
  if (!ids.length) return {};
  try {
    const raws = await redis.mget(...ids.map(hostKey));
    const out: Record<string, SessionHost> = {};
    ids.forEach((id, i) => {
      const raw = raws[i];
      if (!raw) return;
      try {
        out[id] = JSON.parse(raw) as SessionHost;
      } catch {
        /* one unreadable value must not lose the rest */
      }
    });
    return out;
  } catch {
    return {};
  }
}

/**
 * HAND THE GROUP OVER — the deliberate action `assignSessionHost` refuses to be.
 *
 * A plain SET, no NX: this is the one path that is allowed to overwrite, and it
 * exists so that overwriting is something a person chose rather than something a
 * stray press did. The caller has already asked "change the group to X?" and been
 * told yes; every other write in this feature still defers to the first press.
 *
 * TTL IS RESET, not preserved. The hand-over is the new host's starting point and
 * they will be running the group from here to the pit — an inherited two-minute
 * remainder would drop the name off the wall mid-briefing.
 *
 * Never throws, same as its NX sibling: a Redis blip must not turn a hand-over
 * into a refused press. The caller writes the durable row either way.
 */
export async function reassignSessionHost(
  sessionId: string,
  staff: StaffIdentity,
): Promise<SessionHost> {
  const host: SessionHost = {
    userId: staff.userId,
    firstName: staff.firstName,
    assignedAt: new Date().toISOString(),
  };
  if (!sessionId) return host;

  try {
    await redis.set(hostKey(sessionId), JSON.stringify(host), "EX", TTL_SECONDS);
  } catch {
    /* the Neon row is the record; this is the fast copy */
  }
  return host;
}

/**
 * GIVE THE GROUP BACK — nobody holds them.
 *
 * For a claim that should never have happened: a group pulled into the wrong
 * room and cleared before the film ever rolled. Without this the mistaken
 * presser owned that session for 24 hours, so whoever actually briefed them
 * pressed Start and was silently ignored — the NX had already been taken.
 *
 * DELETE RATHER THAN REASSIGN, because at the moment a mis-pull is undone there
 * is no candidate to name: the real briefer has not touched a tablet yet. The
 * next genuine press claims a free key and the first-press rule works as
 * intended.
 *
 * Never throws. A release that fails leaves the old name standing, which is
 * exactly where we were before this existed.
 */
export async function releaseSessionHost(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return;
  try {
    await redis.del(hostKey(sessionId));
  } catch {
    /* the stale name expires with the key's own TTL */
  }
}
