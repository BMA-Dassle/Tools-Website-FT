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
import { hasActiveLicenseMembership } from "~/features/booking/service/license";
import {
  descriptionMatchesLastName,
  dobTokenOf,
  firstNameAffinity,
  lastSeenFromDescription,
} from "~/features/booking/service/office-search";
import { personIdForCode, rememberCodes } from "./code-cache";
import { pickPublishableLoginCode } from "./types";
import type { LicenseMatch } from "./types";

const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";

/**
 * THE SEARCH IS CENTER-SCOPED, AND SO IS EVERY ID IT RETURNS.
 *
 * `GET /api/{clientKey}/search/person` answers from ONE BMI local server, and
 * a BMI person id means nothing on any other server. Proved live 2026-08-17:
 * the same `2/4/2013` token returns 4 hits at `headpinznaples` and 23 wholly
 * different ids at `headpinzftmyers`.
 *
 * This used to be a module-level `BMI_CLIENT_KEY || "headpinzftmyers"`, and
 * `location` was taken and dropped ("the Office search is not center-scoped").
 * So search-before-create at a NAPLES kiosk searched FORT MYERS, found the
 * guest's Fort Myers record, and the match gate adopted a person id Naples has
 * never heard of — after which every Naples write against it 404s: the waiver
 * push, the bill attach, the licence grant.
 *
 * Measured cost on 2026-08-17, Naples adds in 72 h: all 4 cloud-MINTED ids
 * attached (mint was always center-correct — `createOfficePerson` takes a
 * per-center clientKey); both LOOKUP-sourced ids failed. 100% of the failures
 * were on this one line. Naples ran a 15.9% waiver failure rate against
 * ~0.4% at Fort Myers.
 *
 * FastTrax and HP Fort Myers are the SAME local server (61/61 ids
 * byte-identical, 2026-08-15), so they share a key and only "naples" moves.
 *
 * STILL CENTER-BLIND, deliberately out of scope here: `app/api/bmi-office`
 * hardcodes the same key for its `search`/`person` proxy. Its callers are the
 * web racing flows, which are Fort Myers only, so it has produced no known
 * casualties — but it is the same defect and wants the same treatment if a
 * Naples surface ever calls it.
 */
const CLIENT_KEY_BY_LOCATION: Record<string, string> = {
  naples: "headpinznaples",
  headpinz: "headpinzftmyers",
  fasttrax: "headpinzftmyers",
};

/** Fort Myers stays the default: it serves both FT brands, and it is the only
 *  center the racing surfaces (member QR / login code) ever address. */
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";

/**
 * Center slug → BMI client key. An unknown or missing slug falls back to Fort
 * Myers rather than throwing: every caller predating Naples support omits it,
 * and a lookup that cannot run at all blocks the guest at the kiosk, whereas
 * one that searches the wrong center returns no match — which the
 * search-before-create gate already handles by minting a fresh record AT the
 * correct center.
 */
export function clientKeyForLookup(location?: string): string {
  const slug = String(location ?? "")
    .trim()
    .toLowerCase();
  return CLIENT_KEY_BY_LOCATION[slug] || CLIENT_KEY;
}

/** Candidates enriched per scan — the guest's own records are few (≤ ~6);
 *  anything above this is same-DOB noise the filters somehow let through. */
const MAX_CANDIDATES = 12;

export interface LicenseLookupInput {
  lastName: string;
  /** "YYYY-MM-DD" from the license's DBB element. */
  dobIso: string;
  /** Ranking signal only (nicknames: license "ALEXANDER" vs account "Alex"). */
  firstName?: string;
  /**
   * WHICH CENTER TO SEARCH — "fasttrax" | "headpinz" | "naples". Load-bearing:
   * a person id only resolves on the server it was searched from (see
   * CLIENT_KEY_BY_LOCATION). Omitted → Fort Myers.
   */
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
 *  kiosk falls back to the manual form). clientKey defaults to the FM Office
 *  (every pre-Naples caller); lookupMemberMatchesAt passes another center's. */
