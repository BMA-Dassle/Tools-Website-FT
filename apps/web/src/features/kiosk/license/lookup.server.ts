/**
 * Kiosk scan sign-in lookups — server side. Two scan types resolve to the
 * same FoundAccount shape: a DRIVER'S LICENSE (last name + DOB, AAMVA) and
 * the SMS-TIMING MEMBER QR (the app's personal code). Both sign the guest in
 * instantly without typing (owner 2026-07-23/24: the physical ID / personal
 * QR is the identity proof — OTP-equivalent trust for walk-up purposes;
 * `phoneVerified` is never set by these paths).
 *
 * THE SEARCH IS THE BMI OFFICE TOKEN SEARCH with a combined token (owner
 * 2026-07-23, third revision — this one measured FAST):
 *
 *   search/person?token=<LastName M/D/YYYY>     e.g. "Doe 3/14/2001"
 *
 * ~1 s live vs ~8.5 s for Pandora's /bmi/person/search (docs/pandora-api.md
 * keeps that endpoint's numbers). Hard-won upstream facts (verified live):
 *  - The DOB token must be M/D/YYYY with NO LEADING ZEROS — "03/14/2001"
 *    matches nothing.
 *  - This endpoint 500s under Node fetch/undici for slash-bearing or
 *    single-word tokens — the search call MUST go over raw `https.get`
 *    (same reason app/api/bmi-office does). person/{id} is fine on fetch.
 *  - Hits share the DOB but include other same-birthday humans (token OR
 *    semantics) — the description carries "Name (M/D/YYYY) …", so we filter
 *    by the exact "(dob)" marker + whole-word last-name match, then confirm
 *    against the Office person detail during enrichment.
 *
 * EVERY record of the guest is returned (owner: duplicates must be VISIBLE —
 * one match signs in directly, several show the account picker). Enrichment
 * is ONE Office person detail per candidate (~400 ms, parallel): memberships
 * (tier), races, loginCode, email/phone (addresses[0] carries mobile+phone+
 * email — measured). No deposits pull and no waiver probe here — exactly
 * like the phone OTP sign-in, the member lands with waiverValid unknown and
 * the existing importLinked/qualification-refresh rail resolves waiver +
 * credits right after (the roster card shows "Checking waiver…" briefly).
 *
 * BMI ID precision: bodies are parsed via parseWithRawIds — NEVER res.json().
 */
import https from "https";
import { randomUUID } from "crypto";
import { parseWithRawIds } from "@ft/db";
import {
  fetchPersonRaw,
  getOfficeToken,
  OfficeApiError,
} from "~/features/daily-events/data/bmi-office";
import { isRelevantMembership } from "~/features/booking/service/race-products";
import {
  descriptionMatchesLastName,
  dobTokenOf,
  firstNameAffinity,
  lastSeenFromDescription,
} from "~/features/booking/service/office-search";
import type { LicenseMatch } from "./types";

// Same host/key/version as app/api/bmi-office/route.ts — one Office DB serves
// both brands (racing/waiver accounts live in the FastTrax BMI).
const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";

/** Candidates enriched per scan — the guest's own records are few (≤ ~6);
 *  anything above this is same-DOB noise the filters somehow let through. */
const MAX_CANDIDATES = 12;

export interface LicenseLookupInput {
  lastName: string;
  /** "YYYY-MM-DD" from the license's DBB element. */
  dobIso: string;
  /** Ranking signal only (nicknames: license "ALEXANDER" vs account "Alex"). */
  firstName?: string;
  /** Accepted for API stability; the Office search is not center-scoped. */
  location?: string;
}

export type { LicenseMatch } from "./types";

/** Raw-https GET against the Office API — undici 500s on these tokens. */
function officeHttpsGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error("Office search timeout"));
    });
  });
}

interface SearchHit {
  localId: string;
  description: string;
}

/** The token search (combined "LastName M/D/YYYY" or a member-QR code). One
 *  retry on 5xx; throws when the search stays unavailable (route → 502 → the
 *  kiosk falls back to the manual form). */
async function officeSearchPerson(searchToken: string): Promise<SearchHit[]> {
  const token = await getOfficeToken(CLIENT_KEY);
  const path =
    `/api/${CLIENT_KEY}/search/person` + `?token=${encodeURIComponent(searchToken)}&maxResults=500`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: CLIENT_KEY,
  };
  let res = await officeHttpsGet(path, headers);
  if (res.status >= 500) res = await officeHttpsGet(path, headers); // one retry
  if (res.status >= 400) {
    throw new OfficeApiError(res.status, `Office search failed: ${res.status}`);
  }
  // localId is a 17-digit id on modern records — quote it before parsing.
  const hits = parseWithRawIds<SearchHit[]>(res.body, ["localId"]);
  return Array.isArray(hits) ? hits : [];
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

const norm = (s: string | null | undefined) =>
  String(s ?? "")
    .trim()
    .toLowerCase();

/** What buildMatch verifies the person record against — the license path
 *  confirms name+DOB; the member-QR path has no scan identity (the code IS
 *  the identity) so it passes nothing. */
interface MatchConfirm {
  lastName?: string;
  dobIso?: string;
  firstName?: string;
}

