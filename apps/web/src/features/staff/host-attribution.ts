/**
 * WHOSE GROUP IS THIS, AND WHO JUST PRESSED — the PURE half of session hosting.
 *
 * WHY IT IS ITS OWN FILE, and it is not tidiness. `session-host.ts` is
 * `server-only` because it reads Redis, and the shapes below have to be nameable
 * by the check-in board's client hook so it can read `hostConflict` off a
 * response. The house split for exactly this is punch-index (pure) /
 * service (Redis) and crew-list (pure) / crew.server — a client file may import
 * from the pure side and must mirror or avoid the other.
 *
 * WHY THE FOLD IS A FUNCTION RATHER THAN THREE LINES AT EACH CALL SITE. Four
 * actions claim a host (send, start, restart, send-holding) and every one of
 * them has to answer the conflict question identically. A hand-written
 * `host && acting && host.userId !== acting.userId` in four places is four
 * chances to compare first names — which collide — or to fire the modal at
 * somebody who IS the host.
 */

/** The staff member attached to a session. Mirrors what `session-host.ts`
 *  stores and re-exports; declared here so this module stays pure. */
export interface SessionHost {
  /** 7shifts user id — the join key for anything durable. */
  userId: number;
  /** The only thing a screen shows. */
  firstName: string;
  /** ISO. When they claimed the group. */
  assignedAt: string;
}

/** Who made the press, once the server has resolved their punch ID. A subset of
 *  StaffIdentity: a response must never carry a last name or a punch ID to a
 *  tablet mounted on a wall. */
export interface ActingStaff {
  userId: number;
  firstName: string;
}

/**
 * What a claiming action tells the presser about attribution.
 *
 * ALL THREE FIELDS, ALWAYS. The old responses said nothing at all, so a press
 * whose claim was ignored looked exactly like one that landed — which is the
 * whole reported bug: staff pressed Start, the group kept somebody else's name,
 * and nothing on the tablet ever mentioned it.
 */
export interface HostAttribution {
  /** Who holds the group AFTER this action. Null when nobody ever identified
   *  themselves for it. */
  host: SessionHost | null;
  /** Who pressed. Null from the desk board, which has no staff prompt, and null
   *  when 7shifts could not resolve the ID (the prompt's fail-open path). */
  acting: ActingStaff | null;
  /** The press was attributed to somebody else, AND it was a press that claims.
   *  The tablet's Keep / Change modal fires on exactly this. See below for why
   *  it is not simply `host !== acting`. */
  hostConflict: boolean;
}

/**
 * Build the attribution an action returns.
 *
 * CONFLICT NEEDS BOTH SIDES NAMED. An unattributed press (`acting` null) has
 * nobody to hand the group to, and an unclaimed group (`host` null) has nobody
 * to take it from — neither is a conflict, and offering a modal for either
 * would ask a question with no answer. An unclaimed group is the ordinary case
 * and stays silent: the press claims it and nothing is asked (owner 2026-09-07).
 *
 * COMPARED ON `userId`, NEVER ON THE FIRST NAME. Two Alexes on a Saturday is not
 * hypothetical, and first-name equality would silently suppress the modal for
 * precisely the pair of people most likely to be confused for one another. The
 * 7shifts user id is the one stable, unique key (see punch-index).
 *
 * `claims: false` IS FOR A PRESS THAT DOES NOT TAKE THE GROUP — today that is
 * exactly "Play it again" (owner 2026-09-07: restart "must NEVER claim a host
 * and never show the modal"). It is the manager-reaching-over press the NX was
 * invented to defend against, so it neither claims nor asks: the names still
 * travel, for the receipt, and the question is simply not put. Expressed here
 * rather than by overwriting the flag at the call site, so there is one place
 * that decides when the modal may fire.
 */
export function hostAttribution(
  host: SessionHost | null | undefined,
  acting: ActingStaff | null | undefined,
  opts?: {
    /** Does this press claim the group? Default true — every action but restart. */
    claims?: boolean;
  },
): HostAttribution {
  const h = host ?? null;
  const a = acting ? { userId: acting.userId, firstName: acting.firstName } : null;
  const claims = opts?.claims ?? true;
  return { host: h, acting: a, hostConflict: claims && !!h && !!a && h.userId !== a.userId };
}
