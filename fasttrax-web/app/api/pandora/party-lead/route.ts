import { NextRequest, NextResponse } from "next/server";
import { resolvePandoraLocation } from "@/lib/pandora-locations";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

/**
 * POST /api/pandora/party-lead
 *
 * Proxies to Pandora `POST /v2/bmi/party-lead`. Schema verified against
 * https://bma-pandora-api.azurewebsites.net/api-docs/ (openapi 3.1, v2.4.9).
 *
 * Required Pandora fields (strings):
 *   locationID, firstName, lastName, email, phone (digits only!),
 *   eventType, eventDate (YYYY-MM-DD), eventTime (HH:MM),
 *   estimatedGuests (string, not number!)
 *
 * Optional:
 *   agent, preferredContact, preferredTime, specialRequests, packageType
 *
 * Returns `{ projectID, projectNumber, personID, assignedAgent: { userId, name } }`
 * on 201.
 *
 * This proxy accepts the *caller's* friendlier shape (guestCount number,
 * location key, etc.) and normalizes it into Pandora's strict schema.
 */
interface CallerBody {
  location?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  eventType?: string;
  eventDate?: string;
  eventTime?: string;
  estimatedGuests?: string | number;
  guestCount?: number;
  preferredContact?: string;
  preferredTime?: string;
  specialRequests?: string;
  notes?: string;
  packageType?: string;
  agent?: string;
  [key: string]: unknown;
}

export async function POST(req: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json({ error: "Pandora key not configured" }, { status: 500 });
  }

  let body: CallerBody;
  try {
    body = (await req.json()) as CallerBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate required fields up front so we fail fast with a clear message
  // instead of forwarding garbage and getting Pandora's Zod error.
  const missing: string[] = [];
  if (!body.firstName) missing.push("firstName");
  if (!body.lastName) missing.push("lastName");
  if (!body.email) missing.push("email");
  if (!body.phone) missing.push("phone");
  if (!body.eventType) missing.push("eventType");
  if (!body.eventDate) missing.push("eventDate");
  if (!body.eventTime) missing.push("eventTime");
  const guestsRaw = body.estimatedGuests ?? body.guestCount;
  if (guestsRaw === undefined || guestsRaw === null || guestsRaw === "") {
    missing.push("estimatedGuests");
  }
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  const locationID = resolvePandoraLocation(body.location);

  // Normalize to Pandora's strict schema.
  //   - phone → digits only (Pandora rejects `+`, spaces, parens)
  //   - estimatedGuests → string (Pandora accepts only strings here)
  //   - eventTime → HH:MM (drop any seconds)
  //   - specialRequests inherits from notes if caller used that name
  const digitsOnlyPhone = String(body.phone).replace(/\D/g, "");
  const eventTime = String(body.eventTime).slice(0, 5); // "16:00:00" → "16:00"

  const payload: Record<string, unknown> = {
    locationID,
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: digitsOnlyPhone,
    eventType: body.eventType,
    eventDate: body.eventDate,
    eventTime,
    estimatedGuests: String(guestsRaw),
  };
  if (body.preferredContact) payload.preferredContact = body.preferredContact;
  if (body.preferredTime) payload.preferredTime = body.preferredTime;
  if (body.specialRequests) {
    payload.specialRequests = body.specialRequests;
  } else if (body.notes) {
    payload.specialRequests = body.notes;
  }
  if (body.packageType) payload.packageType = body.packageType;
  if (body.agent) payload.agent = body.agent;

  try {
    const res = await fetch(`${PANDORA_URL}/bmi/party-lead`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data) {
      return NextResponse.json(
        { error: data?.message || `Pandora returned ${res.status}` },
        { status: res.status || 502 },
      );
    }

    // Pandora wraps most responses in { success, data, message } — unwrap.
    if (typeof data.success === "boolean" && !data.success) {
      return NextResponse.json({ error: data.message || "Pandora rejected" }, { status: 400 });
    }
    const result = data.data ?? data;

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pandora API error" },
      { status: 502 },
    );
  }
}
