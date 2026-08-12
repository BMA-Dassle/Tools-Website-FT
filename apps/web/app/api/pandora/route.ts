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

/**
 * Create a person in BMI — CLOUD-FIRST (owner 2026-08-12: "cloud is first,
 * pandora second"; "ALWAYS mint new users via the BMI api… then a Q to go back
 * once they land local").
 *
 * ── WHY THIS ROUTE IS THE SEAM ─────────────────────────────────────────────
 * Every person mint in the app funnels here: 16 call sites across six surfaces
 * (unified waiver's KioskPartyManager ×6, kiosk booking's KioskPeopleStep ×6,
 * mobile join ×2, kiosk check-in, the web group event) all call
 * `pandoraCreatePerson`/`pandoraOnboardGuest` in lib/pandora.ts, and both of
 * those POST here. So switching the rail HERE moves every surface at once, with
 * no per-site edits and no change to the `{ personId }` contract those callers
 * depend on.
 *
 * ── WHY CLOUD ──────────────────────────────────────────────────────────────
 * A Pandora (LOCAL) mint is born on the side that syncs UP to the vendor cloud,
 * and that leg is the one that jams for hours — which is how a kiosk-minted
 * guest ended up attached in the cloud but invisible locally, staff hand-seated
 * them, and one duplicate T_PROJECT_PERSON stalled Fast WSync for the whole
 * center (2026-08-11). Minting on the CLOUD reverses the direction: cloud→local
 * is the healthy leg (~13-32s, measured), and the booking/attach chain that the
 * guest is waiting on never touches Pandora at all.
 *
 * `createOfficePerson` carries `birthDate` + email + mobile, so the person lands
 * LOCALLY READABLE with no repair needed — the reason this rail beats the
 * public-booking mint, which has no birthdate field and leaves the record
 * answering Pandora with 500 until patched.
 *
 * ── WHAT STILL WAITS ───────────────────────────────────────────────────────
 * For ~13-32s after the mint, Pandora cannot see the person. Anything LOCAL is
 * therefore queued behind a `person-local` barrier rather than fired blind:
 * the waiver record (`/api/pandora/waiver` enqueues on a not-yet-local person),
 * deposits (barrier-gated in the deposit sweep), the grid seat (the kiosk sweep).
 * A birthdate repair is enqueued only when we had no DOB to mint with — that
 * person WOULD read 500 forever otherwise.
 *
 * NOT deduped here on purpose: search-before-create already runs upstream at the
 * call sites, where a picker can be shown (lookupLicenseMatches →
 * matchGateVerdict → LicenseMatchPicker, built after the Gipson incident put 13
 * records on two guests). Adding a blind server-side dedupe would either
 * duplicate that or silently auto-pick, and the owner's rule is that duplicates
 * stay VISIBLE.
 *
 * Kill switch: `PERSON_MINT_CLOUD_FIRST=false` reverts to the Pandora mint
 * byte-for-byte (the `mintViaPandora` path below is the old body, untouched).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { firstName, lastName, email, phone, birthdate, guardianID, location } = body;

    if (!firstName || !lastName) {
      return NextResponse.json({ error: "firstName and lastName required" }, { status: 400 });
    }

    // A GUARDIAN LINK IS A PANDORA-ONLY CONCEPT. `guardianID` ties a minor to
    // the adult who signs for them and there is no Office-side equivalent in the
    // create payload, so those mints stay on the local rail — losing the link
    // would break minor waivers, which is a worse failure than the sync wait.
    const cloudFirst = process.env.PERSON_MINT_CLOUD_FIRST !== "false" && !guardianID;

    if (cloudFirst) {
      const { createOfficePerson } = await import("@/lib/bmi-office-actions");
      const centerCode = location === "naples" ? "naples" : "fort-myers";
      const { personId } = await createOfficePerson({
        firstName,
        lastName,
        birthdate: birthdate || null,
        email: email || null,
        phone: phone || null,
        centerCode,
      });

      const locId = (location && LOCATION_MAP[location]) || DEFAULT_LOCATION_ID;
      try {
        const { enqueueSync } = await import("@/lib/bmi-sync-queue");

        /**
         * DEFAULT REGISTRATION for every new person (owner 2026-08-12: "use
         * default registration for everyone").
         *
         * This enqueue is the piece that was missing: the handler and the
         * registration kind existed, but nothing ever queued a row, so a guest
         * who signed a waiver ended up with an EMPTY Memberships tab in BMI —
         * caught live by the owner on Test 14. A mechanism with no trigger does
         * nothing, which is worse than not having it, because the machinery
         * looks present.
         *
         * It belongs HERE rather than in the waiver flow so every surface that
         * mints a person is covered by one wire — the same reason the mint switch
         * lives in this route.
         *
         * Behind `person-local`: addMembership is a PANDORA write, so it must
         * wait the ~10-30s for the cloud-minted person to reach the center's
         * server. NOT the licence — that arrives with its BMI product.
         */
        await enqueueSync({
          kind: "add-membership",
          idempotencyKey: `registration:${personId}`,
          barrier: "person-local",
          barrierRef: personId,
          locationId: locId,
          payload: { personId, firstName, lastName },
        });

        // Only needed when we minted WITHOUT a birthdate: that record reads 500
        // on Pandora forever, and every consumer treats a 500 as "no waiver".
        // With a DOB the person lands readable and no repair is owed.
        if (!birthdate) {
          await enqueueSync({
            kind: "repair-person-details",
            idempotencyKey: `repair-person:${personId}`,
            barrier: "person-local",
            barrierRef: personId,
            locationId: locId,
            payload: { personId, firstName, lastName, email, phone, locationKey: location },
          });
        }
      } catch (err) {
        // The queue is a backstop, not the mint's success condition — a guest
        // must never fail to be created because a followup could not be queued.
        console.warn(`[pandora] could not enqueue followups for ${personId}:`, err);
      }
      return NextResponse.json({ personId, rail: "office-cloud" });
    }

    return await mintViaPandora({
      firstName,
      lastName,
      email,
      phone,
      birthdate,
      guardianID,
      location,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pandora API error" },
      { status: 500 },
    );
  }
}

/** The pre-cloud-first mint, unchanged — the kill switch's destination, and the
 *  path guardian-linked minors still take. */
async function mintViaPandora(args: {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  birthdate?: string;
  guardianID?: string;
  location?: string;
}): Promise<NextResponse> {
  const locId = (args.location && LOCATION_MAP[args.location]) || DEFAULT_LOCATION_ID;
  const payload: Record<string, string> = {
    locationID: locId,
    firstName: args.firstName,
    lastName: args.lastName,
  };
  if (args.email) payload.email = args.email;
  if (args.phone) payload.phoneNumber = args.phone.replace(/\D/g, "");
  if (args.birthdate) payload.birthdate = args.birthdate;
  if (args.guardianID) payload.guardianID = args.guardianID;

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

  return NextResponse.json({ personId: data.data.personID, rail: "pandora-local" });
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
