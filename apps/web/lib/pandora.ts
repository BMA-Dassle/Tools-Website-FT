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
}

export interface PandoraSignWaiverResult {
  ok: boolean;
  waiverID?: string;
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
    const data = await res.json().catch(() => ({}) as { personId?: string; error?: string });
    if (data.personId) return { personId: data.personId };
    // 4xx = real client error (e.g. missing fields) — fail fast, don't retry.
    if (res.status < 500) throw new Error(data.error || "Failed to create person");
    lastErr = new Error(data.error || `HTTP ${res.status}`); // 5xx — retry
  }
  throw lastErr instanceof Error ? lastErr : new Error("Failed to create person");
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
  const data = await res.json();
  // A missing waiverID means BMI did not record the waiver — fail loudly so the
  // UI keeps the guest on the sign step instead of advancing on a phantom success.
  // Exception: `alreadyValid` — the API verified the person's waiver is valid
  // right now (a Pandora write-then-500 salvaged server-side), which is the
  // outcome we actually need even without a fresh waiverID.
  if (!res.ok || (!data.waiverID && !data.alreadyValid)) {
    throw new Error(data.error || "Waiver signing failed");
  }
  return { ok: true, waiverID: data.waiverID ?? undefined };
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
 */
export async function pandoraOnboardGuest(
  input: PandoraPersonCreateInput & { birthdate: string },
  location?: string,
  /** Waiver display language for the in-house template. Defaults to the ambient
   *  kiosk locale (set by LocaleProvider); callers need not pass it. */
  lang: "en" | "es" = getWaiverLang(),
): Promise<
  | { personId: string; waiverValid: true; template: null; birthdate: string }
  | { personId: string; waiverValid: false; template: PandoraWaiverTemplate; birthdate: string }
> {
  // 1. Create person (usually resolves a known person to their existing record;
  //    NOT a reliable upsert — see the risk note on pandoraCreatePerson)
  const { personId } = await pandoraCreatePerson({ ...input, location });

  // 2. Check if waiver already valid — the response carries the BMI record's
  //    birthdate (membership refresh: BMI wins over what was typed).
  const status = await pandoraCheckWaiver(personId, location);
  const birthdate = status.birthdate ? String(status.birthdate).slice(0, 10) : input.birthdate;
  if (status.valid) {
    return { personId, waiverValid: true, template: null, birthdate };
  }

  // 3. Fetch age-appropriate waiver template from the refreshed birthdate
  const age = calculateAge(birthdate);
  const template = await pandoraFetchWaiverTemplate(age, location, lang);
  return { personId, waiverValid: false, template, birthdate };
}
