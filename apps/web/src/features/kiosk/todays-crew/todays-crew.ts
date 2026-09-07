/**
 * Today's Crew — the pure rules (owner 2026-09-06). Shared by the server read,
 * the client hook and BOTH people components so nothing about who is offered,
 * when the sheet pops, or how the pill reads can drift between screens.
 */
import type { CoBookedRow, CrewStatus } from "./types";

/** The most co-bookers we ever offer. A 40-seat corporate booking is not a
 *  crew; the sheet is two columns of tappable cards and a dozen is the most
 *  that reads as "pick your friends" rather than a directory. */
export const CREW_CAP = 12;

export interface CoBookedPerson {
  bmiPersonId: string;
  name: string;
  category: "adult" | "junior" | null;
  kind: string;
  /** Earliest shared slot. */
  slot: string;
  waiverValid: boolean | null;
}

/**
 * One entry per person from the raw self-join rows: the EARLIEST shared slot
 * wins (that is the one the guest remembers — "we raced at 8"), a known class
 * or waiver flag beats an unknown one, sorted by that slot then name, capped.
 * Rows without a person id are dropped — nobody can be signed in on a name.
 */
export function dedupeCoBooked(
  rows: readonly CoBookedRow[],
  cap: number = CREW_CAP,
): CoBookedPerson[] {
  const byId = new Map<string, CoBookedPerson>();
  for (const r of rows) {
    if (!r.bmiPersonId || !/^\d+$/.test(r.bmiPersonId)) continue;
    const have = byId.get(r.bmiPersonId);
    if (!have) {
      byId.set(r.bmiPersonId, {
        bmiPersonId: r.bmiPersonId,
        name: r.name?.trim() ?? "",
        category: r.category,
        kind: r.kind,
        slot: r.slot,
        waiverValid: r.waiverValid,
      });
      continue;
    }
    if (r.slot < have.slot) {
      have.slot = r.slot;
      have.kind = r.kind;
    }
    if (!have.category && r.category) have.category = r.category;
    if (have.waiverValid === null && r.waiverValid !== null) have.waiverValid = r.waiverValid;
    // A full name beats a first name — attractions record "First Last".
    if (r.name && r.name.trim().split(/\s+/).length > have.name.split(/\s+/).length) {
      have.name = r.name.trim();
    }
  }
  // DUPLICATE PERSON RECORDS are a fact of the CRM (probed 2026-09-06: one web
  // group carried "Ryan Jones" under two ids — the check-in bound one, the
  // online waiver joined the other). Same FULL name → one entry, preferring
  // the record a kiosk check-in verified today, then the earliest slot. A
  // first-name-only entry is never collapsed: two "Daniel"s in a big group
  // are two people until proven otherwise.
  const byName = new Map<string, CoBookedPerson>();
  const out: CoBookedPerson[] = [];
  for (const p of byId.values()) {
    const key = fullNameKey(p.name);
    if (!key) {
      out.push(p);
      continue;
    }
    const have = byName.get(key);
    if (!have) {
      byName.set(key, p);
      out.push(p);
      continue;
    }
    if (preferCoBooked(p, have)) {
      out[out.indexOf(have)] = p;
      byName.set(key, p);
    }
  }
  return out
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.name.localeCompare(b.name)))
    .slice(0, cap);
}

/** "first last" lowercased — or null when there is no last name to match on. */
export function fullNameKey(name: string): string | null {
  const parts = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts.join(" ") : null;
}

/** Between two records of the same person: the one a check-in verified today
 *  wins; otherwise the earlier slot; otherwise keep what we had. */
function preferCoBooked(candidate: CoBookedPerson, current: CoBookedPerson): boolean {
  const c = candidate.kind === "checkin" ? 1 : 0;
  const h = current.kind === "checkin" ? 1 : 0;
  if (c !== h) return c > h;
  return candidate.slot < current.slot;
}

/**
 * The signed-in guest can appear in their OWN crew under a duplicate record —
 * a second person id with the same name (the online waiver joined one, the
 * kiosk bound the other). Drop anyone whose full name matches someone already
 * on the roster; ids were already excluded by the caller.
 */
export function withoutRosterNames<T extends { firstName: string; lastName: string }>(
  crew: readonly T[],
  roster: ReadonlyArray<{ firstName: string; lastName?: string }>,
): T[] {
  const taken = new Set(
    roster
      .map((m) => fullNameKey(`${m.firstName} ${m.lastName ?? ""}`))
      .filter((k): k is string => k !== null),
  );
  if (taken.size === 0) return [...crew];
  return crew.filter((c) => {
    const key = fullNameKey(`${c.firstName} ${c.lastName}`);
    return key === null || !taken.has(key);
  });
}

/** "First Last Name" → { first, last }. A lone token is a first name. */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  const [first, ...rest] = parts;
  return { first, last: rest.join(" ") };
}

/**
 * What the pill on the member card should be doing.
 *   "pending" — the lookup is in flight: draw the dimmed spinner pill NOW, so
 *               the row never gains a pill out of nowhere (owner 2026-09-06).
 *   "live"    — un-added co-bookers exist: the tappable pill.
 *   "hidden"  — nothing to show (never asked, nobody found, everyone added,
 *               or the read failed).
 */
export function crewPillState(
  status: CrewStatus,
  unaddedCount: number,
): "pending" | "live" | "hidden" {
  if (status === "loading") return "pending";
  if (unaddedCount > 0) return "live";
  return "hidden";
}

/**
 * Should the sheet open ITSELF when a lookup lands? Once per signed-in member
 * per session, only when it found someone, only when the screen is not already
 * showing another overlay (a lookup, a form, a licence picker, the split-payment
 * warning, the family sheet…), and only on screens that asked for it — the
 * check-in roster and the waiver flow get the pill but never the pop-up.
 */
export function shouldAutoOpenCrew(input: {
  count: number;
  overlayOpen: boolean;
  alreadyOffered: boolean;
  enabled: boolean;
}): boolean {
  const { count, overlayOpen, alreadyOffered, enabled } = input;
  return enabled && count > 0 && !overlayOpen && !alreadyOffered;
}

/**
 * "8:00 PM" / "8:00 p. m." from a slot string's wall-clock HH:MM. BMI heat ids
 * and attraction slots are ET wall-clock ISO strings; reading the digits keeps
 * the label right whatever timezone the browser thinks it is in.
 */
export function slotTimeLabel(slot: string, locale: "en" | "es"): string | null {
  const m = /T(\d{2}):(\d{2})/.exec(slot);
  if (!m) return null;
  const h24 = Number(m[1]);
  const mm = m[2];
  if (!Number.isFinite(h24) || h24 > 23) return null;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const pm = h24 >= 12;
  if (locale === "es") return `${h12}:${mm} ${pm ? "p. m." : "a. m."}`;
  return `${h12}:${mm} ${pm ? "PM" : "AM"}`;
}
