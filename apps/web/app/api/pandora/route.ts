import { NextRequest, NextResponse } from "next/server";
import { PANDORA_LOCATION_MAP, PANDORA_DEFAULT_LOCATION_ID } from "@/lib/pandora-locations";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const DEFAULT_LOCATION_ID = PANDORA_DEFAULT_LOCATION_ID;
const LOCATION_MAP: Record<string, string> = PANDORA_LOCATION_MAP;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const personId = searchParams.get("personId");
  const locKey = searchParams.get("location");
  const locationId = (locKey && LOCATION_MAP[locKey]) || DEFAULT_LOCATION_ID;

  // `allRelated=true` makes Firebird join+return every linked family member —
  // expensive. Default it OFF so the common paths (waiver check, per-relative
  // detail fetch) are fast; only the ONE call that needs the family array opts
  // in. (Owner 2026-07-19: returning-racer sign-in took ~a minute because every
  // per-relative /person call was paying the family join.)
  const allRelated = searchParams.get("allRelated") === "true";

  if (!personId) {
    return NextResponse.json({ error: "Missing personId" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${locationId}/${personId}?picture=false&allRelated=${allRelated}`,
      {
        headers: { Authorization: `Bearer ${API_KEY}` },
        cache: "no-store",
      },
    );

    const data = await res.json();

    if (!res.ok || !data.success) {
      // NOT the same as "not found". A person whose BIRTHDATE IS NULL makes
      // this endpoint return 500 "Response Validator Error" — the record
      // exists, the vendor's own response schema rejects it — and booking
      // creates people without a birthdate. Reporting that as "Not found"
      // is how a guest who HAD signed was told to sign again for weeks.
      //
      // Still `valid: false` (fail closed — never wave through an unverified
      // racer), but say which it is, and log it so the repairable ones are
      // findable. PATCH /api/pandora with a birthdate fixes the record.
      const unreadable = res.status >= 500;
      if (unreadable) {
        console.warn(
          `[pandora-get] person ${personId} UNREADABLE (HTTP ${res.status}: ${
            data.error || data.message || "?"
          }) — a null birthdate causes this and is repairable via PATCH`,
        );
      }
      return NextResponse.json({
        valid: false,
        personId,
        unreadable,
        reason: unreadable ? `Unreadable (HTTP ${res.status})` : data.message || "Not found",
      });
    }

    const person = data.data;
    const waiverExpiry = person.waiverExpiry ? new Date(person.waiverExpiry) : null;
    const isValid = waiverExpiry ? waiverExpiry > new Date() : false;

    return NextResponse.json({
      valid: isValid,
      personId,
      firstName: person.firstName,
      lastName: person.lastName,
      // Contact info — Pandora is the reliable source (a login-code lookup never
      // captures these, and BMI's addresses[0] is often empty). Try the common
      // field names so the booking contact pre-fills regardless of shape.
      email: person.email ?? person.emailAddress ?? null,
      phone: person.phoneNumber ?? person.phone ?? person.mobile ?? person.cellPhone ?? null,
      birthdate: person.birthdate || null,
      waiverExpiry: person.waiverExpiry,
      lastVisit: person.lastVisit,
      related: person.related || [],
    });
  } catch {
    return NextResponse.json({ valid: false, personId, reason: "API error" });
  }
}

/** Create a new person in BMI via Pandora */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { firstName, lastName, email, phone, birthdate, guardianID, location } = body;

    if (!firstName || !lastName) {
      return NextResponse.json({ error: "firstName and lastName required" }, { status: 400 });
    }

    const locId = (location && LOCATION_MAP[location]) || DEFAULT_LOCATION_ID;
    const payload: Record<string, string> = {
      locationID: locId,
      firstName,
      lastName,
    };
    if (email) payload.email = email;
    if (phone) payload.phoneNumber = phone.replace(/\D/g, "");
    if (birthdate) payload.birthdate = birthdate;
    if (guardianID) payload.guardianID = guardianID;

    const res = await fetch(`${PANDORA_URL}/bmi/person`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      return NextResponse.json(
        { error: data.message || "Failed to create person" },
        { status: res.status || 500 },
      );
    }

    return NextResponse.json({ personId: data.data.personID });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pandora API error" },
      { status: 500 },
    );
  }
}

/**
 * Update an existing person's contact info in BMI (PATCH /v2/bmi/person).
 * Used to backfill a phone number onto an existing personId so the day-of
 * e-ticket / check-in functions (which read the BMI person record) have it.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { personId, phone, firstName, lastName, email, location, birthdate } = body;
    if (!personId) {
      return NextResponse.json({ error: "personId required" }, { status: 400 });
    }
    // BIRTHDATE backfill. A BMI person with a null birthdate makes Pandora's own
    // GET /bmi/person return 500 "Response Validator Error", which every caller
    // reads as "no waiver" — so a racer who HAS signed shows "Waiver needed" and
    // never reaches the grid. Patching the DOB the kiosk already collected
    // repairs the existing record instead of minting a duplicate.
    if (birthdate) {
      const { patchBmiPersonBirthdate } = await import("@/lib/bmi-person-update");
      const r = await patchBmiPersonBirthdate(String(personId), String(birthdate), {
        locationKey: location,
        firstName,
        lastName,
        email,
        phone,
      });
      if (!r.ok) {
        console.warn(
          `[pandora-patch] birthdate backfill FAILED person=${personId}: ${r.error ?? r.status}`,
        );
        return NextResponse.json({ error: r.error }, { status: r.status || 500 });
      }
      return NextResponse.json({ ok: true, personId: String(personId), patched: "birthdate" });
    }
    const { patchBmiPersonPhone } = await import("@/lib/bmi-person-update");
    const result = await patchBmiPersonPhone(String(personId), String(phone || ""), {
      locationKey: location,
      firstName,
      lastName,
      email,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status || 500 });
    }
    return NextResponse.json({ ok: true, personId: String(personId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pandora API error" },
      { status: 500 },
    );
  }
}
