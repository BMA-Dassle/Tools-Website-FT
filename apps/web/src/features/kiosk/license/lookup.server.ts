/**
 * Kiosk driver's-license lookup — server side. Given the last name + DOB read
 * off a scanned license (AAMVA PDF417), find the guest's existing account so
 * the kiosk can sign them in without typing (owner 2026-07-23: the physical ID
 * is the identity proof; a match on BOTH exact last name AND exact birthdate
 * is knowledge only the cardholder has, so this is OTP-equivalent trust for
 * walk-up purposes — `phoneVerified` is never set by this path).
 *
 * Pipeline:
 *   1. BMI Office `search/person?token=<lastName>` (same client key as
 *      /api/bmi-office) → candidate hits, pre-filtered by whole-word last-name
 *      match on the description and deduped/ranked by the shared rules in
 *      features/booking/service/office-search.ts.
 *   2. Per candidate: the PANDORA person GET (`picture=false`,
 *      `allRelated=false` — the fast shape) supplies the authoritative
 *      birthdate + lastName for the match test (owner: "use the Pandora
 *      lookup, no picture needed"; Office records often LACK a birthdate —
 *      see the 2026-07-23 guardian-age lesson).
 *   3. Matches only (typically 0–3): Office person detail + deposit history
 *      build the same FoundAccount shape ReturningRacerLookup produces, so the
 *      kiosk reuses the existing account cards + handleVerified rail.
 *
 * BMI ID precision: every upstream body is parsed via parseWithRawIds
 * (officeGet does it internally; the Pandora fetch here does it explicitly) —
 * NEVER res.json() these responses.
 */
import { parseWithRawIds, BMI_ID_FIELDS } from "@ft/db";
import { fetchPersonRaw, officeGet, OfficeApiError } from "~/features/daily-events/data/bmi-office";
import {
  descriptionMatchesLastName,
  rankSearchResults,
  type SearchCandidate,
} from "~/features/booking/service/office-search";
import { isRelevantMembership } from "~/features/booking/service/race-products";
import { creditBalancesFromDeposits } from "~/features/booking/data/race-credits";
import { resolvePandoraLocation } from "@/lib/pandora-locations";
import type { LicenseMatch } from "./types";

// Same key + default as app/api/bmi-office/route.ts — one Office DB serves
// both brands (racing/waiver accounts live in the FastTrax BMI).
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";

/** Search hits are cheap; Pandora probes are not — cap the fan-out. A common
 *  last name easily returns dozens of distinct people; the DOB filter below
 *  reduces them to ~0–3, so probing the 25 most recently seen is plenty. */
const MAX_PANDORA_PROBES = 25;

export interface LicenseLookupInput {
  lastName: string;
  /** "YYYY-MM-DD" from the license's DBB element. */
  dobIso: string;
  /** Ranking signal only (nicknames: license "ALEXANDER" vs account "Alex"). */
  firstName?: string;
  /** Pandora center key ("fasttrax" | "headpinz" | "naples"). */
  location?: string;
}

export type { LicenseMatch } from "./types";

interface PandoraLite {
  firstName: string;
  lastName: string;
  birthdate: string | null;
  waiverValid: boolean;
  email: string;
  phone: string;
}

/** Pandora person GET, picture=false — the fields the match test needs. */
async function pandoraPersonLite(personId: string, location?: string): Promise<PandoraLite | null> {
  const locationId = resolvePandoraLocation(location);
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${locationId}/${personId}?picture=false&allRelated=false`,
      {
        headers: { Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}` },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = parseWithRawIds<{
      success?: boolean;
      data?: Record<string, unknown>;
    }>(await res.text(), BMI_ID_FIELDS);
    if (!res.ok || !body?.success || !body.data) return null;
    const p = body.data;
    const waiverExpiry = p.waiverExpiry ? new Date(String(p.waiverExpiry)) : null;
    return {
      firstName: String(p.firstName ?? ""),
      lastName: String(p.lastName ?? ""),
      birthdate: p.birthdate ? String(p.birthdate).slice(0, 10) : null,
      waiverValid: !!waiverExpiry && waiverExpiry > new Date(),
      // Same field-name tolerance as app/api/pandora/route.ts.
      email: String(p.email ?? p.emailAddress ?? ""),
      phone: String(p.phoneNumber ?? p.phone ?? p.mobile ?? p.cellPhone ?? ""),
    };
  } catch {
    return null; // one bad probe must not sink the lookup
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/** Loose given-name affinity for RANKING (never filtering): exact, or one is
 *  a prefix of the other ("alex" ↔ "alexander"). */
function firstNameAffinity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 2;
  if (x.startsWith(y) || y.startsWith(x)) return 1;
  return 0;
}

