/**
 * Shared Pandora client-side helpers and types.
 *
 * These wrap the API routes at `/api/pandora` (person CRUD + waiver status)
 * and `/api/pandora/waiver` (template search + signing). Any feature that
 * needs waiver flows — group events, express lane, future kiosk check-in —
 * imports from here instead of duplicating fetch logic.
 *
 * Server-side Pandora calls live in the API routes themselves; this file
 * is purely client-side fetch wrappers + shared type definitions.
 */

import type { PandoraCenterKey } from "@/lib/pandora-locations";
import { getWaiverLang } from "@/lib/waiver-lang";

// ── Person types ─────────────────────────────────────────────────────────────

export interface PandoraPersonCreateInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  birthdate?: string; // "YYYY-MM-DD"
  guardianID?: string;
  location?: PandoraCenterKey | string;
}

export interface PandoraPersonCreateResult {
  personId: string;
  /**
   * WHICH RAIL minted this person — the route reports it and callers must not
   * throw it away.
   *
   * `office-cloud` (cloud-first, the default) means the record was CREATED in
   * the vendor cloud and is NOT yet in the center's local Firebird — reads
   * against Pandora will 404 for the next ~10-32s. `pandora-local` means it was
   * written locally and is readable immediately.
   *
   * This is the difference between "check the waiver now" and "you cannot".
   * See `pandoraOnboardGuest`.
   */
  rail?: "office-cloud" | "pandora-local";
}

// ── Waiver status types ──────────────────────────────────────────────────────

export interface PandoraWaiverStatus {
  valid: boolean;
  personId: string;
  firstName?: string;
  lastName?: string;
  /** Contact on file — the GET route returns these; used to resolve a short id
   *  for a returning racer added with no local phone/email. */
  email?: string | null;
  phone?: string | null;
  birthdate?: string | null;
  waiverExpiry?: string | null;
  lastVisit?: string | null;
  related?: unknown[];
  reason?: string;
}

// ── Waiver template types ────────────────────────────────────────────────────

export interface PandoraWaiverTemplate {
  /** Pandora internal ID */
  id: string;
  /** Used when signing the waiver */
  contentID: string;
  name: string;
  /** Duration in YEARS — BMI template semantics. All three locations return 1;
   *  desk-signed waivers carry ~1-year expiries. (Live-verified 2026-07-25:
   *  treating this as days stamped every web/kiosk waiver with a next-morning
   *  expiry.) */
  duration: number;
  /** HTML body of the waiver text */
  body: string;
}

// ── Waiver sign types ────────────────────────────────────────────────────────

export interface PandoraSignWaiverInput {
  personID: string;
  waiverContentID: string;
  /** Base64 PNG data URL from signature pad (with or without data:image prefix) */
  signature: string;
  location?: PandoraCenterKey | string;
  /** "YYYY-MM-DD" — calculated from template duration. If omitted, API uses default. */
  invalidationDate?: string;
  /** SHORT Pandora id of the person SIGNING, when not the person themselves —
   *  a guardian signing a minor's waiver. Omitted = self-sign. */
  sigPersonID?: string;
  /** Display name, echoed back inside the signed licence grant so the offer
   *  card can label a row without a second lookup. Label only — it carries no
   *  authority (see licence-grant.ts). */
  firstName?: string;
}

export interface PandoraSignWaiverResult {
  ok: boolean;
  waiverID?: string;
  /** Server-signed proof that this person's waiver is on file. Two-hour life.
   *  The ONLY thing that lets a licence be offered with no booking. */
  licenceGrant?: string;
  /** The vendor record is OWED, not lost: the person had not reached the
   *  center's local server yet, so the push went to the sync queue. The
   *  signature is already durable in Neon. A full success to the guest — see
   *  the guard in `pandoraSignWaiver`. */
  queuedForSync?: boolean;
}

// ── Client-side API helpers ──────────────────────────────────────────────────

/**
 * GET with retry — the Pandora API runs on Azure App Service and cold-starts,
 * so the first request after idle can 5xx/time out while a retry succeeds.
 * Only safe for idempotent GETs (never person-create). Retries on network
 * error or 5xx; returns the last response so callers handle 4xx normally.
 */
