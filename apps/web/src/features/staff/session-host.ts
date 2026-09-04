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
 * different action and should look like one; this function is not it.
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
