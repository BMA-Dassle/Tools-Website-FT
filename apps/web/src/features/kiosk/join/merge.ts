/**
 * Pure merge logic: phone-joined guests → the kiosk's party roster.
 *
 * Dedupe is the load-bearing part. Person ids come in two flavors — the
 * 17-digit Office id and the SHORT Pandora id — and a member added via kiosk
 * lookup carries the 17-digit id in bmiPersonId while a phone-onboarded guest
 * carries the short id in BOTH fields (mirrors submitNew). So matching is
 * ANY-id-overlap across BOTH fields on BOTH sides, with a name+DOB fallback
 * for members that carry no ids yet.
 */
import type { PartyMember } from "~/features/booking";
import { newPartyMember } from "~/features/booking";
import type { JoinGuestPayload } from "./types";

function yearsFromIso(dobIso: string | undefined): number | null {
  if (!dobIso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dobIso);
  if (!m) return null;
  const dob = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const beforeBirthday =
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

function idsOf(p: { bmiPersonId?: string; pandoraPersonId?: string }): string[] {
  return [p.bmiPersonId, p.pandoraPersonId].filter(Boolean) as string[];
}

function nameKey(firstName: string, lastName?: string, dobIso?: string): string {
  return `${firstName.trim().toLowerCase()}|${(lastName ?? "").trim().toLowerCase()}|${dobIso ?? ""}`;
}

/** Build a roster PartyMember from a phone join. Adults-only is server-
 *  enforced; category/isMinor are still derived from the DOB defensively so a
 *  server bug can never corrupt heat-category logic. isBillingCustomer is
 *  NEVER set from a phone — the main contact stays a kiosk-side choice. */
export function guestToPartyMember(g: JoinGuestPayload): PartyMember {
  const years = yearsFromIso(g.dobIso);
  const base = newPartyMember({
    firstName: g.firstName,
    lastName: g.lastName || undefined,
    isNewRacer: g.isNewRacer,
    category: years !== null && years < 13 ? "junior" : "adult",
    isMinor: years !== null ? years < 18 : false,
    bmiPersonId: g.bmiPersonId,
    memberships: g.memberships,
    // Phone joins arrive waiver-signed; default true so the card renders
    // ready. An explicit false (shouldn't happen) keeps the Set-up path open.
    waiverValid: g.waiverValid ?? true,
    creditBalances: g.creditBalances,
    phone: g.phone,
    email: g.email,
    dobIso: g.dobIso,
  });
  // newPartyMember doesn't take pandoraPersonId — spread it on (the
  // established workaround; the short id is what waiver-sign accepts).
  return g.pandoraPersonId ? { ...base, pandoraPersonId: g.pandoraPersonId } : base;
}

export interface MergeResult {
  /** Brand-new people → dispatch addPartyMember. */
  toAdd: PartyMember[];
  /** Signer-only guardians who joined from a phone → promote onto the roster
   *  via the existing joinGuardian mechanics (same object id keeps minors'
   *  guardianMemberId refs valid). */
  promoteGuardians: PartyMember[];
  /** Existing party members who re-signed-in by phone → patch waiverValid
   *  true (+ the short Pandora id the phone resolved — the one waiver-sign
   *  accepts; NEVER the 17-digit bmiPersonId, which other flows rely on).
   *  Silent success, never a duplicate card. */
  alreadyPresent: Array<{ memberId: string; pandoraPersonId?: string }>;
}

export function mergeJoinedGuests(
  party: PartyMember[],
  guardians: PartyMember[],
  guests: JoinGuestPayload[],
): MergeResult {
  const toAdd: PartyMember[] = [];
  const promoteGuardians: PartyMember[] = [];
  const alreadyPresent: MergeResult["alreadyPresent"] = [];

  // In-batch claims so a double entry inside one poll can't add twice.
  const claimed = new Set<string>();
  // toAdd grows during the loop — matches must see it too.
  const matches = (
    p: {
      bmiPersonId?: string;
      pandoraPersonId?: string;
      firstName: string;
      lastName?: string;
      dobIso?: string;
    },
    gids: string[],
    gname: string,
  ) =>
    idsOf(p).some((id) => gids.includes(id)) ||
    nameKey(p.firstName, p.lastName, p.dobIso) === gname;

  for (const g of guests) {
    const gids = idsOf(g);
    const gname = nameKey(g.firstName, g.lastName, g.dobIso);
    if (gids.some((id) => claimed.has(id)) || claimed.has(gname)) continue;
    gids.forEach((id) => claimed.add(id));
    claimed.add(gname);

    const inParty = party.find((m) => matches(m, gids, gname));
    if (inParty) {
      alreadyPresent.push({ memberId: inParty.id, pandoraPersonId: g.pandoraPersonId });
      continue;
    }
    const asGuardian = guardians.find((m) => matches(m, gids, gname));
    if (asGuardian) {
      promoteGuardians.push(asGuardian);
      continue;
    }
    if (toAdd.some((m) => matches(m, gids, gname))) continue;
    toAdd.push(guestToPartyMember(g));
  }

  return { toAdd, promoteGuardians, alreadyPresent };
}
