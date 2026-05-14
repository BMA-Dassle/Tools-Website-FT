import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingReservation,
  getBowlingReservationByShortCode,
  getReservationsByCheckoutGroup,
  type BowlingReservation,
} from "@/lib/bowling-db";

/**
 * GET /api/checkout/v2/confirmation?code={shortCode}
 * GET /api/checkout/v2/confirmation?neonId={id}
 *
 * Refresh-proof confirmation endpoint. When the unified confirmation page
 * loses sessionStorage (page refresh, navigation), this reconstructs the
 * minimal data needed to bootstrap the confirmation hooks.
 *
 * Flow:
 *   1. Resolve the primary reservation from Neon (by shortCode or neonId)
 *   2. If it has a checkoutGroupId, fetch all sibling rows (mixed cart)
 *   3. Categorize into bowling / racing / attractions
 *   4. Return the data shape the confirmation page needs
 *
 * The bowling and racing hooks do their own data fetching (Neon reservation,
 * booking-record, QR codes, etc.). This endpoint only provides the routing
 * data: what's in the cart and what IDs to pass to each hook.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const neonIdParam = url.searchParams.get("neonId");
  const neonId = neonIdParam ? parseInt(neonIdParam, 10) : 0;

  if (!code && !neonId) {
    return NextResponse.json(
      { error: "code or neonId required" },
      { status: 400 },
    );
  }

  try {
    // ── Step 1: Resolve primary reservation ─────────────────────────
    let primary: BowlingReservation | null = null;

    if (code) {
      const result = await getBowlingReservationByShortCode(code);
      if (result) primary = result;
    } else if (neonId > 0) {
      const result = await getBowlingReservation(neonId);
      if (result) primary = result;
    }

    if (!primary) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // ── Step 2: Get all siblings in the checkout group ──────────────
    let allRecords: BowlingReservation[] = [primary];
    if (primary.checkoutGroupId) {
      const siblings = await getReservationsByCheckoutGroup(primary.checkoutGroupId);
      if (siblings.length > 0) {
        allRecords = siblings;
      }
    }

    // ── Step 3: Categorize records ──────────────────────────────────
    const bowlingRecords = allRecords.filter(
      (r) => r.productKind === "open" || r.productKind === "kbf",
    );
    const racingRecords = allRecords.filter(
      (r) => r.productKind === "racing",
    );
    const attractionRecords = allRecords.filter(
      (r) =>
        r.productKind !== "open" &&
        r.productKind !== "kbf" &&
        r.productKind !== "racing",
    );

    // ── Step 4: Build response ──────────────────────────────────────
    const bowlingRecord = bowlingRecords[0] ?? null;
    const racingRecord = racingRecords[0] ?? null;

    // Build attraction summaries from attraction_bookings JSON.
    // Includes BOTH non-racing attractions AND racing items so the
    // confirmation page can show heat cards on refresh (when
    // sessionStorage with racerAssignments is gone).
    const attractions: Array<{
      name: string;
      quantity: number;
      date: string;
      time: string | null;
    }> = [];

    // Non-racing attractions
    for (const rec of attractionRecords) {
      if (rec.attractionBookings && rec.attractionBookings.length > 0) {
        for (const ab of rec.attractionBookings) {
          attractions.push({
            name: ab.name || rec.attractionSlug || "Attraction",
            quantity: ab.quantity || 1,
            date: rec.bookedAt?.split("T")[0] ?? "",
            time: ab.timeSlot || null,
          });
        }
      } else {
        // Fallback: attraction row without JSON detail
        attractions.push({
          name: rec.attractionSlug
            ? rec.attractionSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
            : "Attraction",
          quantity: rec.playerCount ?? 1,
          date: rec.bookedAt?.split("T")[0] ?? "",
          time: null,
        });
      }
    }

    // Racing items — included in attractions so the confirmation page's
    // buildRacingPreResolved() can reconstruct heat cards on refresh
    for (const rec of racingRecords) {
      if (rec.attractionBookings && rec.attractionBookings.length > 0) {
        for (const ab of rec.attractionBookings) {
          attractions.push({
            name: ab.name || "Racing",
            quantity: ab.quantity || 1,
            date: rec.bookedAt?.split("T")[0] ?? "",
            time: ab.timeSlot || null,
          });
        }
      } else {
        attractions.push({
          name: "Racing",
          quantity: rec.playerCount ?? 1,
          date: rec.bookedAt?.split("T")[0] ?? "",
          time: null,
        });
      }
    }

    const hasBowling = bowlingRecords.length > 0;
    const hasRacing = racingRecords.length > 0;
    // hasAttractions for bookingType: only count non-racing attractions
    const hasAttractions = attractionRecords.length > 0;

    const response = {
      // Core
      bookingType: hasBowling && (hasRacing || hasAttractions)
        ? "mixed"
        : hasBowling
          ? "bowling"
          : hasRacing
            ? "racing"
            : "attractions",

      // Bowling section data (only populated when there's a bowling record)
      bowlingNeonId: bowlingRecord?.id ?? null,
      bowlingShortCode: bowlingRecord?.shortCode ?? null,
      bowlingKind: bowlingRecord?.productKind ?? null,

      // Racing section data
      bmiBillId: racingRecord?.bmiBillId ?? primary.bmiBillId ?? null,
      bmiReservationNumber:
        racingRecord?.bmiReservationNumber ??
        primary.bmiReservationNumber ??
        null,
      isRacingCart: hasRacing,

      // Attractions (includes racing items for confirmation page heat cards)
      attractions: attractions.length > 0 ? attractions : [],

      // Guest info (from primary record)
      guestName: primary.guestName ?? null,
      guestEmail: primary.guestEmail ?? null,

      // Payment (from primary — unified checkout shares a single deposit)
      depositPaidCents: primary.depositCents ?? 0,
      totalCents: primary.totalCents ?? 0,

      // Status
      status: primary.status,
    };

    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[checkout/v2/confirmation] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