interface OfficePerson {
  id?: unknown;
  firstName?: string;
  name?: string;
  birthDate?: string | null;
  lastLineUp?: string | null;
  tags?: Array<{ tag?: string; lastSeen?: string }>;
  memberships?: Array<{ name: string; stops?: string | null }>;
  addresses?: Array<{ email?: string; phone?: string }>;
}

/** Office person detail + deposits → the FoundAccount shape (same field
 *  derivations as ReturningRacerLookup.fetchAccountDetails). */
async function buildMatch(
  candidate: SearchCandidate,
  pandora: PandoraLite,
): Promise<LicenseMatch | null> {
  try {
    const p = await fetchPersonRaw<OfficePerson>(CLIENT_KEY, candidate.localId);
    const tags = (p.tags || []).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
    const memberships = (p.memberships || [])
      .filter((m) => (!m.stops || new Date(m.stops) > new Date()) && isRelevantMembership(m.name))
      .map((m) => m.name)
      .filter((n, i, a) => a.indexOf(n) === i);

    let creditBalances: LicenseMatch["creditBalances"] = [];
    try {
      const now = new Date();
      const from = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate())
        .toISOString()
        .split(".")[0];
      const until = now.toISOString().split(".")[0];
      const deposits = await officeGet<
        Array<{ depositKind?: string | null; balance?: number | null }>
      >(
        CLIENT_KEY,
        `deposit/history?personId=${candidate.localId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`,
      );
      creditBalances = creditBalancesFromDeposits(deposits);
    } catch {
      /* non-fatal — the account still signs in without credit chips */
    }

    const fromLineUp = p.lastLineUp ? new Date(p.lastLineUp).getTime() : 0;
    const lastSeenAt = Math.max(Number.isFinite(fromLineUp) ? fromLineUp : 0, candidate.lastSeenAt);
    return {
      personId: String(p.id ?? candidate.localId),
      fullName: `${p.firstName || ""} ${p.name || ""}`.trim() || pandora.firstName,
      email: p.addresses?.[0]?.email || pandora.email || "",
      phone: pandora.phone || p.addresses?.[0]?.phone || "",
      loginCode: tags[0]?.tag || "",
      lastSeen:
        lastSeenAt > 0
          ? new Date(lastSeenAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : "",
      lastSeenAt,
      races: (p.tags || []).length,
      memberships,
      birthDate: p.birthDate || pandora.birthdate,
      creditBalances,
      waiverValid: pandora.waiverValid,
    };
  } catch {
    return null; // detail fetch failed — drop this match rather than the lookup
  }
}

/**
 * The full lookup. Throws OfficeApiError only when the SEARCH itself fails
 * (the kiosk then falls back to the manual form); per-candidate failures are
 * swallowed.
 */
export async function lookupLicenseMatches(input: LicenseLookupInput): Promise<LicenseMatch[]> {
  const lastName = input.lastName.trim();
  const hits = await officeGet<Array<{ localId: string; description: string }>>(
    CLIENT_KEY,
    `search/person?token=${encodeURIComponent(lastName)}&maxResults=500`,
  );
  const candidates = rankSearchResults(
    (Array.isArray(hits) ? hits : []).filter(
      (h) => h?.localId && descriptionMatchesLastName(h.description || "", lastName),
    ),
    MAX_PANDORA_PROBES,
  );

  // Pandora probe per candidate — the authoritative birthdate + lastName test.
  const probed = await Promise.all(
    candidates.map(async (c) => ({
      c,
      pandora: await pandoraPersonLite(c.localId, input.location),
    })),
  );
  const matched = probed.filter(
    ({ pandora }) =>
      pandora && pandora.birthdate === input.dobIso && norm(pandora.lastName) === norm(lastName),
  ) as Array<{ c: SearchCandidate; pandora: PandoraLite }>;

  const matches = (
    await Promise.all(matched.map(({ c, pandora }) => buildMatch(c, pandora)))
  ).filter((m): m is LicenseMatch => m !== null);

  // First-name affinity ranks first (twins share last name + DOB), then recency.
  const first = input.firstName ?? "";
  matches.sort((a, b) => {
    const aff =
      firstNameAffinity(b.fullName.split(/\s+/)[0] ?? "", first) -
      firstNameAffinity(a.fullName.split(/\s+/)[0] ?? "", first);
    return aff || b.lastSeenAt - a.lastSeenAt;
  });
  return matches;
}

export { OfficeApiError };
