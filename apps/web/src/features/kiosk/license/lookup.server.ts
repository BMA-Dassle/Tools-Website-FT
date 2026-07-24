/**
 * Kiosk driver's-license lookup — server side. Given the last name + DOB read
 * off a scanned license (AAMVA PDF417), find the guest's existing account so
 * the kiosk signs them in instantly, without typing (owner 2026-07-23: the
 * physical ID is the identity proof — OTP-equivalent trust for walk-up
 * purposes; `phoneVerified` is never set by this path).
 *
 * THE LOOKUP IS PANDORA (owner directive 2026-07-23 — NOT the Office
 * `search/person` token search, which 500s on bare name tokens):
 *
 *   GET /v2/bmi/person/search?location&lastName&birthday&limit&filter=false
 *
 * Purpose-built endpoint (docs/pandora-api.md § person search, verified live
 * 2026-07-23): filters by last name + birthdate in Firebird, orders by
 * lastVisit desc, returns waiverExpiry per record. `filter=false` keeps
 * expired-waiver guests (they still sign in — the kiosk re-signs the waiver).
 * Azure cold start 502s the first request(s) after idle, so the search
 * retries 5xx exactly like pandoraCreatePerson does.
 *
 * EVERY exact match is returned (owner 2026-07-23: guests have duplicate
 * accounts and want to SEE them — one match signs in directly, several show
 * the account picker). Enrichment per match is deliberately LIGHT for speed
 * (owner: "the search is taking a long time"): ONE Office person detail per
 * match (~400 ms, parallel) supplies memberships/races/loginCode AND
 * email/phone (addresses[0] carries mobile+phone+email — measured; the
 * ~3.4 s Pandora person GET this used to make was redundant). The 2-year
 * deposit-history pull was dropped too; KioskFlow's qualification refresh
 * re-pulls credits (and tier/waiver) at the people-step exit and review→pay,
 * before anything consumes them. Both id forms the search returns (17-digit
 * modern, legacy short) were verified live against Office person/{id}.
 * Enrichment is fail-open: a dead source degrades the card, never the
 * sign-in.
 *
 * LATENCY BUDGET (measured 2026-07-23): the Pandora search call itself is
 * ~7–9 s upstream even warm — that cost lives INSIDE bma-pandora-api's
 * Firebird query, not here. Everything this module adds on top is now
 * ~0.5 s. Making scans feel instant requires optimizing the Pandora
 * endpoint's query/indexing (owner owns that API).
 *
 * warmLicenseLookup() absorbs the Azure cold start BEFORE a guest scans —
 * the kiosk fires it (fire-and-forget) when a scan-capable screen mounts.
 *
 * BMI ID precision: every upstream body is parsed via parseWithRawIds
 * (officeGet does it internally; the Pandora fetches here do it explicitly) —
 * NEVER res.json() these responses.
 */
import { parseWithRawIds, BMI_ID_FIELDS } from "@ft/db";
import {
  fetchPersonRaw,
  getOfficeToken,
  OfficeApiError,
} from "~/features/daily-events/data/bmi-office";
import { isRelevantMembership } from "~/features/booking/service/race-products";
import { resolvePandoraLocation } from "@/lib/pandora-locations";
import { filterAndRankHits, hitWaiverValid, type PandoraSearchHit } from "./search-hits";
import type { LicenseMatch } from "./types";

// Same key + default as app/api/bmi-office/route.ts — one Office DB serves
// both brands (racing/waiver accounts live in the FastTrax BMI).
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const pandoraKey = () => process.env.SWAGGER_ADMIN_KEY || "";

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The Pandora person search. Retries 5xx/network (Azure cold start — the app
 * 502s the first request(s) after idle, verified live 2026-07-23); a 404 or a
 * clean empty result is "no matches", NOT an error. Throws only when the
 * search stays unavailable after retries (route → 502 → the kiosk falls back
 * to the manual form).
 */
async function pandoraPersonSearch(input: LicenseLookupInput): Promise<PandoraSearchHit[]> {
  const locationId = resolvePandoraLocation(input.location);
  const url =
    `${PANDORA_URL}/bmi/person/search?location=${locationId}` +
    `&lastName=${encodeURIComponent(input.lastName.trim())}` +
    `&birthday=${input.dobIso}&limit=10&filter=false`;
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await delay(1500 * i);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${pandoraKey()}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      continue; // network/timeout — retry
    }
    if (res.status === 404) return []; // spec: no customers matched
    const text = await res.text();
    if (res.status >= 500) continue; // cold start — retry
    if (!res.ok) return []; // 4xx validation — treat as no matches
    const body = parseWithRawIds<{ success?: boolean; data?: PandoraSearchHit[] }>(
      text,
      BMI_ID_FIELDS,
    );
    return body?.success && Array.isArray(body.data) ? body.data : [];
  }
  throw new Error("Pandora person search unavailable (5xx after retries)");
}

