"use client";

/**
 * Client side of the kiosk license lookup: POST the scanned last name + DOB to
 * /api/kiosk/license-lookup and map matches onto ReturningRacerLookup's
 * PersonData so the existing sign-in rail (handleVerified → importLinked)
 * consumes them unchanged.
 *
 * Return contract: `[]` = the lookup RAN and found nobody (open the prefilled
 * new-player form); `null` = the lookup was UNAVAILABLE (network/upstream) —
 * surfaces also fall back to the form, never blocking the guest.
 */
import type { PersonData } from "~/components/features/booking/steps/race/ReturningRacerLookup";
import type { AamvaLicense, MemberQr } from "../qr-scanner";
import type { LicenseMatch } from "./types";

/** The identity fields the lookup needs — a license carries them, and so does
 *  a typed New Member / Set up form (the search-before-create gate). */
export interface NameDobConfirm {
  lastName: string;
  dobIso: string;
  /** Ranking only — never filters (see lookup.server.ts). */
  firstName?: string;
}

export async function fetchNameDobMatches(
  confirm: NameDobConfirm,
  location: "fasttrax" | "headpinz" | "naples",
): Promise<LicenseMatch[] | null> {
  try {
    const res = await fetch("/api/kiosk/license-lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastName: confirm.lastName,
        firstName: confirm.firstName,
        dobIso: confirm.dobIso,
        location,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; matches?: LicenseMatch[] };
    return data.ok && Array.isArray(data.matches) ? data.matches : null;
  } catch {
    return null;
  }
}

export async function fetchLicenseMatches(
  license: AamvaLicense,
  location: "fasttrax" | "headpinz" | "naples",
): Promise<LicenseMatch[] | null> {
  return fetchNameDobMatches(
    { lastName: license.lastName, firstName: license.firstName, dobIso: license.dobIso },
    location,
  );
}

/** SMS-Timing member QR (the app's personal QR) → the member's account(s).
 *  Same return contract as fetchLicenseMatches. */
export async function fetchMemberMatches(qr: MemberQr): Promise<LicenseMatch[] | null> {
  try {
    const res = await fetch("/api/kiosk/license-lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberCode: qr.code, memberClientKey: qr.clientKey }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; matches?: LicenseMatch[] };
    return data.ok && Array.isArray(data.matches) ? data.matches : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget cold-start absorber — call when a scan-capable screen
 *  mounts so the guest's first real scan doesn't pay Pandora's Azure spin-up
 *  (~5–25 s after idle). Failures are irrelevant; the real lookup retries. */
export function prewarmLicenseLookup(location: "fasttrax" | "headpinz" | "naples"): void {
  void fetch("/api/kiosk/license-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ warm: true, location }),
  }).catch(() => {});
}

/** A matched account as the existing onVerified/handleVerified rail expects.
 *  `phoneVerified` is deliberately never set — the license proves identity,
 *  not phone possession (rewards' SMS verify must still run). */
export function personDataFromMatch(m: LicenseMatch): PersonData {
  return {
    personId: m.personId,
    fullName: m.fullName,
    email: m.email,
    phone: m.phone || undefined,
    races: m.races,
    loginCode: m.loginCode,
    memberships: m.memberships,
    birthDate: m.birthDate,
    creditBalances: m.creditBalances,
    // Absent since the Office-search rewrite — handleVerified then runs the
    // same "Checking waiver…" → importLinked resolution the OTP path uses.
    ...(typeof m.waiverValid === "boolean" ? { waiverValid: m.waiverValid } : {}),
  };
}
