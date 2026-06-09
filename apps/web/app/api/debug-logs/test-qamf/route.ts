import { NextRequest, NextResponse } from "next/server";
import { getReservation, setReservationCustomer, setReservationStatus } from "@/lib/qamf-bowling";

/**
 * GET /api/debug-logs/test-qamf?centerId=9172&reservationId=X152401
 *
 * Tests the QAMF confirm flow against an existing reservation.
 * Reads the reservation, tries to attach customer, tries to confirm.
 * Returns the raw results at each step.
 */
export async function GET(req: NextRequest) {
  const centerId = parseInt(req.nextUrl.searchParams.get("centerId") ?? "9172", 10);
  const reservationId = req.nextUrl.searchParams.get("reservationId") ?? "";

  if (!reservationId) {
    return NextResponse.json({ error: "reservationId required" }, { status: 400 });
  }

  const steps: Array<{ step: string; result?: unknown; error?: string }> = [];

  // Step 1: Read current state
  try {
    const res = await getReservation(centerId, reservationId);
    steps.push({
      step: "getReservation",
      result: {
        Status: res.Status,
        Title: res.Title,
        Customer: res.Customer,
        Lanes: res.Lanes?.length,
      },
    });
  } catch (err) {
    steps.push({ step: "getReservation", error: err instanceof Error ? err.message : String(err) });
  }

  // Step 2: Attach customer
  try {
    await setReservationCustomer(centerId, reservationId, {
      Guest: { Name: "Test Customer", PhoneNumber: "2395551234", Email: "test@test.com" },
    });
    steps.push({ step: "setReservationCustomer", result: "success (no throw)" });
  } catch (err) {
    steps.push({
      step: "setReservationCustomer",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3: Read state after customer attach
  try {
    const res = await getReservation(centerId, reservationId);
    steps.push({
      step: "getReservation (after customer)",
      result: { Status: res.Status, Title: res.Title, Customer: res.Customer },
    });
  } catch (err) {
    steps.push({
      step: "getReservation (after customer)",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 4: Confirm status
  try {
    const confirmed = await setReservationStatus(centerId, reservationId, "Confirmed");
    steps.push({ step: "setReservationStatus", result: { confirmed } });
  } catch (err) {
    steps.push({
      step: "setReservationStatus",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 5: Read final state
  try {
    const res = await getReservation(centerId, reservationId);
    steps.push({
      step: "getReservation (final)",
      result: { Status: res.Status, Title: res.Title, Customer: res.Customer },
    });
  } catch (err) {
    steps.push({
      step: "getReservation (final)",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ reservationId, centerId, steps });
}
