/**
 * Voucher-QR party prefill — pure merge of a proven reservation's bind-ready
 * roster into the kiosk's session.party.
 *
 * Dedupe mirrors join/merge.ts (the mobile-join precedent): any-id overlap
 * first, name-key fallback for rows without ids — so tapping "Load your
 * party" twice, or loading after someone already signed in by phone, never
 * duplicates a person. Members arrive with a LIVE-verified waiver status;
 * anyone lapsed still walks the waiver step (prefill removes typing, not
 * waivers).
 */
import type { PartyMember } from "~/features/booking";
import { newPartyMember } from "~/features/booking";
import type { CheckinPartyMember } from "./types";

function nameKey(firstName: string, lastName?: string): string {
  return `${firstName.trim().toLowerCase()}|${(lastName ?? "").trim().toLowerCase()}`;
}

/**
 * Category placeholder labels minted by count-based booking ("Adult 1",
 * "Junior 3" — web RacePartyStep's setNewRacerCount): slot labels, not names.
 * They must never be offered as prefill people — the "Who's racing?" step
 * assigns real people to those open slots instead. (2026-07-31: a booking's
 * "Adult 1"/"Adult 2" labels ended up as the names on BMI's people list.)
 */
export function isPlaceholderRacerName(name: string): boolean {
  return /^(adult|junior)\s+\d+$/i.test(name.trim());
}

function memberIds(p: { bmiPersonId?: string; pandoraPersonId?: string }): string[] {
  return [p.bmiPersonId, p.pandoraPersonId].filter(Boolean) as string[];
}

/**
 * The roster members NOT already on the party, converted to PartyMembers
 * ready for `addPartyMember`. Category defaults to adult — the original
 * booking doesn't carry DOBs, and the waiver/people step re-derives minors
 * exactly as it does for hand-added guests.
 */
export function prefillPartyMembers(
  party: PartyMember[],
  roster: CheckinPartyMember[],
): PartyMember[] {
  const out: PartyMember[] = [];
  const claimedIds = new Set(party.flatMap(memberIds));
  const claimedNames = new Set(party.map((m) => nameKey(m.firstName, m.lastName)));

  for (const r of roster) {
    const name = nameKey(r.firstName, r.lastName);
    if (r.bmiPersonId && claimedIds.has(r.bmiPersonId)) continue;
    if (claimedNames.has(name)) continue;
    if (r.bmiPersonId) claimedIds.add(r.bmiPersonId);
    claimedNames.add(name);
    out.push(
      newPartyMember({
        firstName: r.firstName,
        lastName: r.lastName || undefined,
        isNewRacer: false,
        category: "adult",
        ...(r.bmiPersonId ? { bmiPersonId: r.bmiPersonId } : {}),
        waiverValid: r.waiverValid,
      }),
    );
  }
  return out;
}
