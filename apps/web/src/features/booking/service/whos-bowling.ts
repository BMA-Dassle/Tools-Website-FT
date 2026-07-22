/**
 * Shared "Who's bowling?" roster logic — the pure, presentation-free core of
 * the bowling people step, used by BOTH the kiosk step
 * (features/kiosk/steps/KioskBowlingPeopleStep) and the responsive Play Now
 * step (components/features/booking/steps/bowling/WhosBowlingStep).
 *
 * Bowling/duckpin are waiver-EXEMPT, so a bowler is just a name; ONE person is
 * tapped as the main contact (they also give email + mobile). These helpers own
 * the name<->row mapping and the advance gate so the two surfaces can never
 * drift. Name CASE normalization lives in ~/lib/helpers/name-format
 * (formatPersonName / normalizeEmail) — already single-sourced — so it is NOT
 * duplicated here.
 */
import type { BookingSession, BowlingItem, PartyMember } from "../state/types";

/** One bowling roster row (mirrors BowlingItem.players[] so the two can't drift). */
export type BowlPlayer = NonNullable<BowlingItem["players"]>[number];

/** The item's rows, or a single blank row when none exist yet (walk-up default). */
export function playersOf(item: Pick<BowlingItem, "players">): BowlPlayer[] {
  const p = item.players ?? [];
  return p.length > 0 ? p : [{ name: "", shoeSize: null, bumpers: null }];
}

/** Split a stored "First Last" name into its two editable fields. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

/** A party member's display name ("First Last"), trimmed. */
export function fullNameOf(m: PartyMember): string {
  return `${m.firstName} ${m.lastName ?? ""}`.trim();
}

/** A party member's bowling row — name mirrors the roster, details come later. */
export function rowOf(m: PartyMember): BowlPlayer {
  return { name: fullNameOf(m), shoeSize: null, bumpers: null, memberId: m.id };
}

/**
 * The advance gate for the people step: at least one named bowler, and the main
 * contact has a full name + email + a 10-digit mobile. Identical semantics on
 * kiosk and phone. (Extracted verbatim from KioskBowlingPeopleStep 2026-07-22.)
 */
export function whosBowlingCanAdvance(
  item: Pick<BowlingItem, "players">,
  session: Pick<BookingSession, "party" | "contact">,
): true | { reason: string } {
  const players = item.players ?? [];
  if (players.length === 0) {
    return {
      reason:
        session.party.length > 0
          ? "Tap at least one bowler — or add a bowler."
          : "Add a first name for every bowler.",
    };
  }
  if (players.some((p) => !splitName(p.name).firstName)) {
    return { reason: "Add a first name for every bowler." };
  }
  const c = session.contact;
  if (!c.firstName?.trim() || !c.lastName?.trim()) {
    return { reason: "The main person needs a first and last name." };
  }
  if (!c.email?.includes("@")) return { reason: "The main person needs an email." };
  if ((c.phone ?? "").replace(/\D/g, "").length < 10) {
    return { reason: "The main person needs a mobile number." };
  }
  return true;
}
