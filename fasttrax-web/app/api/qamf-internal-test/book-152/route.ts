import { NextRequest, NextResponse } from "next/server";
import {
  searchAvailability,
  createReservation,
  setReservationCustomer,
  setReservationStatus,
  getReservation,
  type Reservation,
} from "@/lib/qamf-bowling";

/**
 * One-shot booking smoke-test for the QubicaAMF Internal API.
 *
 *   GET /api/qamf-internal-test/book-152?bookedAt=2026-05-08T18:00:00-04:00
 *
 * Walks the full flow against web offer 152 at HeadPinz Fort Myers
 * (centerId = 9172):
 *
 *   1. searchAvailability        — verify 152 covers the requested time
 *   2. createReservation         — gets a temporary X-id reservation
 *   3. setReservationCustomer    — attaches a test contact
 *   4. setReservationStatus      — Temporary → Confirmed
 *   5. getReservation            — read back the final state
 *
 * Each step's response (or error) is collected so the caller sees
 * exactly where the flow halts. Useful for proving end-to-end auth
 * + payload shapes once QubicaAMF grants the BMA client access at
 * the bowling-reservations service level (currently every call
 * returns 401 despite valid OAuth — provisioning gap on their side).
 *
 * NOT an admin route — gate by ?token=… matching ADMIN_CAMERA_TOKEN
 * since this attempts a real reservation creation. Keep it dev/ops
 * only until the booking flow is properly productized.
 */

const CENTER_ID = 9172;       // HeadPinz Fort Myers (BMA Pandora id;
                              // confirm with QAMF whether their internal
                              // bowling-reservations centerId differs)
const WEB_OFFER_ID = 152;

interface StepResult {
  step: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  ms: number;
}

async function timed<T>(name: string, fn: () => Promise<T>): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const data = await fn();
    return { step: name, ok: true, data, ms: Date.now() - t0 };
  } catch (err) {
    return {
      step: name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - t0,
    };
  }
}

export async function GET(req: NextRequest) {
  // Admin-token gate — this endpoint will create real reservations
  // once auth works. Don't expose to the public.
  const token = req.nextUrl.searchParams.get("token");
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Required env check up front so the error message is actionable.
  if (!process.env.QAMF_BOWLING_CLIENT_ID || !process.env.QAMF_BOWLING_CLIENT_SECRET) {
    return NextResponse.json(
      {
        ok: false,
        blocked: "QAMF_BOWLING_CLIENT_ID / QAMF_BOWLING_CLIENT_SECRET not set",
        hint: "OAuth credentials missing — token mint will fail before we even call the bowling API.",
      },
      { status: 503 },
    );
  }

  const bookedAt =
    req.nextUrl.searchParams.get("bookedAt") ||
    // default: tomorrow at 6 PM local (EDT offset hard-coded; switch
    // to EST in winter or pass an explicit ?bookedAt= when needed)
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16) + ":00.0000000-04:00";

  // ── Step 1 — availability search ─────────────────────────────────
  const availability = await timed("searchAvailability", () =>
    searchAvailability(CENTER_ID, {
      BookedAtRange: {
        StartAt: bookedAt,
        EndAt: new Date(new Date(bookedAt).getTime() + 60 * 60 * 1000).toISOString(),
      },
      TotalPlayers: 2,
      WebOffer: { Services: ["BookForLater"] },
    }),
  );

  // ── Step 2 — create temporary reservation ────────────────────────
  // We attempt regardless of availability response — the user wanted
  // a real attempt at web offer 152, not a probe.
  const create = await timed<Reservation>("createReservation", () =>
    createReservation(CENTER_ID, {
      BookedAt: bookedAt,
      Title: "QubicaAMF Internal API Smoke Test",
      Notes: "Automated test booking from FastTrax/HeadPinz integration",
      Customer: {
        ExternalId: `smoke-${Date.now()}`,
        Guest: {
          Name: "Test Booker",
          PhoneNumber: "2395551234",
          Email: "ops@fasttraxent.com",
        },
      },
      WebOffer: {
        Id: WEB_OFFER_ID,
        Options: {
          // The right options sub-object depends on the offer type.
          // Without a successful weboffers call we can't know whether
          // 152 is Time / Game / Unlimited — try Time first since it's
          // the most common config.
          Time: [],
        },
        Services: ["BookForLater"],
      },
      TotalPlayers: 2,
      Lanes: [],
    }),
  );

  // If create succeeded, we have a reservation Id; chain the rest.
  let reservationId: string | undefined;
  if (create.ok && create.data && typeof (create.data as Reservation).Id === "string") {
    reservationId = (create.data as Reservation).Id;
  }

  const customer: StepResult | null = reservationId
    ? await timed("setReservationCustomer", () =>
        setReservationCustomer(CENTER_ID, reservationId!, {
          ExternalId: `smoke-${reservationId}`,
          Guest: {
            Name: "Test Booker",
            PhoneNumber: "2395551234",
            Email: "ops@fasttraxent.com",
          },
        }),
      )
    : null;

  const confirm: StepResult | null = reservationId
    ? await timed("setReservationStatus(Confirmed)", () =>
        setReservationStatus(CENTER_ID, reservationId!, "Confirmed"),
      )
    : null;

  const read: StepResult | null = reservationId
    ? await timed("getReservation", () => getReservation(CENTER_ID, reservationId!))
    : null;

  return NextResponse.json({
    centerId: CENTER_ID,
    webOfferId: WEB_OFFER_ID,
    bookedAt,
    reservationId: reservationId ?? null,
    steps: [availability, create, ...(customer ? [customer] : []), ...(confirm ? [confirm] : []), ...(read ? [read] : [])],
  });
}
