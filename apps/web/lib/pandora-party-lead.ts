/**
 * Shared Pandora /bmi/party-lead caller.
 *
 * Used by both the `/api/pandora/party-lead` public proxy AND the
 * `/api/sales-lead/submit` orchestrator — so both paths hit the same
 * field-name normalization, phone-digits stripping, and validation.
 *
 * CRITICAL: the submit orchestrator USED to hit `/api/pandora/party-lead`
 * via internal HTTP fetch, but that required NEXT_PUBLIC_SITE_URL to be
 * set correctly in every environment (it wasn't in prod, so submit
 * failed with "fetch failed"). Calling Pandora directly from this helper
 * removes the hop entirely — faster, more reliable, no env dependency.
 *
 * Schema verified against Pandora swagger at
 *   https://bma-pandora-api.azurewebsites.net/api-docs/  (openapi 3.1, v2.4.9)
 *
 * Required fields (strings):
 *   locationID, firstName, lastName, email, phone (digits only),
 *   eventType, eventDate (YYYY-MM-DD), eventTime (HH:MM),
 *   estimatedGuests (string, NOT number)
 * Optional:
 *   agent, preferredContact, preferredTime, specialRequests, packageType
 */

import { resolvePandoraLocation } from "@/lib/pandora-locations";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";

export interface PartyLeadInput {
  /** Center key ("fasttrax" | "headpinz" | "naples") — resolved to Pandora locationID. */
  location?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  eventType?: string;
  eventDate?: string;
  eventTime?: string;
  /** Either this OR `guestCount` — will be coerced to string. */
  estimatedGuests?: string | number;
  guestCount?: number;
  preferredContact?: string;
  preferredTime?: string;
  specialRequests?: string;
  /** Fallback alias — if `specialRequests` is missing, `notes` is used. */
  notes?: string;
  packageType?: string;
  agent?: string;
}

export interface PartyLeadSuccess {
  ok: true;
  projectID: string;
  projectNumber: string;
  personID?: string;
  assignedAgent: { userId?: string; name?: string } | null;
  /** Raw Pandora payload echoed back for logging/debug. */
  raw: Record<string, unknown>;
}

export interface PartyLeadFailure {
  ok: false;
  /** HTTP-ish status suitable for surfacing back to the caller. */
  status: number;
  error: string;
  /** Parsed Pandora error detail, if any (for logging). */
  detail?: unknown;
}

export type PartyLeadResult = PartyLeadSuccess | PartyLeadFailure;

/** Validate + normalize a caller's body. Returns `{ missing }` if anything required is absent. */
export function validatePartyLead(input: PartyLeadInput): { missing: string[] } {
  const missing: string[] = [];
  if (!input.firstName) missing.push("firstName");
  if (!input.lastName) missing.push("lastName");
  if (!input.email) missing.push("email");
  if (!input.phone) missing.push("phone");
  if (!input.eventType) missing.push("eventType");
  if (!input.eventDate) missing.push("eventDate");
  if (!input.eventTime) missing.push("eventTime");
  const guestsRaw = input.estimatedGuests ?? input.guestCount;
  if (guestsRaw === undefined || guestsRaw === null || guestsRaw === "") {
    missing.push("estimatedGuests");
  }
  return { missing };
}

/** Build the exact JSON body Pandora expects from a caller's friendlier shape. */
export function buildPandoraPayload(input: PartyLeadInput): Record<string, unknown> {
  const locationID = resolvePandoraLocation(input.location);
  const digitsOnlyPhone = String(input.phone ?? "").replace(/\D/g, "");
  const eventTime = String(input.eventTime ?? "").slice(0, 5); // "16:00:00" → "16:00"
  const guestsRaw = input.estimatedGuests ?? input.guestCount;

  const payload: Record<string, unknown> = {
    locationID,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: digitsOnlyPhone,
    eventType: input.eventType,
    eventDate: input.eventDate,
    eventTime,
    estimatedGuests: String(guestsRaw ?? ""),
  };
  if (input.preferredContact) payload.preferredContact = input.preferredContact;
  if (input.preferredTime) payload.preferredTime = input.preferredTime;
  if (input.specialRequests) {
    payload.specialRequests = input.specialRequests;
  } else if (input.notes) {
    payload.specialRequests = input.notes;
  }
  if (input.packageType) payload.packageType = input.packageType;
  if (input.agent) payload.agent = input.agent;
  return payload;
}

/**
 * Submit a party lead to Pandora. Single source of truth — both the proxy
 * route and the submit orchestrator call this.
 */
export async function submitPartyLead(input: PartyLeadInput): Promise<PartyLeadResult> {
  const apiKey = process.env.SWAGGER_ADMIN_KEY;
  if (!apiKey) {
    return { ok: false, status: 500, error: "SWAGGER_ADMIN_KEY not configured" };
  }

  const { missing } = validatePartyLead(input);
  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Missing required fields: ${missing.join(", ")}`,
    };
  }

  const payload = buildPandoraPayload(input);

  let res: Response;
  try {
    res = await fetch(`${PANDORA_URL}/bmi/party-lead`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Pandora fetch error",
    };
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    return {
      ok: false,
      status: res.status || 502,
      error: (data?.message as string) || `Pandora returned ${res.status}`,
      detail: data,
    };
  }

  // Pandora wraps most responses in { success, data, message } — unwrap.
  if (typeof data.success === "boolean" && !data.success) {
    return {
      ok: false,
      status: 400,
      error: (data.message as string) || "Pandora rejected",
      detail: data.error,
    };
  }
  const result = (data.data as Record<string, unknown>) ?? data;

  if (!result.projectID || !result.projectNumber) {
    return {
      ok: false,
      status: 502,
      error: "Pandora response missing projectID / projectNumber",
      detail: result,
    };
  }

  return {
    ok: true,
    projectID: String(result.projectID),
    projectNumber: String(result.projectNumber),
    personID: result.personID !== undefined ? String(result.personID) : undefined,
    assignedAgent: (result.assignedAgent as PartyLeadSuccess["assignedAgent"]) || null,
    raw: result,
  };
}
