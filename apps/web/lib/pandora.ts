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
  /** Duration in days */
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
  // the first request after idle. Create is upsert-style (a known person resolves
  // to the same personId), so retrying a 5xx is safe and avoids the onboard
  // throwing — which previously left the guest stuck on the name step, unable to
  // advance to the booking screen. 4xx (real client error) is NOT retried.
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
): Promise<PandoraWaiverTemplate> {
  const params = new URLSearchParams({ age: String(age) });
  if (location) params.set("location", location);
  const res = await getWithRetry(`/api/pandora/waiver?${params}`);
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
  if (!res.ok || !data.waiverID) {
    throw new Error(data.error || "Waiver signing failed");
  }
  return { ok: true, waiverID: data.waiverID };
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
 */
export function calculateWaiverExpiry(durationDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + (durationDays || 365));
  return d.toISOString().split("T")[0];
}

/**
 * Full waiver onboarding flow: create person → check waiver → fetch template if needed.
 *
 * Returns either:
 *   - `{ personId, waiverValid: true }` if waiver is already signed
 *   - `{ personId, waiverValid: false, template }` if waiver needs signing
 */
export async function pandoraOnboardGuest(
  input: PandoraPersonCreateInput & { birthdate: string },
  location?: string,
): Promise<
  | { personId: string; waiverValid: true; template: null }
  | { personId: string; waiverValid: false; template: PandoraWaiverTemplate }
> {
  // 1. Create person
  const { personId } = await pandoraCreatePerson({ ...input, location });

  // 2. Check if waiver already valid
  const status = await pandoraCheckWaiver(personId, location);
  if (status.valid) {
    return { personId, waiverValid: true, template: null };
  }

  // 3. Fetch age-appropriate waiver template
  const age = calculateAge(input.birthdate);
  const template = await pandoraFetchWaiverTemplate(age, location);
  return { personId, waiverValid: false, template };
}
