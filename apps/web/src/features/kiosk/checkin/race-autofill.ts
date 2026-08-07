/**
 * "Who's racing?" auto-fill — pre-assign the races the kiosk can work out on
 * its own, so the common case is a confirmation rather than N decisions.
 *
 * Owner 2026-08-07: "when the party and the races line up, fill them in, show
 * it, and let them change it." Two hard limits on that, because a wrong guess
 * puts the wrong person on the grid and the guest may never notice:
 *
 *  1. NEVER guess who is left out. If a category has MORE eligible racers than
 *     seats, the kiosk cannot know which of them is racing — leave every slot
 *     in that category blank and make the guest choose.
 *  2. NEVER produce an arrangement a manual pick would refuse. Every assignment
 *     is checked against the same heat-spacing predicate the picker uses, so
 *     auto-fill can only ever reach a state the guest could have reached by hand.
 *
 * Round-robin, not one-per-person: a 6-racer booking across two heats is 12
 * seats, and each racer legitimately takes one seat in each heat (W57387).
 */
import type { CheckinRaceSlot } from "./types";

export interface AutoFillMember {
  id: string;
  /** Resolved race class; null = unknown, which is never auto-assigned. */
  category: "adult" | "junior" | null;
}

export interface AutoFillArgs {
  /** Open slots, in display order (which is heat order). */
  slots: CheckinRaceSlot[];
  /** Ready members only — an unready racer must never be seated. */
  members: AutoFillMember[];
  /** The picker's own spacing rule; true when the two slots are too close. */
  conflicts: (a: CheckinRaceSlot, b: CheckinRaceSlot) => boolean;
}

/**
 * slotKey → memberId for every race the kiosk can fill unambiguously. Slots it
 * declines to guess are simply absent, so the caller can merge this over an
 * existing assignMap without clobbering a guest's own choices.
 */
export function autoAssignRaces({
  slots,
  members,
  conflicts,
}: AutoFillArgs): Record<string, string> {
  const out: Record<string, string> = {};
  const heldBy = new Map<string, CheckinRaceSlot[]>();

  for (const category of ["adult", "junior"] as const) {
    const catSlots = slots.filter((s) => s.category === category);
    const eligible = members.filter((m) => m.category === category);
    if (catSlots.length === 0 || eligible.length === 0) continue;
    // More racers than seats — genuinely ambiguous. Don't pick favourites.
    if (eligible.length > catSlots.length) continue;

    let cursor = 0;
    for (const slot of catSlots) {
      // Try each racer once, starting where the rotation left off, so seats
      // spread across the party instead of stacking on the first person.
      let placed = false;
      for (let i = 0; i < eligible.length && !placed; i++) {
        const m = eligible[(cursor + i) % eligible.length];
        const held = heldBy.get(m.id) ?? [];
        if (held.some((h) => conflicts(h, slot))) continue;
        out[slot.slotKey] = m.id;
        heldBy.set(m.id, [...held, slot]);
        cursor = (cursor + i + 1) % eligible.length;
        placed = true;
      }
      // Nobody can legally take this seat — leave it for the guest.
    }
  }
  return out;
}