async function getWithRetry(url: string, attempts = 3, delayMs = 1200): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error("Request failed");
}

/**
 * Create a person in BMI via Pandora.
 * Calls POST /api/pandora
 */
export async function pandoraCreatePerson(
  input: PandoraPersonCreateInput,
): Promise<PandoraPersonCreateResult> {
  // Retry on cold-start: the Pandora API (Azure App Service) 5xx's / times out on
  // the first request after idle; without the retry the onboard threw and left
  // the guest stuck on the name step. 4xx (real client error) is NOT retried.
  //
  // HONEST RISK NOTE (2026-07-25, Strachan incident): create is NOT a reliable
  // upsert — Pandora can mint a DUPLICATE person (proven: 8 records for one
  // kid). A write-then-5xx here means the retry itself may create a duplicate.
  // We accept that rare case to keep cold-start onboarding alive; what is NOT
  // acceptable is calling create again for someone who already has an id —
  // callers must store the returned personId and never re-create (see the
  // short-id guards in KioskPeopleStep/KioskPartyManager submitSetup).
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i));
    let res: Response;
    try {
      res = await fetch("/api/pandora", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch (err) {
      lastErr = err; // network/timeout — retry
      continue;
    }
    const data = await res
      .json()
      .catch(() => ({}) as { personId?: string; error?: string; rail?: string });
    if (data.personId) {
      const rail =
        data.rail === "office-cloud" || data.rail === "pandora-local" ? data.rail : undefined;
      return { personId: data.personId, rail };
    }
    // 4xx = real client error (e.g. missing fields) — fail fast, don't retry.
    if (res.status < 500) throw new Error(data.error || "Failed to create person");
    lastErr = new Error(data.error || `HTTP ${res.status}`); // 5xx — retry
  }
  throw lastErr instanceof Error ? lastErr : new Error("Failed to create person");
}

/**
 * REPAIR an existing BMI person by writing the birthdate (plus any contact
 * details we hold) onto their record. Calls PATCH /api/pandora.
 *
 * A BMI person with a null birthdate makes Pandora's own GET /bmi/person return
 * 500 "Response Validator Error" — the record exists, but the vendor's response
 * schema rejects it. Every caller reads that as "no waiver", so a racer who HAS
 * signed shows "Waiver needed" and can never be scheduled. Proven live
 * 2026-08-07: one PATCH turned a persistent 500 into a clean read carrying a
 * waiver valid to 2027-08-08 that had been on file the whole time.
 *
 * This UPDATES, never creates — the important difference from the path it
 * replaces, which minted a fresh person every time it met an unresolvable id.
 * Never throws: a failed repair leaves the guest exactly where they were.
 */
