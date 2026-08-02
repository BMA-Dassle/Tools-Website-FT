/**
 * "Who's here from your booking?" — the voucher receipt's party chips.
 *
 * A reservation-linked voucher (vouchers.bill_id, stamped at mint for booking
 * grants) resolves to its party via the check-in lookup rail (possession =
 * proof — same posture as the emailed reservation QR). This module is the
 * receipt's pure half, extracted so the decisions are testable logic instead
 * of JSX conditionals (the receipt-plan.ts precedent): merge every scanned
 * voucher's roster into one chip list, and answer what a chip tap should do
 * against session truth.
 *
 * Matching MUST mirror prefillPartyMembers (id overlap first, name-key
 * fallback) so a chip that reads "selected" is exactly a person prefill would
 * add nothing for — the round-trip test locks the two together.
 */
import type { CheckinPartyMember } from "../checkin/types";
import { isPlaceholderRacerName } from "../checkin/party-prefill";

export interface VoucherPartyPerson {
  /** Chip identity + the addedIds key: bmiPersonId, else `name:{first|last}`.
   *  Stable for the person's lifetime — a later roster upgrading an id-less
   *  row never re-keys it, so the receipt's added-by-me tracking survives. */
  key: string;
  firstName: string;
  lastName?: string;
  /** 17-digit BMI Office id as a STRING — never parsed numerically. */
  bmiPersonId?: string;
  /** Live waiver truth from the party route; ORed across duplicate rows. */
  waiverValid: boolean;
}

/** The structural slice of PartyMember the chip matcher needs. */
export interface PartyMemberLike {
  id: string;
  firstName: string;
  lastName?: string;
  bmiPersonId?: string;
  pandoraPersonId?: string;
}

function nameKey(firstName: string, lastName?: string): string {
  return `${firstName.trim().toLowerCase()}|${(lastName ?? "").trim().toLowerCase()}`;
}

/**
 * Union of every scanned voucher's roster, one chip per person: dedupe by
 * bmiPersonId first, name-key fallback (case/whitespace-insensitive),
 * first-seen order. Two vouchers from the same booking collapse to one chip
 * set; different bookings union. waiverValid ORs across duplicates and an
 * id-bearing duplicate upgrades an id-less first sighting (without re-keying
 * it). Placeholder slot labels ("Adult 1") are dropped defensively — the
 * party route already filters them, but a chip must never offer a slot label
 * as a person.
 */
export function mergeRosters(
  rostersByCode: Record<string, CheckinPartyMember[]>,
): VoucherPartyPerson[] {
  const out: VoucherPartyPerson[] = [];
  const byId = new Map<string, VoucherPartyPerson>();
  const byName = new Map<string, VoucherPartyPerson>();
  for (const roster of Object.values(rostersByCode)) {
    for (const r of roster) {
      const firstName = r.firstName?.trim();
      if (!firstName) continue;
      const lastName = r.lastName?.trim() || undefined;
      if (isPlaceholderRacerName([firstName, lastName].filter(Boolean).join(" "))) continue;
      const nk = nameKey(firstName, lastName);
      const existing = (r.bmiPersonId ? byId.get(r.bmiPersonId) : undefined) ?? byName.get(nk);
      if (existing) {
        existing.waiverValid = existing.waiverValid || r.waiverValid;
        if (r.bmiPersonId && !existing.bmiPersonId) {
          existing.bmiPersonId = r.bmiPersonId; // upgrade; key stays stable
          byId.set(r.bmiPersonId, existing);
        }
        continue;
      }
      const person: VoucherPartyPerson = {
        key: r.bmiPersonId ?? `name:${nk}`,
        firstName,
        ...(lastName ? { lastName } : {}),
        ...(r.bmiPersonId ? { bmiPersonId: r.bmiPersonId } : {}),
        waiverValid: r.waiverValid,
      };
      if (r.bmiPersonId) byId.set(r.bmiPersonId, person);
      byName.set(nk, person);
      out.push(person);
    }
  }
  return out;
}

/**
 * What a chip tap may do, judged against session truth:
 *   idle     — not on the party; tap adds them (via prefillPartyMembers).
 *   added    — on the party AND this selector put them there; tap removes.
 *   in-group — on the party from elsewhere (hand-added, check-in prefill, or
 *              tracking lost to a remount): pre-selected and UN-removable —
 *              removePartyMember cascade-clears heat/attraction assignments,
 *              so a chip must never remove someone it didn't add.
 *
 * `addedIds` maps person.key → the PartyMember.id this selector added.
 */
export function personChipState(
  person: VoucherPartyPerson,
  party: readonly PartyMemberLike[],
  addedIds: Readonly<Record<string, string>>,
): { state: "idle" | "added" | "in-group"; memberId?: string } {
  const nk = nameKey(person.firstName, person.lastName);
  const match = party.find(
    (m) =>
      (person.bmiPersonId !== undefined &&
        (m.bmiPersonId === person.bmiPersonId || m.pandoraPersonId === person.bmiPersonId)) ||
      nameKey(m.firstName, m.lastName) === nk,
  );
  if (!match) return { state: "idle" };
  return addedIds[person.key] === match.id
    ? { state: "added", memberId: match.id }
    : { state: "in-group", memberId: match.id };
}
