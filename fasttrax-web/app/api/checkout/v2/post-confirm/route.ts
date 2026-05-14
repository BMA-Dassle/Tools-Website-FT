import { NextRequest, NextResponse } from "next/server";
import { readOrderMetadata } from "@/lib/square-deposit-order";

// Vercel default is 15s — this pipeline needs ~20s for returning racers
// (8s Pandora delay + sequential fetches). Without this, the function is
// killed before the notification step (Step 9) ever runs.
export const maxDuration = 60;

/**
 * POST /api/checkout/v2/post-confirm
 *
 * Server-side post-payment orchestration pipeline for racing bookings.
 * Fired as fire-and-forget from checkout/v2 AFTER the customer has been
 * charged and redirected to the confirmation page.
 *
 * Replaces 13+ client-side steps from the old /book/confirmation page:
 *   1. Update booking record with reservation data
 *   2. Create booking record with racer assignments
 *   3. Pandora schedule linking (8s delay for BMI→Pandora sync)
 *   4. Waiver check per personId via Pandora
 *   5. Express Lane flag (all waivers valid)
 *   6. Express Lane memo on BMI reservation
 *   7. Resolve waiver URL via BMI Office
 *   8. Claim POV codes
 *   9. POV memo on BMI reservation
 *  10. Full notification with all racing-specific fields
 *
 * Data backbone: reads from Square order metadata (written by checkout/v2
 * after confirms), with direct params as fallback.
 *
 * Idempotent: booking-record dedup is by billId, POV claim is by billId,
 * notification is by billId (Redis notif: key). Safe to retry.
 */

// ── Config ──────────────────────────────────────────────────────────────────

const BOOKING_API_KEY = process.env.BOOKING_RECORD_API_KEY || process.env.BOOKING_API_KEY || "";

// ── Types ───────────────────────────────────────────────────────────────────

interface PostConfirmBody {
  /** May be null for credit-only / $0 bookings where no Square order was created. */
  squareDayofOrderId: string | null;
  bmiBillId: string | null;
  bmiReservationNumber: string | null;
  locationKey: string;
  clientKey: string;
  guest: { name: string; email: string; phone: string };
  smsOptIn: boolean;
  racerData: Array<{
    name: string;
    personId?: string;
    product?: string;
    track?: string;
    heatStart?: string;
  }> | null;
  primaryPersonId: string | null;
  packageId: string | null;
  neonIds: number[];
  checkoutGroupId: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Delay helper */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Internal fetch with origin awareness */
function internalUrl(req: NextRequest, path: string): string {
  return `${req.nextUrl.origin}${path}`;
}

// ── POST Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startMs = Date.now();
  const results: Record<string, unknown> = {};

