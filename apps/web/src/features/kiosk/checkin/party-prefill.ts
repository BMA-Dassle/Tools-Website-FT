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
import { resolveRaceClass } from "./category";
import { isNicknameVariant, normalizeName } from "./roster-merge";

function fullNameOf(firstName: string, lastName?: string): string {
  return `${firstName ?? ""} ${lastName ?? ""}`.trim();
}
function nameKey(firstName: string, lastName?: string): string {
  return normalizeName(fullNameOf(firstName, lastName));
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
 * ready for `addPartyMember`. Race class comes from the row's birthdate (the
 * waiver read carries it) and is left UNSET when there is none — the people
 * step re-derives it for anyone who walks "Set up", but a racer who arrives
 * READY never does, and `resolveRaceClass` trusts an explicit category over
 * everything. The old blanket `category: "adult"` therefore stamped every
 * ready junior as an adult: the junior race listed nobody, "Add a Junior
 * racer" led back to a party that already had them, and re-adding was refused
 * as a duplicate (2026-09-11).
 */
export function prefillPartyMembers(
  party: PartyMember[],
  roster: CheckinPartyMember[],
): PartyMember[] {
  const out: PartyMember[] = [];
  const claimedIds = new Set(party.flatMap(memberIds));
  const claimedNames = new Set(party.map((m) => nameKey(m.firstName, m.lastName)));
  // Full names already on the party, for the nickname check below. A guest who
  // hand-typed "Tim Higgins" must not then be offered "TIMOTHY HIGGINS" from
  // the booking as a second person (W57387 — both cards showed on the kiosk).
  const claimedFullNames = party.map((m) => fullNameOf(m.firstName, m.lastName));

  // IDENTIFIED ROWS FIRST. The loop below claims a name for whoever reaches it
  // first, so with the raw order an id-less duplicate ("eric OSBORN", typed at
  // booking) could claim the name and the real BMI person be skipped — the
  // W57387 shadowing, one layer down. The server already merges its own rows,
  // but this function also runs over `mergeRosters` output (several vouchers on
  // one booking), where a same-human duplicate can still arrive. Stable sort:
  // relative order is otherwise untouched.
  const ordered = [...roster].sort((a, b) => (a.bmiPersonId ? 0 : 1) - (b.bmiPersonId ? 0 : 1));

  for (const r of ordered) {
    const name = nameKey(r.firstName, r.lastName);
    const full = fullNameOf(r.firstName, r.lastName);
    if (r.bmiPersonId && claimedIds.has(r.bmiPersonId)) continue;
    if (claimedNames.has(name)) continue;
    if (claimedFullNames.some((c) => isNicknameVariant(c, full))) continue;
    if (r.bmiPersonId) claimedIds.add(r.bmiPersonId);
    claimedNames.add(name);
    claimedFullNames.push(full);
    out.push(
      newPartyMember({
        firstName: r.firstName,
        lastName: r.lastName || undefined,
        isNewRacer: false,
        category: resolveRaceClass({ dobIso: r.dobIso }) ?? undefined,
        ...(r.dobIso ? { dobIso: r.dobIso } : {}),
        ...(r.bmiPersonId ? { bmiPersonId: r.bmiPersonId } : {}),
        waiverValid: r.waiverValid,
      }),
    );
  }
  return out;
}