interface OfficePerson {
  id?: unknown;
  firstName?: string;
  name?: string;
  birthDate?: string | null;
  lastLineUp?: string | null;
  tags?: Array<{ tag?: string; lastSeen?: string }>;
  memberships?: Array<{ name: string; stops?: string | null }>;
  addresses?: Array<{ email?: string; mobile?: string | null; phone?: string | null }>;
}

/** ONE Office person detail → the FoundAccount shape the kiosk's existing
 *  sign-in rail consumes (fail-open — a dead fetch degrades the card, never
 *  the sign-in). Deposits are deliberately NOT fetched here (latency) —
 *  creditBalances start empty and the qualification refresh fills them at
 *  the people-step exit. */
async function buildMatch(hit: PandoraSearchHit, input: LicenseLookupInput): Promise<LicenseMatch> {
  const office = await fetchPersonRaw<OfficePerson>(CLIENT_KEY, hit.id).catch(() => null);

  const tags = (office?.tags || []).sort((a, b) =>
    (b.lastSeen || "").localeCompare(a.lastSeen || ""),
  );
  const memberships = (office?.memberships || [])
    .filter((m) => (!m.stops || new Date(m.stops) > new Date()) && isRelevantMembership(m.name))
    .map((m) => m.name)
    .filter((n, i, a) => a.indexOf(n) === i);

  // Display name: Office record → search hit → the scanned license itself
  // (a legacy duplicate can carry firstName null everywhere else).
  const firstName = office?.firstName || hit.firstName || input.firstName || "";
  const lastName = office?.name || hit.lastName;

  const searchSeen = hit.lastVisit ? new Date(hit.lastVisit).getTime() : 0;
  const lineUpSeen = office?.lastLineUp ? new Date(office.lastLineUp).getTime() : 0;
  const lastSeenAt = Math.max(
    Number.isFinite(searchSeen) ? searchSeen : 0,
    Number.isFinite(lineUpSeen) ? lineUpSeen : 0,
  );

  return {
    personId: hit.id,
    fullName: `${firstName} ${lastName}`.trim(),
    email: office?.addresses?.[0]?.email || "",
    phone: office?.addresses?.[0]?.mobile || office?.addresses?.[0]?.phone || "",
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
    races: (office?.tags || []).length,
    memberships,
    // The record we matched IS the record we sign in against — its own
    // waiverExpiry (from the search hit) is the authoritative status.
    birthDate: String(hit.birthdate ?? "").slice(0, 10) || null,
    // Filled by the qualification refresh at the people-step exit (see the
    // buildMatch docblock) — never consumed before then.
    creditBalances: [],
    waiverValid: hitWaiverValid(hit),
  };
}

/**
 * The full lookup: ONE Pandora search (already lastName+DOB filtered and
 * lastVisit-ordered) → guard/rank (EVERY exact match kept) → enrich all in
 * parallel. Throws only when the search itself is unavailable.
 */
export async function lookupLicenseMatches(input: LicenseLookupInput): Promise<LicenseMatch[]> {
  const hits = await pandoraPersonSearch(input);
  const ranked = filterAndRankHits(hits, input.lastName, input.dobIso, input.firstName);
  return Promise.all(ranked.map((h) => buildMatch(h, input)));
}

/**
 * Absorb the upstream cold starts BEFORE a guest scans: a throwaway Pandora
 * search (the Azure app 502s its first requests after idle — the retries in
 * pandoraPersonSearch ride it out) plus the Office token grab (Redis-cached
 * 23h, so usually instant). Called fire-and-forget from the kiosk when a
 * scan-capable screen mounts; failures are irrelevant — the real lookup
 * retries anyway.
 */
export async function warmLicenseLookup(location?: string): Promise<void> {
  await Promise.allSettled([
    pandoraPersonSearch({ lastName: "ZZZWARMUP", dobIso: "1900-01-01", location }),
    getOfficeToken(CLIENT_KEY),
  ]);
}

export { OfficeApiError };