async function officeSearchPerson(
  searchToken: string,
  clientKey: string = CLIENT_KEY,
): Promise<SearchHit[]> {
  const token = await getOfficeToken(clientKey);
  const path =
    `/api/${clientKey}/search/person` + `?token=${encodeURIComponent(searchToken)}&maxResults=500`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: clientKey,
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
  tags?: Array<{ tag?: string; lastSeen?: string; kind?: number }>;
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
async function buildMatch(
  hit: SearchHit,
  confirm: MatchConfirm,
  clientKey: string = CLIENT_KEY,
): Promise<LicenseMatch | null> {
  const office = await fetchPersonRaw<OfficePerson>(clientKey, hit.localId).catch(() => null);
  if (!office) return null;
  // Authoritative confirmation off the person record itself.
  if (confirm.lastName && office.name && norm(office.name) !== norm(confirm.lastName)) return null;
  if (
    confirm.dobIso &&
    office.birthDate &&
    String(office.birthDate).slice(0, 10) !== confirm.dobIso
  )
    return null;

  const activeMemberships = (office.memberships || []).filter(
    (m) => !m.stops || new Date(m.stops) > new Date(),
  );
  const memberships = activeMemberships
    .filter((m) => isRelevantMembership(m.name))
    .map((m) => m.name)
    .filter((n, i, a) => a.indexOf(n) === i);
  // Verified licence state, decided HERE and not inferred downstream from the
  // filtered name list (service/license.ts). Sign-in is where most kiosk racers
  // are resolved, so without this a lapsed returning racer who never triggers a
  // mid-session refresh still fell back to the `isNewRacer` flag — the exact
  // hole 1.16.0 closed for the refresh path (owner 2026-08-04).
  const licenseActive = hasActiveLicenseMembership(office.memberships);

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
    // NEVER tags[0]: the most-recent tag is whichever handle the guest touched
    // last — a game-card scan puts their Intercard number there (kind 2), and
    // publishing that minted dead wallet QRs on 2026-09-05. Kind-9 login code
    // first, app-QR UUID second, "" when neither exists (chip hides itself).
    loginCode: pickPublishableLoginCode(office.tags),
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
    licenseActive,
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
  // ONE key for the whole lookup: the search that FINDS the ids and the person
  // detail that CONFIRMS them must address the same server, or a Naples hit
  // would be confirmed against a Fort Myers record of the same numeric id.
  const clientKey = clientKeyForLookup(input.location);
  const dobToken = dobTokenOf(input.dobIso);
  const hits = await officeSearchPerson(`${input.lastName.trim()} ${dobToken}`, clientKey);
  const dobMark = `(${dobToken})`;
  const candidates = hits
    .filter(
      (h) =>
        h?.localId &&
        (h.description || "").includes(dobMark) &&
        descriptionMatchesLastName(h.description || "", input.lastName),
    )
    .slice(0, MAX_CANDIDATES);

  const matches = (
    await Promise.all(candidates.map((h) => buildMatch(h, input, clientKey)))
  ).filter((m): m is LicenseMatch => m !== null);
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

  // CACHE THE IMMUTABLE HALF ONLY. `code → personId` can never go stale (tags
  // are append-only and resolve forever), so a hit skips the ~1 s token search
  // outright. The person DETAIL is still read live every time, because name,
  // phone and memberships all change — caching those would be the kind of
  // stale-PII bug that is very hard to notice.
  //
  // Deliberately inside the shared resolver rather than at each call site, so
  // every surface benefits at once: the race check-in desk, kiosk sign-in on
  // the people step, the entry screens, and the booking-site racer lookup.
  const cachedPersonId = await personIdForCode(code);
  if (cachedPersonId) {
    const cached = await buildMatch({ localId: cachedPersonId, description: "" }, {});
    if (cached) return [cached];
    // Cached id no longer resolves (merged/deleted record) — fall through to
    // the authoritative search rather than telling the guest they don't exist.
  }

  const hits = (await officeSearchPerson(code)).filter((h) => h?.localId).slice(0, MAX_CANDIDATES);
  const matches = (await Promise.all(hits.map((h) => buildMatch(h, {})))).filter(
    (m): m is LicenseMatch => m !== null,
  );
  // Backfill on a miss, so the cache self-heals without waiting for the cron.
  // Only when the code resolves to exactly ONE person: a code that returns
  // several records is ambiguous, and pinning one of them here would silently
  // hide the others from every later scan.
  // AWAITED. This runs inside API routes, and a serverless handler is frozen
  // the moment it responds — a dangling `void` here would be killed mid-write,
  // so the cache would never actually self-heal and every scan would keep
  // paying the ~1 s Office search. Same defect that stopped the wallet pushes
  // from ever running (2026-08-05). One indexed insert; the cost is noise.
  if (matches.length === 1) {
    await rememberCodes(matches[0].personId, [code]);
  }
  return matches.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Same member-QR resolution against a DIFFERENT center's Office DB — added
 * so the check-in desk can resolve Naples-issued app QRs (clientKey
 * "headpinznaples"). Naples runs its own BMI server, so the personIds this
 * returns live in a SEPARATE namespace from FM's: callers must only match
 * them against Naples surfaces (numeric ids can collide across servers).
 *
 * Deliberately skips the code→personId cache: personIdForCode/rememberCodes
 * are FM-namespace stores, and writing a Naples personId into them would be
 * exactly the cross-server collision this feature exists to prevent. A
 * Naples scan pays the ~1 s Office search each time — fine for a desk.
 *
 * For the default (FM) key this delegates to lookupMemberMatches so the two
 * paths can never drift.
 */
export async function lookupMemberMatchesAt(
  clientKey: string,
  code: string,
): Promise<LicenseMatch[]> {
  if (!clientKey || clientKey === CLIENT_KEY)
    return lookupMemberMatches(code, clientKey || undefined);
  const hits = (await officeSearchPerson(code, clientKey))
    .filter((h) => h?.localId)
    .slice(0, MAX_CANDIDATES);
  const matches = (await Promise.all(hits.map((h) => buildMatch(h, {}, clientKey)))).filter(
    (m): m is LicenseMatch => m !== null,
  );
  return matches.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Warm the Office auth token (Redis-cached 23 h) so a guest's first scan
 * after a deploy/idle doesn't pay it. Fired fire-and-forget by scan-capable
 * kiosk screens on mount. (The Office API itself is always hot — unlike the
 * Pandora path this replaced, there is no Azure cold start to absorb.)
 *
 * The token is cached PER CLIENT KEY, so a Naples kiosk warming Fort Myers
 * warms the wrong one and its guest still pays the auth on the first scan.
 */
export async function warmLicenseLookup(location?: string): Promise<void> {
  await getOfficeToken(clientKeyForLookup(location)).catch(() => undefined);
}

export { OfficeApiError };

export interface CardPersonHit {
  /** Office person id — raw digit string (17 digits on modern records). */
  personId: string;
  firstName: string;
  lastName: string;
}

/**
 * The Office person whose CARD this is — the staff-card gate's first step
 * (owner 2026-09-04: "use the office api to find person by crewcard").
 *
 * An Intercard account rides the person record as a TAG, and the Office token
 * search resolves tags the same way it resolves login codes — so this is the
 * member-QR rail pointed at a card number. The hit is CONFIRMED against the
 * person detail (a tag equal to the account) before it counts: the token search
 * is a substring oracle and a bare digit run must not sign a look-alike in.
 * Exactly one confirmed person → the hit; zero or several → null (a shared
 * card is not an identity).
 *
 * Throws only when the search itself is unavailable (OfficeApiError) so the
 * caller can say "couldn't check" rather than "not staff".
 */
export async function lookupPersonByCard(
  account: string,
  location?: string,
): Promise<CardPersonHit | null> {
  if (!/^\d{1,20}$/.test(account)) return null;
  const clientKey = clientKeyForLookup(location);
  const hits = await officeSearchPerson(account, clientKey);
  if (hits.length === 0) return null;
  const details = await Promise.all(
    hits.slice(0, MAX_CANDIDATES).map(async (h) => {
      const office = await fetchPersonRaw<OfficePerson>(clientKey, h.localId).catch(() => null);
      if (!office) return null;
      // Intercard cards are `kind: 2` tags on the person (live record
      // 2026-09-04: two cards, both kind 2; the login code is kind 9 and a uuid
      // kind 10). Match the card number AND the kind, so a login code that
      // happens to be all digits can never pass as a card.
      const tagged = (office.tags || []).some(
        (t) =>
          typeof t?.tag === "string" &&
          (t.kind === undefined || t.kind === 2) &&
          t.tag.replace(/^0+/, "") === account,
      );
      return tagged ? { hit: h, office } : null;
    }),
  );
  const confirmed = details.filter((d): d is NonNullable<typeof d> => d !== null);
  if (confirmed.length !== 1) return null;
  const { hit, office } = confirmed[0];
  return {
    personId: hit.localId,
    firstName: String(office.firstName ?? "").trim(),
    lastName: String(office.name ?? "").trim(),
  };
}