export async function pandoraPatchBirthdate(args: {
  personId: string;
  /** ISO `YYYY-MM-DD`. */
  birthdate: string;
  location?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}): Promise<boolean> {
  try {
    const res = await fetch("/api/pandora", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check a person's waiver status via Pandora.
 * Calls GET /api/pandora?personId=...&location=...
 */
export async function pandoraCheckWaiver(
  personId: string,
  location?: string,
): Promise<PandoraWaiverStatus> {
  const params = new URLSearchParams({ personId });
  if (location) params.set("location", location);
  const res = await getWithRetry(`/api/pandora?${params}`);
  return res.json();
}

/**
 * Fetch the age-appropriate waiver template.
 * Calls GET /api/pandora/waiver?age=...&location=...
 */
export async function pandoraFetchWaiverTemplate(
  age: number,
  location?: string,
  /** Waiver display language. In-house path only; BMI path is English-only.
   *  Defaults to the ambient kiosk locale (set by LocaleProvider). */
  lang: "en" | "es" = getWaiverLang(),
): Promise<PandoraWaiverTemplate> {
  // In-house waivers (kioskWaiverInhouseEnabled, NEXT_PUBLIC, default ON) — serve
  // OUR translatable body via the kiosk template route (which keeps BMI's real
  // contentID so the sign path is unchanged). Set NEXT_PUBLIC_KIOSK_WAIVER_INHOUSE
  // =false to revert to the BMI template. Env read inline to avoid a lib→features
  // import; keep in sync with src/features/kiosk/flags.ts.
  const inhouse = process.env.NEXT_PUBLIC_KIOSK_WAIVER_INHOUSE !== "false";
  const params = new URLSearchParams({ age: String(age) });
  if (location) params.set("location", location);
  let path = `/api/pandora/waiver?${params}`;
  if (inhouse) {
    const p = new URLSearchParams({ age: String(age), lang });
    if (location) p.set("location", location);
    path = `/api/kiosk/waiver/template?${p}`;
  }
  const res = await getWithRetry(path);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    // A 404 means this CENTER has no waiver configured for this age — not a blip.
    // Live 2026-08-12: HeadPinz Naples' templates start at age 8, so a 6- and
    // 7-year-old got "No waiver found" while Fort Myers served them fine. The
    // generic message read as "try again", and each try minted another person.
    // Say what is actually wrong so the guest stops retrying and asks the desk.
    // Guest-facing, so both languages (house rule) — `lang` is already the
    // ambient kiosk locale here.
    if (res.status === 404) {
      throw new Error(
        lang === "es"
          ? `Este centro no tiene una exoneración disponible para la edad ${age}. ` +
              `Por favor, acuda al mostrador — allí pueden firmarla por usted. ` +
              `(No hay ningún error en los datos que ingresó.)`
          : `This location has no waiver on file for age ${age}. Please see the front desk — ` +
              `they can sign this waiver for you. (Nothing you typed is wrong.)`,
      );
    }
    throw new Error(data?.error || "Could not load waiver template");
  }
  return res.json();
}

/**
 * Sign a waiver via Pandora.
 * Calls POST /api/pandora/waiver
 */
export async function pandoraSignWaiver(
  input: PandoraSignWaiverInput,
): Promise<PandoraSignWaiverResult> {
  const res = await fetch("/api/pandora/waiver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  // A platform timeout (FUNCTION_INVOCATION_TIMEOUT) answers with an HTML body,
  // and an unguarded .json() turned that into a SyntaxError shown to the guest as
  // "Unexpected token '<'". Say what actually happened instead.
  const data = await res.json().catch(() => null);
  if (!data) {
    throw new Error(
      res.ok
        ? "Waiver signing failed"
        : `Waiver signing failed (server error ${res.status}). Please try again.`,
    );
  }
  // A missing waiverID means BMI did not record the waiver — fail loudly so the
  // UI keeps the guest on the sign step instead of advancing on a phantom success.
  // TWO exceptions, both of which mean the waiver IS on file or owed:
  //   `alreadyValid`   — the API verified the person's waiver is valid right now
  //                      (a Pandora write-then-500 salvaged server-side).
  //   `queuedForSync`  — the person had not reached the center's local server
  //                      yet, so the push is queued behind a `person-local`
  //                      barrier. The signature is already durable in Neon.
  //
  // `queuedForSync` was previously unhandled ANYWHERE, so the route's designed
  // cloud-first path — a 200 with ok:true — reached the guest as "Waiver signing
  // failed" and dead-ended them on the signature pad: every re-tap waited out
  // the local-sync poll again and threw again, until sync happened to catch up.
  // Live 2026-08-12 (owner screenshot). Treating it as a plain success is the
  // honest reading: the guest's signature is captured and the vendor record is
  // owed, not lost (owner decision — same "you're all set" card, no new copy).
  if (!res.ok || (!data.waiverID && !data.alreadyValid && !data.queuedForSync)) {
    throw new Error(data.error || "Waiver signing failed");
  }
  // `licenceGrant` is a server-signed proof that this person's waiver went on
  // file — the only thing that lets the finished card offer them a racing
  // licence with no booking to hang off. See licence-grant.ts.
  return {
    ok: true,
    waiverID: data.waiverID ?? undefined,
    licenceGrant: typeof data.licenceGrant === "string" ? data.licenceGrant : undefined,
    queuedForSync: data.queuedForSync === true,
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────

/** Calculate age in years from a "YYYY-MM-DD" birthdate string. */
export function calculateAge(birthdate: string): number {
  const born = new Date(birthdate);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) {
    age--;
  }
  return age;
}

/**
 * Calculate the waiver invalidation date from a template's duration.
 * Returns "YYYY-MM-DD" string.
 *
 * Template `duration` is in YEARS (BMI semantics — desk-signed waivers run
 * ~1 year and the templates all carry duration:1). This used to add DAYS,
 * which set every web/kiosk-signed waiver to expire the next morning at 9am
 * ET — guests re-signed on every visit and the check-in "existing valid
 * waiver" pull-in never matched (production incident 2026-07-25, Strachan
 * family). Clamped to [1,10] years so a mis-configured template can never
 * produce a decades-long or instantly-expired waiver.
 */
export function calculateWaiverExpiry(durationYears: number): string {
  const years = durationYears >= 1 && durationYears <= 10 ? Math.floor(durationYears) : 1;
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().split("T")[0];
}

/**
 * Full waiver onboarding flow: create person → check waiver → fetch template if needed.
 *
 * Returns either:
 *   - `{ personId, waiverValid: true }` if waiver is already signed
 *   - `{ personId, waiverValid: false, template }` if waiver needs signing
 *
 * `birthdate` in the result is the REFRESHED one: the create USUALLY resolves a
 * returning guest to their existing BMI record (but is NOT a reliable upsert —
 * 2026-07-25: differing field sets mint a duplicate person; never call this for
 * someone who already has an id), and the waiver check returns that record's
 * birthdate — which is authoritative for the waiver template. A kiosk typo (or
 * a missing local DOB) must never hand a minor the adult waiver, so the
 * template age prefers BMI's birthdate over the typed one.
 * (2026-07-23: a 17-year-old got an adult waiver signature — Hayden Waln.)
 *
 * `firstName`/`lastName` are refreshed the same way: when the create resolved
 * an existing record, the result carries THAT record's name, falling back to
 * what was typed. What a guest types can be a booking slot label, not a name —
 * 2026-07-31: guests entered "Adult 1"/"Adult 2" (their booking's unnamed-racer
 * labels), the create matched their real accounts by phone, and the typed
 * labels rode the check-in bind into BMI's project people list and the staff
 * memo. The record's name is the account the guest signed into — callers should
 * store and display it (Title Case it first: CRM rows can be ALL CAPS).
 */
/**
 * Persons already minted in THIS page session, keyed by the guest's identity.
 *
 * Why this exists: `pandoraOnboardGuest` mints first and can then fail on any
 * later step (template fetch, waiver read, network). Every one of those failures
 * surfaces to the guest as "try again" — and the retry ran step 1 again, minting
 * a SECOND person for the same human. Under cloud-first that is guaranteed
 * duplication, because the Office create never resolves an existing record.
 *
 * Live proof (2026-08-12, HeadPinz Naples): Mattis Poeter, age 6, ended up with
 * FIVE person records — …906317/…906319/…906321 carrying byte-identical data —
 * and no waiver on any of them, because his onboard threw after the mint and the
 * form was resubmitted. Each of his relatives, whose onboard succeeded first
 * time, got exactly one record.
 *
 * So the mint is memoised: a retry for the same name+DOB+center reuses the id we
 * already have. Keyed by identity, not by form state, so it also survives the
 * guest re-typing the same person. Session-scoped by design — a real returning
 * guest on a later visit must still go through BMI's own matching.
 */
const mintedThisSession = new Map<string, PandoraPersonCreateResult & { birthdate: string }>();

/**
 * Identity key for the mint memo: name + center, deliberately NOT the birthdate.
 *
 * The birthdate is the field a guest EDITS when the flow errors — Mattis' five
 * records carry two different birth years (2019-08-16 ×3, 2018-08-16 ×2) because
 * the retry that followed each failure came with a "corrected" year. Keying on
 * the DOB would let every correction mint another twin, which is the bug.
 *
 * So the same name at the same center is the same human for the length of this
 * page session, and a changed DOB is a CORRECTION to the record we already
 * minted — applied with `pandoraPatchBirthdate`, which updates and never creates.
 */
function mintKey(input: { firstName: string; lastName: string }, location?: string) {
  return [
    location ?? "",
    input.firstName.trim().toLowerCase(),
    input.lastName.trim().toLowerCase(),
  ].join("|");
}

export async function pandoraOnboardGuest(
  input: PandoraPersonCreateInput & { birthdate: string },
  location?: string,
  /** Waiver display language for the in-house template. Defaults to the ambient
   *  kiosk locale (set by LocaleProvider); callers need not pass it. */
  lang: "en" | "es" = getWaiverLang(),
): Promise<
  | {
      personId: string;
      waiverValid: true;
      template: null;
      birthdate: string;
      firstName: string;
      lastName: string;
    }
  | {
      personId: string;
      waiverValid: false;
      template: PandoraWaiverTemplate;
      birthdate: string;
      firstName: string;
      lastName: string;
    }
> {
  // 1. Create person (usually resolves a known person to their existing record;
  //    NOT a reliable upsert — see the risk note on pandoraCreatePerson).
  //    Memoised per identity so a retry after ANY later failure reuses the id
  //    instead of minting a twin — see `mintedThisSession`.
  const key = mintKey(input, location);
  const cached = mintedThisSession.get(key);
  let minted: PandoraPersonCreateResult;
  if (cached) {
    minted = cached;
    // A retry that carries a DIFFERENT birthdate is the guest correcting the
    // record we already minted — patch it, never mint a twin. Best-effort: a
    // failed patch leaves the guest where they were and the queue still owns the
    // repair (`repair-person-details`).
    if (cached.birthdate !== input.birthdate) {
      await pandoraPatchBirthdate({
        personId: cached.personId,
        birthdate: input.birthdate,
        location,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
      });
      mintedThisSession.set(key, { ...cached, birthdate: input.birthdate });
    }
  } else {
    minted = await pandoraCreatePerson({ ...input, location });
    mintedThisSession.set(key, { ...minted, birthdate: input.birthdate });
  }
  const { personId, rail } = minted;

  // 2. Check if waiver already valid — the response carries the BMI record's
  //    birthdate and name (membership refresh: BMI wins over what was typed).
  //
  //    ⚠️ CROSS-RAIL: this reads PANDORA (the center's LOCAL server) for a
  //    person that cloud-first just minted in the vendor CLOUD. The record does
  //    not reach local for ~10-32s, so the read 404s and — before this guard —
  //    threw, the guest saw an error, tapped again, and step 1 minted ANOTHER
  //    person. Live 2026-08-12: Mattis Poeter got FIVE Naples person records
  //    (…906317/906319/906321 all with identical data, plus …907988/…908989)
  //    and never a waiver, while every relative who succeeded first time got
  //    exactly one.
  //
  //    A freshly CREATED record has nothing to refresh from anyway: the only
  //    data on it is what the guest just typed, and there is no older BMI
  //    account to prefer. So skip the read entirely for a fresh cloud mint and
  //    use the typed values. No cross-rail read ⇒ no failure ⇒ no retry ⇒ no
  //    duplicate. (`repair-person-details` + the queue own the follow-up.)
  if (rail === "office-cloud") {
    const age = calculateAge(input.birthdate);
    const template = await pandoraFetchWaiverTemplate(age, location, lang);
    return {
      personId,
      waiverValid: false,
      template,
      birthdate: input.birthdate,
      firstName: input.firstName,
      lastName: input.lastName,
    };
  }

  const status = await pandoraCheckWaiver(personId, location);
  const birthdate = status.birthdate ? String(status.birthdate).slice(0, 10) : input.birthdate;
  const firstName = status.firstName?.trim() || input.firstName;
  const lastName = status.lastName?.trim() || input.lastName;
  if (status.valid) {
    return { personId, waiverValid: true, template: null, birthdate, firstName, lastName };
  }

  // 3. Fetch age-appropriate waiver template from the refreshed birthdate
  const age = calculateAge(birthdate);
  const template = await pandoraFetchWaiverTemplate(age, location, lang);
  return { personId, waiverValid: false, template, birthdate, firstName, lastName };
}
