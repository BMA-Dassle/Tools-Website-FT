import { NextRequest, NextResponse } from "next/server";
import {
  createReservation,
  setReservationCustomer,
  setReservationStatus,
  getReservation,
  deleteReservation,
  type Reservation,
} from "@/lib/qamf-bowling";
import { getQamfBowlingToken, getQamfSubscriptionKey } from "@/lib/qamf-bowling-auth";

/**
 * GET /api/admin/qamf-internal-test/patch-reschedule?bookedAt=...&newTime=...
 *
 * Creates a test reservation, then tries EVERY possible PATCH / PUT
 * payload shape to change BookedAt. Reports which ones QAMF accepts.
 *
 * This is a diagnostic endpoint — creates + cleans up its own reservation.
 *
 * Query params:
 *   bookedAt  — initial booking time (default: tomorrow 6 PM ET)
 *   newTime   — target reschedule time (default: tomorrow 7 PM ET)
 */

const CENTER_ID = 9172;
const WEB_OFFER_ID = 152;
const BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VERSION = "2025-12-01.1.0";

interface ProbeResult {
  label: string;
  method: string;
  path: string;
  body: unknown;
  status: number;
  ok: boolean;
  responseBody: string;
  ms: number;
}

/** Raw fetch with token — bypasses qamfAuthedFetch so we can see actual status codes */
async function rawQamfFetch(
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; ok: boolean; text: string }> {
  const token = await getQamfBowlingToken(CENTER_ID);
  const subKey = getQamfSubscriptionKey();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "api-version": API_VERSION,
    "content-type": "application/json",
  };
  if (subKey) headers["Ocp-Apim-Subscription-Key"] = subKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, text };
}

async function probe(
  label: string,
  method: string,
  path: string,
  body: unknown,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const { status, ok, text } = await rawQamfFetch(method, path, body);
  return {
    label,
    method,
    path,
    body,
    status,
    ok,
    responseBody: text.slice(0, 500),
    ms: Date.now() - t0,
  };
}

