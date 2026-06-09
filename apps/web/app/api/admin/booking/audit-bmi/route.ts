import { NextRequest, NextResponse } from "next/server";
import { listBowlingReservations } from "@/lib/bowling-db";

/**
 * GET /api/admin/booking/audit-bmi?token=...&dateFrom=2026-05-01&dateTo=2026-06-03
 *
 * Audits race/attraction reservations in Neon against BMI Firebird (via Pandora).
 * Returns a list of reservations with their BMI-side state so we can identify
 * ones that are confirmed in Neon but cancelled in BMI.
 *
 * POST /api/admin/booking/audit-bmi?token=...
 * Body: { recover: true, billIds: ["63000000003..."] }
 *
 * Recovers affected reservations by flipping BMI state back to Confirmation (-3)
 * via Pandora's direct Firebird update.
 */

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";

const PANDORA_LOCATION_IDS: Record<string, string> = {
  "fort-myers": "TXBSQN0FEKQ11",
  fasttrax: "LAB52GY480CJF",
  naples: "PPTR5G2N0QXF7",
};

function auth(req: NextRequest): boolean {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  return !!expected && token === expected;
}

async function pandoraFetchReservation(
  locationId: string,
  reservationId: string,
): Promise<Record<string, unknown> | null> {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  try {
    const res = await fetch(`${PANDORA_BASE}/v2/bmi/reservation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ locationID: locationId, reservationId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.success) return null;
    return body.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pandoraSetState(
  locationId: string,
  projectId: string,
  stateId: string,
): Promise<boolean> {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  try {
    const res = await fetch(`${PANDORA_BASE}/v2/bmi/reservation/state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ locationID: locationId, projectId, stateID: stateId }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  if (!auth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dateFrom = req.nextUrl.searchParams.get("dateFrom") ?? "2026-05-01";
  const dateTo = req.nextUrl.searchParams.get("dateTo") ?? new Date().toISOString().slice(0, 10);

  const reservations = await listBowlingReservations({
    startDate: dateFrom,
    endDate: dateTo,
    productKinds: ["race", "attraction"],
  });

  const results: Array<{
    neonId: number;
    bmiBillId: string | undefined;
    bmiReservationNumber: string | undefined;
    neonStatus: string;
    guestName: string | undefined;
    guestEmail: string | undefined;
    bookedAt: string;
    depositCents: number;
    squarePaymentId: string | undefined;
    bmiState: string | null;
    bmiPayments: unknown;
    mismatch: boolean;
    raw: Record<string, unknown> | null;
  }> = [];

  for (const r of reservations) {
    if (!r.bmiBillId) {
      results.push({
        neonId: r.id,
        bmiBillId: r.bmiBillId,
        bmiReservationNumber: r.bmiReservationNumber,
        neonStatus: r.status,
        guestName: r.guestName,
        guestEmail: r.guestEmail,
        bookedAt: r.bookedAt,
        depositCents: r.depositCents,
        squarePaymentId: r.squareDepositPaymentId,
        bmiState: null,
        bmiPayments: null,
        mismatch: false,
        raw: null,
      });
      continue;
    }

    const locationId =
      PANDORA_LOCATION_IDS[r.centerCode] ||
      (r.productKind === "race" ? "LAB52GY480CJF" : "TXBSQN0FEKQ11");

    const pandora = await pandoraFetchReservation(locationId, r.bmiBillId);

    const bmiState = pandora
      ? String(
          (pandora as Record<string, unknown>).stateId ??
            (pandora as Record<string, unknown>).state ??
            "unknown",
        )
      : "not_found";
    const bmiPayments = pandora?.payments ?? null;

    const neonConfirmed =
      r.status === "confirmed" || r.status === "arrived" || r.status === "completed";
    const bmiCancelled =
      bmiState === "-4" || bmiState === "Cancellation" || bmiState === "cancelled";
    const mismatch = neonConfirmed && bmiCancelled;

    results.push({
      neonId: r.id,
      bmiBillId: r.bmiBillId,
      bmiReservationNumber: r.bmiReservationNumber,
      neonStatus: r.status,
      guestName: r.guestName,
      guestEmail: r.guestEmail,
      bookedAt: r.bookedAt,
      depositCents: r.depositCents,
      squarePaymentId: r.squareDepositPaymentId,
      bmiState,
      bmiPayments,
      mismatch,
      raw: pandora,
    });
  }

  const mismatched = results.filter((r) => r.mismatch);

  return NextResponse.json({
    dateRange: { from: dateFrom, to: dateTo },
    totalReservations: results.length,
    mismatched: mismatched.length,
    mismatchedReservations: mismatched,
    allReservations: results,
  });
}

export async function POST(req: NextRequest) {
  if (!auth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { recover, billIds, centerCode } = body as {
    recover: boolean;
    billIds: string[];
    centerCode?: string;
  };

  if (!recover || !Array.isArray(billIds) || billIds.length === 0) {
    return NextResponse.json(
      { error: "Body must include recover: true and billIds array" },
      { status: 400 },
    );
  }

  const locationId = PANDORA_LOCATION_IDS[centerCode ?? "fasttrax"] ?? "LAB52GY480CJF";

  const recovered: string[] = [];
  const failed: Array<{ billId: string; error: string }> = [];

  for (const billId of billIds) {
    const ok = await pandoraSetState(locationId, billId, "-3");
    if (ok) {
      recovered.push(billId);
      console.log(
        `[audit-recover] recovered ${billId} → state -3 (Confirmation) via ${locationId}`,
      );
    } else {
      failed.push({ billId, error: "Pandora state update failed" });
      console.error(`[audit-recover] FAILED to recover ${billId}`);
    }
  }

  return NextResponse.json({ recovered, failed });
}