  try {
    const body = (await req.json()) as PostConfirmBody;
    const {
      squareDayofOrderId,
      bmiBillId,
      bmiReservationNumber,
      locationKey,
      clientKey,
      guest,
      smsOptIn,
      primaryPersonId,
      packageId,
      neonIds,
    } = body;

    // Racer data: prefer direct params, fall back to Square metadata
    let racers = body.racerData || [];
    let metaPackageId = packageId;
    let metaPovQty = 0;

    if (squareDayofOrderId) {
      const meta = await readOrderMetadata(squareDayofOrderId);
      if (meta) {
        // Parse compact racer JSON from metadata if not in params
        if (!racers.length && meta.racers) {
          try {
            const compact = JSON.parse(meta.racers) as Array<{
              n: string; p?: string; t?: string; h?: string;
            }>;
            racers = compact.map((r) => ({
              name: r.n,
              personId: r.p || undefined,
              track: r.t || undefined,
              heatStart: r.h || undefined,
            }));
          } catch { /* bad JSON in metadata */ }
        }
        if (!metaPackageId && meta.package_id) metaPackageId = meta.package_id;
        if (meta.pov_qty) metaPovQty = parseInt(meta.pov_qty, 10) || 0;
      }
    }

    const personIds = racers
      .map((r) => r.personId)
      .filter((p): p is string => !!p);
    const hasReturningRacers = personIds.length > 0;
    const isRookiePack = metaPackageId?.startsWith("rookie-pack") ?? false;
    const ck = clientKey || "headpinzftmyers";

    console.log(
      `[post-confirm] Start: sqOrder=${squareDayofOrderId || "none"} bill=${bmiBillId} ` +
      `res=${bmiReservationNumber} racers=${racers.length} personIds=${personIds.length} ` +
      `pkg=${metaPackageId || "none"} pov=${metaPovQty}`,
    );

    // ── Step 1: Create/update booking record ─────────────────────────
    // The booking-record is a Redis-backed cache that the checkin-cron,
    // express-lane alerter, and admin dashboard all read.
    if (bmiBillId) {
      try {
        const bookingRecordBody: Record<string, unknown> = {
          billId: bmiBillId,
          date: new Date().toISOString().split("T")[0],
          contact: {
            firstName: guest.name.split(/\s+/)[0] || guest.name,
            lastName: guest.name.split(/\s+/).slice(1).join(" ") || "",
            email: guest.email,
            phone: guest.phone,
          },
          smsOptIn,
          status: "confirmed",
          confirmedAt: new Date().toISOString(),
        };

        if (bmiReservationNumber) {
          bookingRecordBody.reservationNumber = bmiReservationNumber;
        }
        if (primaryPersonId) {
          bookingRecordBody.primaryPersonId = primaryPersonId;
        }
        if (metaPackageId) {
          bookingRecordBody.package = metaPackageId;
        }

        // Racer assignments — full shape for the booking record
        if (racers.length > 0) {
          bookingRecordBody.racers = racers.map((r) => ({
            racerName: r.name,
            personId: r.personId || null,
            product: r.product || null,
            track: r.track || null,
            heatStart: r.heatStart || null,
          }));
        }

        const recRes = await fetch(internalUrl(req, "/api/booking-record"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": BOOKING_API_KEY,
          },
          body: JSON.stringify(bookingRecordBody),
        });
        results.bookingRecord = recRes.ok ? "created" : `failed:${recRes.status}`;
      } catch (err) {
        results.bookingRecord = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── Step 2: Pandora schedule linking (racing returning racers) ────
    // BMI→Pandora sync takes ~5-8 seconds. Delay before attempting.
    let pandoraLinked = false;
    if (bmiReservationNumber && hasReturningRacers) {
      try {
        await delay(8000);
        const schedRes = await fetch(internalUrl(req, "/api/pandora/schedule"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resNumber: bmiReservationNumber,
            racers: racers.map((r) => ({
              racerName: r.name,
              personId: r.personId || null,
              product: r.product || null,
              track: r.track || null,
              heatStart: r.heatStart || null,
            })),
          }),
        });
        if (schedRes.ok) {
          pandoraLinked = true;
          results.pandoraSchedule = "linked";
        } else {
          results.pandoraSchedule = `failed:${schedRes.status}`;
        }
      } catch (err) {
        results.pandoraSchedule = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── Step 3: Waiver check per personId ────────────────────────────
    let allWaiversValid = false;
    if (hasReturningRacers) {
      try {
        const waiverChecks = await Promise.all(
          personIds.map((pid) =>
            fetch(internalUrl(req, `/api/pandora?personId=${pid}`))
              .then((r) => r.json())
              .catch(() => ({ valid: false })),
          ),
        );
        allWaiversValid =
          waiverChecks.length > 0 &&
          waiverChecks.every((w: { valid: boolean }) => w.valid);
        results.waiverCheck = allWaiversValid
          ? "all_valid"
          : `invalid:${waiverChecks.filter((w: { valid: boolean }) => !w.valid).length}`;
      } catch (err) {
        results.waiverCheck = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── Step 4: Update booking record with Express Lane + session IDs ─
    if (bmiBillId && hasReturningRacers) {
      try {
        await fetch(internalUrl(req, "/api/booking-record"), {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-api-key": BOOKING_API_KEY,
          },
          body: JSON.stringify({
            billId: bmiBillId,
            fastLane: allWaiversValid,
          }),
        });
        results.expressLaneFlag = allWaiversValid ? "set" : "not_eligible";
      } catch (err) {
        results.expressLaneFlag = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── Step 5: Express Lane memo on BMI reservation ─────────────────
    if (allWaiversValid && bmiReservationNumber && bmiBillId) {
      try {
        const memoQs = new URLSearchParams({
          endpoint: "booking/memo",
          clientKey: ck,
        });
        // Raw JSON for BMI orderId precision — NEVER use JSON.stringify for orderId
        const memoBody = `{"orderId":${bmiBillId},"memo":"Express Lane — ${bmiReservationNumber}"}`;
        await fetch(internalUrl(req, `/api/bmi?${memoQs.toString()}`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: memoBody,
        });
        results.expressLaneMemo = "written";
      } catch (err) {
        results.expressLaneMemo = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── Step 6: Fetch BMI bill overview for waiver URL + POV detection ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let overview: any = null;
    let waiverUrl = "";
    const isNewRacer = !hasReturningRacers;

    if (bmiBillId) {
      try {
        const ovRes = await fetch(
          internalUrl(req, `/api/sms?endpoint=bill%2Foverview&billId=${bmiBillId}&clientKey=${ck}`),
        );
        if (ovRes.ok) {
          overview = await ovRes.json();
        }
      } catch (err) {
        results.billOverview = `error:${err instanceof Error ? err.message : String(err)}`;
      }

      // Resolve waiver URL for new racers
      if (isNewRacer && overview) {
        try {
          const projectId = overview.id || bmiBillId;
          const projRes = await fetch(
            internalUrl(req, `/api/bmi-office?action=project&id=${projectId}`),
          );
          if (projRes.ok) {
            const proj = await projRes.json();
            if (proj.projectReference) {
              waiverUrl = `https://kiosk.sms-timing.com/${ck}/subscribe/event?id=${encodeURIComponent(proj.projectReference)}`;
              results.waiverUrl = "resolved";
            }
          }
        } catch (err) {
          results.waiverUrl = `error:${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Detect POV from bill overview (authoritative, not from cart items)
      // POV productId is 43746981 — stable across all BMI configurations
      if (overview?.lines && metaPovQty === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const povLine = (overview.lines as any[]).find(
          (l) => String(l.productId) === "43746981",
        );
        if (povLine && povLine.quantity > 0) {
          metaPovQty = povLine.quantity;
          results.povDetected = `fromBillOverview:${metaPovQty}`;
        }
      }
    }

    // ── Step 7: Claim POV codes ──────────────────────────────────────
    let claimedPovCodes: string[] = [];
    if (metaPovQty > 0 && bmiBillId) {
      try {
        const claimRes = await fetch(
          internalUrl(
            req,
            `/api/pov-codes?action=claim&qty=${metaPovQty}&billId=${bmiBillId}&email=${encodeURIComponent(guest.email)}`,
          ),
        );
        if (claimRes.ok) {
          const claimData = await claimRes.json();
          claimedPovCodes = claimData.codes || [];
          results.povClaim = `claimed:${claimedPovCodes.length}`;
        } else {
          results.povClaim = `failed:${claimRes.status}`;
        }
      } catch (err) {
        results.povClaim = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── Step 8: POV memo on BMI reservation ──────────────────────────
    if (claimedPovCodes.length > 0 && bmiBillId) {
      try {
        const memoQs = new URLSearchParams({
          endpoint: "booking/memo",
          clientKey: ck,
        });
        const memoBody = `{"orderId":${bmiBillId},"memo":"POV Codes: ${claimedPovCodes.join(", ")} — Server post-confirm pipeline"}`;
        await fetch(internalUrl(req, `/api/bmi?${memoQs.toString()}`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: memoBody,
        });
        results.povMemo = "written";
      } catch (err) {
        results.povMemo = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── Step 9: Enhanced notification (replaces the basic one from checkout/v2) ──
    // The basic notification was already fired by checkout/v2. This call
    // adds racing-specific fields (waiverUrl, expressLane, POV codes,
    // packageId). The booking-confirmation endpoint dedup key is
    // `notif:{billId}` — if the basic one already ran, this will be a
    // no-op. To handle this, we use a separate dedup key for enriched.
    //
    // Actually, the basic notification in checkout/v2 fires WITHOUT these
    // racing fields. If it already sent, this enriched one won't fire
    // (dedup). So the order matters: if the basic one wins the race,
    // the customer gets a notification without Express Lane / POV info.
    //
    // Mitigation: the basic notification should NOT fire for racing carts.
    // We'll remove that from checkout/v2 for racing carts (handled by
    // the booking_type check there). For now, if dedup blocks us, we
    // log and move on — the customer still gets a notification.
    if (bmiBillId && bmiReservationNumber) {
      try {
        const isHpLoc = locationKey === "headpinz" || locationKey === "naples";
        const firstName = guest.name.split(/\s+/)[0] || guest.name;

        // Extract product names + schedule from BMI overview (step 6)
        // so the notification endpoint has complete data for email/SMS
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const overviewLines: any[] = overview?.lines || [];
        const productNames = overviewLines
          .filter((l: { productName?: string }) => l.productName)
          .map((l: { productName: string }) => l.productName);
        const scheduledItems = overviewLines
          .filter((l: { start?: string; productName?: string }) => l.start && l.productName)
          .map((l: { productName: string; start: string; quantity?: number; persons?: number }) => ({
            name: l.productName,
            start: l.start,
            quantity: l.quantity || 1,
            persons: l.persons || l.quantity || 1,
          }));

        // Build date/time for SMS from first scheduled item
        const firstStart = scheduledItems[0]?.start || "";
        let reservationDate = "";
        let reservationTime = "";
        if (firstStart) {
          try {
            const dt = new Date(firstStart);
            reservationDate = dt.toLocaleDateString("en-US", {
              weekday: "long", month: "long", day: "numeric", year: "numeric",
            });
            reservationTime = dt.toLocaleTimeString("en-US", {
              hour: "numeric", minute: "2-digit", hour12: true,
            });
          } catch { /* non-fatal */ }
        }

        const notifBody: Record<string, unknown> = {
          email: guest.email,
          phone: guest.phone,
          firstName,
          smsOptIn,
          reservationNumber: bmiReservationNumber,
          reservationName: guest.name,
          reservationCode: bmiReservationNumber, // QR code content
          reservationDate,
          reservationTime,
          billId: bmiBillId,
          productNames,
          scheduledItems,
          brand: isHpLoc ? "headpinz" : "fasttrax",
          location: locationKey,
          // Racing-specific enrichment
          waiverUrl: isNewRacer ? waiverUrl : "",
          isNewRacer,
          povCodes: claimedPovCodes,
          expressLane: allWaiversValid,
          rookiePack: isRookiePack,
          packageId: metaPackageId || undefined,
        };

        const notifRes = await fetch(
          internalUrl(req, "/api/notifications/booking-confirmation"),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(notifBody),
          },
        );
        if (notifRes.ok) {
          const notifData = await notifRes.json();
          results.notification = notifData.duplicate
            ? "dedup_blocked"
            : "sent";
        } else {
          results.notification = `failed:${notifRes.status}`;
        }
      } catch (err) {
        results.notification = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const elapsedMs = Date.now() - startMs;
    console.log(
      `[post-confirm] Done in ${elapsedMs}ms: ${JSON.stringify(results)}`,
    );

    return NextResponse.json({ ok: true, elapsedMs, results });
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[post-confirm] Fatal error after ${elapsedMs}ms:`, msg);
    return NextResponse.json({ ok: false, error: msg, results }, { status: 500 });
  }
}
