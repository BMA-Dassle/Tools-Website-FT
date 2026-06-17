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
