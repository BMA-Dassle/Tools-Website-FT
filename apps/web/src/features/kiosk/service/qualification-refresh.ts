/**
 * Kiosk mid-session qualification refresh — SERVER SIDE.
 *
 * A party member's qualifications can change WHILE they stand at the kiosk:
 * the front desk sells them a license/membership (tier), a waiver gets signed
 * on a phone or at Guest Services, a race credit is granted or spent. The
 * sign-in snapshot (memberships / waiverValid / creditBalances captured by
 * ReturningRacerLookup + the people step) goes stale the moment any of that
 * happens — so the flow re-pulls the live values at step boundaries (owner
 * 2026-07-23: "recheck their qualifications as they go through the kiosk").
 *
 * Sources — the SAME ones the sign-in capture uses, so refreshed values are
 * shape-identical to the snapshot they replace:
 *  - Office person   → memberships (stops-filtered + isRelevantMembership),
 *                      exactly ReturningRacerLookup.fetchAccountDetails' filter.
 *  - Office deposits → creditBalancesFromDeposits (credit kinds + balances).
 *  - Pandora person  → waiverValid (waiverExpiry > now) + authoritative
 *                      birthdate (same read /api/pandora GET does).
 *
 * Every source is independent and fail-open: a member's row only carries the
 * fields that fetched successfully — the caller patches what came back and
 * keeps the snapshot for the rest. Person ids are raw digit strings end-to-end
 * (17-digit Office ids exceed Number.MAX_SAFE_INTEGER — never Number() them).
 */
import { fetchOfficePerson, fetchOfficeDepositHistory } from "@/lib/bmi-office-actions";
import { PANDORA_DEFAULT_LOCATION_ID, PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import { isRelevantMembership } from "~/features/booking/service/race-products";
import { creditBalancesFromDeposits } from "~/features/booking/data/race-credits";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";

export interface QualificationRefreshMember {
  /** The kiosk-local PartyMember id (echoed back so the client can patch). */
  id: string;
  /** BMI person id — 17-digit Office id or short Pandora id, raw digits. */
  bmiPersonId: string;
  /** SHORT Pandora id when the session has resolved one. Waivers are SIGNED
   *  against this id, so the waiver read must use it too — reading the
   *  17-digit Office id can hit a different record (duplicates exist; the
   *  Pandora create is not an upsert) and flip a freshly-signed member back
   *  to "needs a waiver" (2026-07-25 Strachan incident). */
  pandoraPersonId?: string;
}

export interface QualificationRow {
  id: string;
  /** Active, relevant membership names (tier/discount inputs). Absent = fetch failed. */
  memberships?: string[];
  /** Credit kinds + balances (same shape as the sign-in snapshot). Absent = fetch failed. */
  creditBalances?: Array<{ kind: string; balance: number }>;
  /** Live waiver validity. Absent = the Pandora read failed / person not found
   *  (never downgrade on a failed read). */
  waiverValid?: boolean;
  /** Authoritative BMI birthdate ("YYYY-MM-DD…"), when the record has one. */
  birthdate?: string;
}

/** Office person → active relevant membership names — byte-for-byte the filter
 *  ReturningRacerLookup applies at sign-in, so tier derivation matches. */
function membershipsFromPerson(person: Record<string, unknown>): string[] {
  const raw = person.memberships;
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ stops?: string; name?: string }>)
    .filter(
      (m) =>
        typeof m?.name === "string" &&
        (!m.stops || new Date(m.stops) > new Date()) &&
        isRelevantMembership(m.name),
    )
    .map((m) => m.name as string)
    .filter((n, i, a) => a.indexOf(n) === i);
}

/** Pandora person read → waiver validity + birthdate; null when the read
 *  failed or the person wasn't found (caller omits the fields — fail open). */
async function fetchWaiverStatus(
  personId: string,
  locationKey: string | undefined,
): Promise<{ waiverValid: boolean; birthdate?: string } | null> {
  const locationId =
    (locationKey && PANDORA_LOCATION_MAP[locationKey]) || PANDORA_DEFAULT_LOCATION_ID;
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${locationId}/${personId}?picture=false&allRelated=false`,
      {
        headers: { Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success || !data.data) return null;
    const person = data.data as { waiverExpiry?: string; birthdate?: string };
    const expiry = person.waiverExpiry ? new Date(person.waiverExpiry) : null;
    return {
      waiverValid: !!expiry && !Number.isNaN(expiry.getTime()) && expiry > new Date(),
      ...(person.birthdate ? { birthdate: String(person.birthdate) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Re-fetch live qualifications for each member. All members and all sources run
 * concurrently; each row carries only the fields whose fetch succeeded.
 */
export async function gatherQualifications(
  members: QualificationRefreshMember[],
  locationKey?: string,
): Promise<QualificationRow[]> {
  return Promise.all(
    members.map(async (m) => {
      const [person, deposits, waiver] = await Promise.all([
        fetchOfficePerson(m.bmiPersonId),
        fetchOfficeDepositHistory(m.bmiPersonId),
        // Waiver read on the id signatures land on (short Pandora id when
        // resolved) — see QualificationRefreshMember.pandoraPersonId.
        fetchWaiverStatus(m.pandoraPersonId || m.bmiPersonId, locationKey),
      ]);
      const row: QualificationRow = { id: m.id };
      if (person) row.memberships = membershipsFromPerson(person);
      if (deposits) row.creditBalances = creditBalancesFromDeposits(deposits);
      if (waiver) {
        row.waiverValid = waiver.waiverValid;
        if (waiver.birthdate) row.birthdate = waiver.birthdate;
      }
      return row;
    }),
  );
}