export async function GET(req: NextRequest) {
  if (!process.env.QAMF_BOWLING_CLIENT_ID || !process.env.QAMF_BOWLING_CLIENT_SECRET) {
    return NextResponse.json({ ok: false, error: "QAMF credentials not set" }, { status: 503 });
  }

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const dateStr = tomorrow.toISOString().slice(0, 10);
  const bookedAt = req.nextUrl.searchParams.get("bookedAt") || `${dateStr}T18:00:00.0000000-04:00`;
  const newTime = req.nextUrl.searchParams.get("newTime") || `${dateStr}T19:00:00.0000000-04:00`;

  const results: {
    setup: unknown;
    reservationId: string | null;
    bookedAt: string;
    newTime: string;
    probes: ProbeResult[];
    cleanup: unknown;
  } = {
    setup: null,
    reservationId: null,
    bookedAt,
    newTime,
    probes: [],
    cleanup: null,
  };

  // ── Step 1: Create a test reservation ──────────────────────────────
  let reservationId: string;
  try {
    const created = await createReservation(CENTER_ID, {
      BookedAt: bookedAt,
      Title: "PATCH Reschedule Test",
      Notes: "Automated probe — will be deleted",
      Customer: {
        Guest: {
          Name: "Patch Tester",
          PhoneNumber: "2395559999",
          Email: "test@fasttraxent.com",
        },
      },
      WebOffer: {
        Id: WEB_OFFER_ID,
        Options: { Time: [] },
        Services: ["BookForLater"],
      },
      TotalPlayers: 2,
    });
    reservationId = created.Id;
    results.setup = { ok: true, reservationId, status: created.Status };
    results.reservationId = reservationId;
  } catch (err) {
    results.setup = { ok: false, error: err instanceof Error ? err.message : String(err) };
    return NextResponse.json(results);
  }

  // Confirm it so it's in Confirmed state (like a real reservation)
  try {
    await setReservationCustomer(CENTER_ID, reservationId, {
      Guest: { Name: "Patch Tester", PhoneNumber: "2395559999", Email: "test@fasttraxent.com" },
    });
    await setReservationStatus(CENTER_ID, reservationId, "Confirmed");
  } catch (err) {
    // Non-fatal for probing — continue anyway
    results.setup = {
      ...results.setup as object,
      confirmWarning: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Step 2: Try EVERY plausible PATCH / PUT shape ──────────────────
  const resPath = `/centers/${CENTER_ID}/reservations/${reservationId}`;

  // Probe 1: PATCH /reservations/{id} with { BookedAt }
  results.probes.push(
    await probe(
      "PATCH reservation with { BookedAt }",
      "PATCH",
      resPath,
      { BookedAt: newTime },
    ),
  );

  // Probe 2: PATCH with { BookedAt, Status } (maybe needs both?)
  results.probes.push(
    await probe(
      "PATCH with { BookedAt, Status }",
      "PATCH",
      resPath,
      { BookedAt: newTime, Status: "Confirmed" },
    ),
  );

  // Probe 3: PATCH with full-ish reservation body
  results.probes.push(
    await probe(
      "PATCH with full body (BookedAt + Title + WebOffer)",
      "PATCH",
      resPath,
      {
        BookedAt: newTime,
        Title: "PATCH Reschedule Test (moved)",
        WebOffer: {
          Id: WEB_OFFER_ID,
          Options: { Time: [] },
          Services: ["BookForLater"],
        },
        TotalPlayers: 2,
      },
    ),
  );

  // Probe 4: PUT on the reservation root (some APIs use PUT for full replace)
  results.probes.push(
    await probe(
      "PUT reservation with { BookedAt }",
      "PUT",
      resPath,
      { BookedAt: newTime },
    ),
  );

  // Probe 5: PUT with fuller body
  results.probes.push(
    await probe(
      "PUT with full body",
      "PUT",
      resPath,
      {
        BookedAt: newTime,
        Title: "PATCH Reschedule Test (PUT)",
        Status: "Confirmed",
        WebOffer: {
          Id: WEB_OFFER_ID,
          Options: { Time: [] },
          Services: ["BookForLater"],
        },
        TotalPlayers: 2,
      },
    ),
  );

  // Probe 6: PATCH /reservations/{id}/bookedAt (sub-resource, like /status)
  results.probes.push(
    await probe(
      "PATCH /bookedAt sub-resource { BookedAt }",
      "PATCH",
      `${resPath}/bookedAt`,
      { BookedAt: newTime },
    ),
  );

  // Probe 7: PUT /reservations/{id}/bookedAt
  results.probes.push(
    await probe(
      "PUT /bookedAt sub-resource { BookedAt }",
      "PUT",
      `${resPath}/bookedAt`,
      { BookedAt: newTime },
    ),
  );

  // Probe 8: PATCH /bookedAt with just the string value
  results.probes.push(
    await probe(
      "PATCH /bookedAt with raw string value",
      "PATCH",
      `${resPath}/bookedAt`,
      newTime,
    ),
  );

  // Probe 9: PATCH /reservations/{id}/reschedule (maybe there's a dedicated endpoint?)
  results.probes.push(
    await probe(
      "PATCH /reschedule { BookedAt }",
      "PATCH",
      `${resPath}/reschedule`,
      { BookedAt: newTime },
    ),
  );

  // Probe 10: POST /reservations/{id}/reschedule
  results.probes.push(
    await probe(
      "POST /reschedule { BookedAt, WebOffer }",
      "POST",
      `${resPath}/reschedule`,
      {
        BookedAt: newTime,
        WebOffer: {
          Id: WEB_OFFER_ID,
          Options: { Time: [] },
          Services: ["BookForLater"],
        },
      },
    ),
  );

  // Probe 11: PATCH with "Reservation" wrapper (some APIs nest the payload)
  results.probes.push(
    await probe(
      "PATCH with { Reservation: { BookedAt } } wrapper",
      "PATCH",
      resPath,
      { Reservation: { BookedAt: newTime } },
    ),
  );

  // Probe 12: Verify final state — did any PATCH actually change BookedAt?
  let finalState: Reservation | null = null;
  try {
    finalState = await getReservation(CENTER_ID, reservationId);
  } catch { /* ignore */ }

  // ── Step 3: Clean up ───────────────────────────────────────────────
  try {
    await deleteReservation(CENTER_ID, reservationId);
    results.cleanup = { ok: true };
  } catch (err) {
    results.cleanup = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return NextResponse.json({
    ...results,
    finalState: finalState
      ? { BookedAt: finalState.BookedAt, Status: finalState.Status, Id: finalState.Id }
      : null,
    summary: {
      anySuccess: results.probes.some((p) => p.ok),
      successfulProbes: results.probes.filter((p) => p.ok).map((p) => p.label),
    },
  });
}
