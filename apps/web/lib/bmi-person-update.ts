/**
 * Update an existing BMI person's contact info via the Pandora API.
 *
 * Pandora exposes `PATCH /v2/bmi/person` ("Update existing customer profile in
 * BMI") — body { locationID, personID, firstName?, lastName?, birthdate?,
 * phoneNumber?, email? }. Only locationID + personID are required, so we can
 * update just the phone on an existing person without touching other fields.
 *
 * Why this matters: the day-of e-ticket / check-in functions read the phone off
 * the BMI person record (Pandora `phoneNumber`/`mobile`). Capturing a phone in
 * our own store is not enough — it has to land on the person record too.
 *
 * Pandora person IDs are short (8-digit) alphanumeric/numeric IDs — NOT the
 * 17-digit BMI public-booking IDs — so there's no Number.MAX_SAFE_INTEGER
 * precision risk here. The PATCH schema types personID as a string; we send it
 * as-is.
 */
import { resolvePandoraLocation } from "@/lib/pandora-locations";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";

export interface PatchPersonResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

export async function patchBmiPersonPhone(
  personId: string,
  phone: string,
  opts?: { locationKey?: string; firstName?: string; lastName?: string; email?: string },
): Promise<PatchPersonResult> {
  const apiKey = process.env.SWAGGER_ADMIN_KEY || "";
  if (!apiKey) return { ok: false, status: null, error: "SWAGGER_ADMIN_KEY missing" };
  if (!personId) return { ok: false, status: null, error: "personId required" };

  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 10) return { ok: false, status: null, error: "phone too short" };

  const payload: Record<string, string> = {
    locationID: resolvePandoraLocation(opts?.locationKey ?? "headpinz"),
    personID: String(personId),
    phoneNumber: digits,
  };
  if (opts?.firstName) payload.firstName = opts.firstName;
  if (opts?.lastName) payload.lastName = opts.lastName;
  if (opts?.email) payload.email = opts.email;

  try {
    const res = await fetch(`${PANDORA_URL}/bmi/person`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (!res.ok || data.success === false) {
      return {
        ok: false,
        status: res.status,
        error: (data.message as string) || `HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : "network error" };
  }
}

/**
 * Backfill a BIRTHDATE onto an existing BMI person.
 *
 * ── Why this matters (proven live 2026-08-07) ───────────────────────────────
 * A BMI person with a null birthdate makes Pandora's own `GET /bmi/person`
 * return **500 "Response Validator Error"** — the record exists, but the
 * response fails the vendor's schema. Every consumer treats that as "no
 * waiver": `checkRacerWaiverValid` catches it and returns false, so a racer who
 * signed reads "Waiver needed" and can never be scheduled onto the grid.
 *
 * Measured on 16 Office persons: birthdate present → 8/8 resolved; birthdate
 * absent → 0/8 resolved. Category (-1 vs -8), visibility and membership all
 * appeared on BOTH sides, so the birthdate is the discriminator, not the id
 * format. One PATCH on the owner's test person flipped it from a 500 to a
 * clean read WITH its waiver (2027-08-08) — a waiver that had been on file the
 * whole time and was invisible.
 *
 * So this is a REPAIR, not a create: it never mints a person, which is what the
 * `submitSetup` path used to do when it hit an unresolvable id (and is how one
 * guest ended up with six records).
 */
export async function patchBmiPersonBirthdate(
  personId: string,
  /** ISO `YYYY-MM-DD`. */
  birthdate: string,
  opts?: {
    locationKey?: string;
    firstName?: string;
    lastName?: string;
    /** Sent when known — booking-created records are frequently missing these
     *  too (owner 2026-08-07: "we often miss the email in the patch too"), and
     *  this is one round trip, so repair everything we hold rather than making
     *  the contact details a second, separate gap to chase. */
    email?: string;
    phone?: string;
  },
): Promise<PatchPersonResult> {
  const apiKey = process.env.SWAGGER_ADMIN_KEY || "";
  if (!apiKey) return { ok: false, status: null, error: "SWAGGER_ADMIN_KEY missing" };
  if (!personId) return { ok: false, status: null, error: "personId required" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
    return { ok: false, status: null, error: "birthdate must be YYYY-MM-DD" };
  }

  const payload: Record<string, string> = {
    locationID: resolvePandoraLocation(opts?.locationKey ?? "fasttrax"),
    personID: String(personId),
    birthdate,
  };
  if (opts?.firstName) payload.firstName = opts.firstName;
  if (opts?.lastName) payload.lastName = opts.lastName;
  if (opts?.email) payload.email = opts.email;
  // "Phone numbers must contain only digits" (vendor schema) — send it only
  // when it's a real number, so a malformed one can't fail the whole repair.
  const digits = String(opts?.phone ?? "").replace(/\D/g, "");
  if (digits.length >= 10) payload.phoneNumber = digits;

  try {
    const res = await fetch(`${PANDORA_URL}/bmi/person`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.success === false) {
      return {
        ok: false,
        status: res.status,
        error: (data.message as string) || `HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : "network error" };
  }
}
