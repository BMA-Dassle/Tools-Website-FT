/**
 * Kiosk mid-session qualification refresh — CLIENT SIDE.
 *
 * Fetches live qualifications for the party (POST /api/kiosk/refresh-
 * qualifications) and turns each row into a FIELD-SCOPED PartyMember patch for
 * dispatch({type:"updatePartyMember"}). Field-scoped matters: the mobile-join
 * poll patches the same members concurrently, and the reducer is a shallow
 * per-member merge — patching only the refreshed fields means concurrent
 * writers can never clobber each other's unrelated fields.
 *
 * NEVER patched here (codified in the mobile-join onGuests handler):
 *  - bmiPersonId       — the 17-digit lookup id must never be overwritten
 *  - isNewRacer        — flow-derived, no endpoint can recompute it
 *  - phoneVerified / redeemCredits / guardianMemberId — session/flow state
 *
 * FAIL-OPEN: any transport/server trouble returns an empty map — the flow
 * proceeds on the sign-in snapshot, exactly as it did before this existed.
 */
import type { PartyMember } from "~/features/booking";
import { ageFromIso } from "../join/phone/join-helpers";

/** Server row shape (mirrors QualificationRow in qualification-refresh.ts). */
interface RefreshRow {
  id: string;
  memberships?: string[];
  licenseActive?: boolean;
  creditBalances?: Array<{ kind: string; balance: number }>;
  waiverValid?: boolean;
  birthdate?: string;
}

export interface QualificationPatch {
  memberships?: string[];
  licenseActive?: boolean;
  creditBalances?: Array<{ kind: string; balance: number }>;
  waiverValid?: boolean;
  dobIso?: string;
  isMinor?: boolean;
  category?: "adult" | "junior";
}

/** One refreshed row → a field-scoped patch. Pure (unit-tested). Only fields
 *  the server actually returned land in the patch; birthdate additionally
 *  derives dobIso/isMinor/category the same way the people step does. */
export function buildQualificationPatch(row: RefreshRow): QualificationPatch {
  const patch: QualificationPatch = {};
  if (Array.isArray(row.memberships)) patch.memberships = row.memberships;
  if (typeof row.licenseActive === "boolean") patch.licenseActive = row.licenseActive;
  if (Array.isArray(row.creditBalances)) patch.creditBalances = row.creditBalances;
  if (typeof row.waiverValid === "boolean") patch.waiverValid = row.waiverValid;
  if (row.birthdate) {
    const iso = String(row.birthdate).slice(0, 10);
    const age = ageFromIso(iso);
    if (age !== null) {
      patch.dobIso = iso;
      patch.isMinor = age < 18;
      patch.category = age < 13 ? "junior" : "adult";
    }
  }
  return patch;
}

/**
 * Refresh qualifications for every party member that has a BMI person id.
 * Returns memberId → patch (members whose refresh returned nothing are absent).
 * Never throws; an empty map means "nothing learned — keep the snapshot".
 */
export async function refreshQualifications(
  party: PartyMember[],
  location: string,
): Promise<Map<string, QualificationPatch>> {
  const members = party
    .filter((m) => m.bmiPersonId)
    .map((m) => ({
      id: m.id,
      bmiPersonId: m.bmiPersonId as string,
      // Waivers are SIGNED against the short Pandora id — the server reads
      // waiver validity on it so a fresh signature is never missed by reading
      // a duplicate/Office record instead (2026-07-25 incident).
      ...(m.pandoraPersonId ? { pandoraPersonId: m.pandoraPersonId } : {}),
    }));
  if (members.length === 0) return new Map();
  try {
    const res = await fetch("/api/kiosk/refresh-qualifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location, members }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return new Map();
    const data = (await res.json()) as { members?: RefreshRow[] };
    const out = new Map<string, QualificationPatch>();
    for (const row of data.members ?? []) {
      if (!row?.id) continue;
      const patch = buildQualificationPatch(row);
      if (Object.keys(patch).length > 0) out.set(row.id, patch);
    }
    return out;
  } catch {
    return new Map(); // fail open — the snapshot still stands
  }
}
