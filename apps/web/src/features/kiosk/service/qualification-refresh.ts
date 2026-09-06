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
 *  - On-site deposits (Pandora DPS_OVERVIEW; cloud Office history as fallback)
 *                      → credit kinds + balances. Local-first because every
 *                      credit WRITE lands on-site and the cloud mirror lags
 *                      minutes behind — see fetchLiveCreditBalances below.
 *  - Pandora person  → waiverValid (waiverExpiry > now) + authoritative
 *                      birthdate (same read /api/pandora GET does).
 *
 * Every source is independent and fail-open: a member's row only carries the
 * fields that fetched successfully — the caller patches what came back and
 * keeps the snapshot for the rest. Person ids are raw digit strings end-to-end
 * (17-digit Office ids exceed Number.MAX_SAFE_INTEGER — never Number() them).
 */
import { fetchOfficePerson, fetchOfficeDepositHistory } from "@/lib/bmi-office-actions";
import { getDepositOverview } from "@/lib/pandora-deposits";
import { PANDORA_DEFAULT_LOCATION_ID, PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import { isRelevantMembership } from "~/features/booking/service/race-products";
import { hasActiveLicenseMembership } from "~/features/booking/service/license";
import {
  creditBalancesFromDeposits,
  creditBalancesFromOverview,
} from "~/features/booking/data/race-credits";

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
  licenseActive?: boolean;
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

/** Does this Office person hold an UNEXPIRED licence membership? One shared
 *  derivation for every surface — see hasActiveLicenseMembership. */
function hasActiveLicense(person: Record<string, unknown>): boolean {
  return hasActiveLicenseMembership(
    person.memberships as Array<{ name?: unknown; stops?: string }> | undefined,
  );
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
    if (!res.ok || !data?.success || !data.data) {
      // Correct already — null means the caller OMITS these fields rather than
      // asserting a false, which is why the purchase flow was the least damaged
      // of the readers. Logged so a null-birthdate person (this endpoint 500s
      // on them, and booking creates them that way) is findable rather than
      // just quietly missing their waiver + birthdate.
      console.warn(
        `[qualification-refresh] person ${personId} UNREADABLE (HTTP ${res.status}) — ` +
          `waiver/birthdate omitted; a null birthdate causes this and is repairable`,
      );
      return null;
    }
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
 * Credit balances — ON-SITE server first, cloud Office history as fallback.
 *
 * Credits are WRITTEN on-site (staff-page comps, pack grants — all Pandora
 * `addDeposit`), and the charge path validates against that same on-site
 * ledger; the cloud history only sees a deposit after BMI's on-site → cloud
 * sync, measured at 1.5–12 minutes (2026-09-05: staff re-granted comps
 * because nothing showed, every guest got doubles). Read the local ledger
 * with the same id precedence the write uses. Null = both reads failed
 * (caller omits the field — fail open, same as before).
 */
async function fetchLiveCreditBalances(
  m: QualificationRefreshMember,
  locationKey: string | undefined,
): Promise<Array<{ kind: string; balance: number }> | null> {
  const locationId =
    (locationKey && PANDORA_LOCATION_MAP[locationKey]) || PANDORA_DEFAULT_LOCATION_ID;
  try {
    return creditBalancesFromOverview(
      await getDepositOverview(m.pandoraPersonId || m.bmiPersonId, locationId),
    );
  } catch {
    const deposits = await fetchOfficeDepositHistory(m.bmiPersonId);
    return deposits ? creditBalancesFromDeposits(deposits) : null;
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
      const [person, creditBalances, waiver] = await Promise.all([
        fetchOfficePerson(m.bmiPersonId),
        fetchLiveCreditBalances(m, locationKey),
        // Waiver read on the id signatures land on (short Pandora id when
        // resolved) — see QualificationRefreshMember.pandoraPersonId.
        fetchWaiverStatus(m.pandoraPersonId || m.bmiPersonId, locationKey),
      ]);
      const row: QualificationRow = { id: m.id };
      if (person) {
        row.memberships = membershipsFromPerson(person);
        // Same read, one extra fact: is an UNEXPIRED licence on file? Explicit,
        // because the money path must not infer it from the filtered name list
        // (service/license.ts explains why).
        row.licenseActive = hasActiveLicense(person);
      }
      if (creditBalances) row.creditBalances = creditBalances;
      if (waiver) {
        row.waiverValid = waiver.waiverValid;
        if (waiver.birthdate) row.birthdate = waiver.birthdate;
      }
      return row;
    }),
  );
}