/** ONE Office person detail → the FoundAccount shape the kiosk's existing
 *  sign-in rail consumes. Returns null when the detail contradicts the scan
 *  (different last name / birthdate — a token false-positive) or the fetch
 *  died. No waiverValid here — importLinked resolves it right after sign-in,
 *  exactly like the phone OTP path. */
async function buildMatch(hit: SearchHit, confirm: MatchConfirm): Promise<LicenseMatch | null> {
  const office = await fetchPersonRaw<OfficePerson>(CLIENT_KEY, hit.localId).catch(() => null);
  if (!office) return null;
  // Authoritative confirmation off the person record itself.
  if (confirm.lastName && office.name && norm(office.name) !== norm(confirm.lastName)) return null;
  if (
    confirm.dobIso &&
    office.birthDate &&
    String(office.birthDate).slice(0, 10) !== confirm.dobIso
  )
    return null;

  const tags = (office.tags || []).sort((a, b) =>
    (b.lastSeen || "").localeCompare(a.lastSeen || ""),
  );
  const memberships = (office.memberships || [])
    .filter((m) => (!m.stops || new Date(m.stops) > new Date()) && isRelevantMembership(m.name))
    .map((m) => m.name)
    .filter((n, i, a) => a.indexOf(n) === i);

  // Display name: Office record → the scanned license itself (a legacy
  // duplicate can carry no first name at all).
  const firstName = office.firstName || confirm.firstName || "";
  const lastName = office.name || confirm.lastName || "";

  const descSeen = lastSeenFromDescription(hit.description || "");
  const lineUpSeen = office.lastLineUp ? new Date(office.lastLineUp).getTime() : 0;
  const lastSeenAt = Math.max(descSeen, Number.isFinite(lineUpSeen) ? lineUpSeen : 0);

  return {
    personId: hit.localId,
    fullName: `${firstName} ${lastName}`.trim(),
    email: office.addresses?.[0]?.email || "",
    phone: office.addresses?.[0]?.mobile || office.addresses?.[0]?.phone || "",
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
    races: (office.tags || []).length,
    memberships,
    birthDate: office.birthDate ? String(office.birthDate).slice(0, 10) : (confirm.dobIso ?? null),
    // Filled by the qualification refresh at the people-step exit — the
    // deposits pull is deliberately not part of the lookup (latency).
    creditBalances: [],
  };
}

/**
 * The full lookup: ONE Office combined-token search (~1 s) → description
 * filter ("(dob)" marker + whole-word last name) → parallel person-detail
 * enrichment with authoritative name/DOB confirmation → EVERY surviving
 * record, ordered scanned-first-name affinity then recency. Throws only when
 * the search itself is unavailable.
 */
export async function lookupLicenseMatches(input: LicenseLookupInput): Promise<LicenseMatch[]> {
  const dobToken = dobTokenOf(input.dobIso);
  const hits = await officeSearchPerson(`${input.lastName.trim()} ${dobToken}`);
  const dobMark = `(${dobToken})`;
  const candidates = hits
    .filter(
      (h) =>
        h?.localId &&
        (h.description || "").includes(dobMark) &&
        descriptionMatchesLastName(h.description || "", input.lastName),
    )
    .slice(0, MAX_CANDIDATES);

  const matches = (await Promise.all(candidates.map((h) => buildMatch(h, input)))).filter(
    (m): m is LicenseMatch => m !== null,
  );
  // Affinity is BINARY for ordering: records whose first name plausibly
  // matches the scan (exact OR prefix — "Alex" vs ALEXANDER) rank by RECENCY
  // among themselves, so the guest's live duplicate tops the list; only
  // different-first-name records (a twin's) and nameless legacies sink.
  // (Exact-beats-prefix would float a stale "ALEXANDER" 2023 record above
  // the active "Alex" one — seen live 2026-07-23.)
  const plausible = (m: LicenseMatch) =>
    firstNameAffinity(m.fullName.split(/\s+/)[0], input.firstName) > 0 ? 1 : 0;
  return matches.sort((a, b) => plausible(b) - plausible(a) || b.lastSeenAt - a.lastSeenAt);
}

/**
 * SMS-Timing member-QR lookup (owner 2026-07-24): the app's personal QR
 * carries `["<clientKey>","<code>"]` (qr-scanner/member-qr.ts) and the code
 * as a search token returns exactly the member's record (~0.7 s live). No
 * name/DOB confirmation — possession of the code IS the identity, same trust
 * class as the login-code path. A QR issued under a different clientKey is
 * not ours → no matches.
 */
export async function lookupMemberMatches(
  code: string,
  qrClientKey?: string,
): Promise<LicenseMatch[]> {
  if (qrClientKey && qrClientKey !== CLIENT_KEY) return [];
  const hits = (await officeSearchPerson(code)).filter((h) => h?.localId).slice(0, MAX_CANDIDATES);
  const matches = (await Promise.all(hits.map((h) => buildMatch(h, {})))).filter(
    (m): m is LicenseMatch => m !== null,
  );
  return matches.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Warm the Office auth token (Redis-cached 23 h) so a guest's first scan
 * after a deploy/idle doesn't pay it. Fired fire-and-forget by scan-capable
 * kiosk screens on mount. (The Office API itself is always hot — unlike the
 * Pandora path this replaced, there is no Azure cold start to absorb.)
 */
export async function warmLicenseLookup(): Promise<void> {
  await getOfficeToken(CLIENT_KEY).catch(() => undefined);
}

export { OfficeApiError };
