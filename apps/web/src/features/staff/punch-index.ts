/**
 * The punch-ID index — the PURE half. Who counts as active, what they are
 * called, and how a punch ID maps to exactly one person. No Redis, no fetch:
 * everything here is testable, and the service module imports from here so the
 * cached index and a live rebuild can never disagree about a rule.
 *
 * WHY AN INDEX AT ALL. 7shifts cannot filter users by punch ID (see
 * `~/lib/api/sevenshifts` header), so the only way to resolve one is to hold
 * every user and match locally. Building that map is this file; caching it is
 * `service.ts`.
 */

import type { SevenShiftsUser } from "~/lib/api/sevenshifts";

/**
 * One staff member, as everything downstream knows them.
 *
 * `userId` IS THE KEY, not the punch ID. 7shifts guarantees the user id is
 * unique and stable; punch IDs are a time-clock convenience that can be
 * reissued when someone leaves, and the team portal's own code says so
 * ("Index by seven_shifts_id only — unique per employee, punch_id can
 * collide"). Records written against a punch ID would silently re-point at a
 * new hire months later; records written against the user id cannot.
 */
export interface StaffIdentity {
  /** 7shifts user id. Stable, unique, and what we persist. */
  userId: number;
  /** What they typed. Kept for display and audit, never as the key. */
  punchId: string;
  /** Preferred first name when set, else legal. The only name shown on a board. */
  firstName: string;
  /** Kept for admin lists and disambiguation. Never shown on a guest-visible surface. */
  lastName: string;
}

/** punchId → the one person who holds it. */
export type PunchIndex = Record<string, StaffIdentity>;

export interface BuiltPunchIndex {
  index: PunchIndex;
  /**
   * Punch IDs held by more than one ACTIVE user. Deliberately EXCLUDED from the
   * index rather than resolved by picking one — see buildPunchIndex.
   */
  collisions: string[];
  /** How many active users carried a usable punch ID. */
  size: number;
}

/**
 * Is this user active?
 *
 * Belt and braces, because the upstream filter is unreliable: 7shifts' guide
 * says `status` filtering is v1-only "for now" while the v2 reference lists it
 * as a parameter. So we ask for `status=active` AND re-check here. A user the
 * API forgot to filter must not be able to start a briefing.
 *
 * `active` is the boolean 7shifts returns; `status` is the newer string. Either
 * saying "no" is a no. Neither present means active — a company that has never
 * deactivated anyone returns neither field, and failing closed there would lock
 * out the whole roster.
 */
export function isActiveUser(u: SevenShiftsUser): boolean {
  if (u.active === false) return false;
  const status = (u.status ?? "").trim().toLowerCase();
  if (status && status !== "active") return false;
  return true;
}

/**
 * What we call them. Preferred first name wins — it is the name on the schedule
 * and the name the rest of the team uses, and the portal applies the same rule
 * (`preferred_first_name || first_name`). Applied ONCE here, at index time, so
 * a board can never drift from what 7shifts shows.
 */
export function staffFirstName(u: SevenShiftsUser): string {
  return (u.preferred_first_name || u.first_name || "").trim();
}

function staffLastName(u: SevenShiftsUser): string {
  return (u.preferred_last_name || u.last_name || "").trim();
}

/** Punch IDs are typed on a numeric keypad; compare them as the strings they are. */
export function normalizePunchId(raw: string): string {
  return raw.trim();
}

/**
 * A user reduced to an identity, or null when they cannot hold one.
 *
 * Null for: inactive, no punch ID, or no first name. The last is not
 * pedantry — the whole point of this lookup is to put a name on a session, and
 * an identity with an empty name would render as a blank chip on the pit board
 * that nobody could explain.
 */
export function staffFromUser(u: SevenShiftsUser): StaffIdentity | null {
  if (!isActiveUser(u)) return null;
  const punchId = normalizePunchId(u.punch_id ?? "");
  if (!punchId) return null;
  const firstName = staffFirstName(u);
  if (!firstName) return null;
  return { userId: u.id, punchId, firstName, lastName: staffLastName(u) };
}

/**
 * Build the punch ID → person map.
 *
 * COLLISIONS ARE EXCLUDED, NOT RESOLVED. If two active users share a punch ID
 * we drop it from the index entirely, so the prompt says "try again" instead of
 * attributing a group to whichever record happened to sort first. The team
 * portal takes the other path — `WHERE punch_id = $1 ... LIMIT 1` — which is
 * fine for a login the person can see the result of, and wrong here, where the
 * consequence is a silently mis-signed session nobody looks at until payroll.
 *
 * The owner's position is that punch IDs are unique per employee, and this
 * costs nothing if that holds: `collisions` stays empty and every ID resolves.
 * It is here so that if it ever stops holding, the failure is a staff member
 * retyping rather than a wrong name on a record.
 */
export function buildPunchIndex(users: SevenShiftsUser[]): BuiltPunchIndex {
  const index: PunchIndex = {};
  const seen = new Set<string>();
  const collisions = new Set<string>();

  for (const u of users) {
    const staff = staffFromUser(u);
    if (!staff) continue;
    if (seen.has(staff.punchId)) {
      collisions.add(staff.punchId);
      delete index[staff.punchId];
      continue;
    }
    seen.add(staff.punchId);
    index[staff.punchId] = staff;
  }

  return { index, collisions: [...collisions].sort(), size: Object.keys(index).length };
}
