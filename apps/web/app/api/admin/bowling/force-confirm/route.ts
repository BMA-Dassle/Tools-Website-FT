import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingReservation,
  updateBowlingReservationStatus,
  incrementQamfConfirmAttempt,
} from "@/lib/bowling-db";
import {
  setReservationCustomer,
  setReservationStatus,
  createReservation,
  getReservation,
} from "@/lib/qamf-bowling";
import { sql } from "@/lib/db";

/**
 * POST /api/admin/bowling/force-confirm
 *
 * Manually rescue a bowling reservation that is stuck in 'confirm_pending'
 * or 'confirm_failed' status. Useful when the automatic retry cron has
 * exhausted its attempts or the QAMF reservation expired before the cron ran.
 *
 * Auth: ADMIN_CAMERA_TOKEN via middleware.
 *
 * Request body:
 *   { neonId: number }
 *
 * Flow:
 *   1. Load the Neon reservation row.
 *   2. Verify current QAMF reservation via GET (check it still exists + status).
 *   3a. If reservation exists and is Temporary → PUT /customer + PATCH /status.
 *   3b. If reservation is already Confirmed → update Neon + return success.
 *   3c. If QAMF reservation is gone (404 / error) → create a brand-new
 *       reservation using the stored booking details, then PUT /customer +
 *       PATCH /status, then update qamf_reservation_id in Neon.
 *   4. Update Neon row to 'confirmed'.
 *
 * Response:
 *   { ok: true, neonId, qamfReservationId, action: "confirmed" | "already_confirmed" | "recreated_and_confirmed" }
 */

const CENTER_CODE_TO_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

export async function POST(req: NextRequest) {
  let body: { neonId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const neonId = typeof body.neonId === "number" ? body.neonId : Number(body.neonId);
  if (!neonId || isNaN(neonId)) {
    return NextResponse.json({ error: "neonId required" }, { status: 400 });
  }

  // Load reservation
  const res = await getBowlingReservation(neonId);
  if (!res) {
    return NextResponse.json({ error: `neonId=${neonId} not found` }, { status: 404 });
  }

  if (res.status === "confirmed" || res.status === "arrived" || res.status === "completed") {
    return NextResponse.json({
      ok: true,
      neonId,
      qamfReservationId: res.qamfReservationId,
      action: "already_confirmed",
      message: `Reservation already in status '${res.status}'`,
    });
  }

  const centerId = CENTER_CODE_TO_ID[res.centerCode];
  if (!centerId) {
    return NextResponse.json({ error: `Unknown centerCode: ${res.centerCode}` }, { status: 400 });
  }

  let qamfReservationId = res.qamfReservationId;
  let action: "confirmed" | "already_confirmed" | "recreated_and_confirmed" = "confirmed";

  // Check current QAMF state (is the existing reservation still alive?)
  let qamfStillExists = false;
  let qamfAlreadyConfirmed = false;

  if (qamfReservationId) {
    try {
      const current = await getReservation(centerId, qamfReservationId);
      if (
        current.Status === "Confirmed" ||
        current.Status === "Arrived" ||
        current.Status === "Completed"
      ) {
        // Already confirmed on QAMF side — just update Neon
        await updateBowlingReservationStatus(neonId, "confirmed");
        return NextResponse.json({
          ok: true,
          neonId,
          qamfReservationId,
          action: "already_confirmed",
          message: `QAMF reservation is already ${current.Status}; Neon updated`,
        });
      }
      // Temporary (or other) — still alive, try to confirm
      qamfStillExists = current.Status === "Temporary";
      qamfAlreadyConfirmed = false;
      console.log(
        `[force-confirm] neonId=${neonId} qamf=${qamfReservationId} status=${current.Status}`,
      );
    } catch (err) {
      console.warn(
        `[force-confirm] neonId=${neonId} qamf=${qamfReservationId} GET failed (likely expired):`,
        err instanceof Error ? err.message : err,
      );
      qamfStillExists = false;
    }
  }

  if (qamfStillExists && qamfReservationId) {
    // Attach customer then confirm
    try {
      await setReservationCustomer(centerId, qamfReservationId, {
        Guest: {
          Name: res.guestName ?? "",
          PhoneNumber: res.guestPhone ?? "",
          Email: res.guestEmail ?? "",
        },
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `PUT /customer failed: ${err instanceof Error ? err.message : err}`,
          hint: "QAMF reservation may have expired. Retry — this will create a fresh one.",
        },
        { status: 502 },
      );
    }

    const confirmed = await setReservationStatus(centerId, qamfReservationId, "Confirmed");
    if (!confirmed) {
      return NextResponse.json(
        {
          ok: false,
          error: "PATCH /status returned non-2xx",
          qamfReservationId,
          hint: "Try again or create a new QAMF reservation manually.",
        },
        { status: 502 },
      );
    }
  } else {
    // QAMF reservation is gone — create a fresh one
    console.log(
      `[force-confirm] neonId=${neonId}: QAMF reservation gone — creating fresh reservation`,
    );

    // Reconstruct QAMF offer options from lines (best effort)
    // We need webOfferId; look it up from the experience_offers table via reservation lines
    // Fall back to a basic createReservation with no options if we can't resolve it
    let webOfferId: number | undefined;
    let optionId: number | undefined;
    let optionType: "Game" | "Time" | "Unlimited" = "Game";

    try {
      const q = sql();
      // Get the first open-bowling or kbf product from reservation lines
      const offerRows = await q`
        SELECT eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id
        FROM bowling_reservation_lines brl
        JOIN bowling_square_products bsp ON bsp.id = brl.square_product_id
        JOIN bowling_experience_items bei ON bei.square_catalog_object_id = bsp.square_catalog_object_id
        JOIN bowling_experience_offers eo
          ON eo.experience_id = bei.experience_id
         AND eo.center_code   = ${res.centerCode}
         AND eo.is_active     = TRUE
        WHERE brl.reservation_id = ${neonId}
        LIMIT 1
      `;
      if (offerRows.length) {
        const r = offerRows[0] as Record<string, unknown>;
        webOfferId = r.qamf_web_offer_id as number;
        optionId = r.qamf_option_id != null ? (r.qamf_option_id as number) : undefined;
        optionType = (r.qamf_option_type as "Game" | "Time" | "Unlimited") ?? "Game";
      }
    } catch (err) {
      console.warn("[force-confirm] could not resolve webOfferId from lines:", err);
    }

    if (!webOfferId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Cannot recreate QAMF reservation — cannot determine webOfferId. Create manually in QAMF dashboard.",
          neonId,
          bookedAt: res.bookedAt,
          guestName: res.guestName,
          playerCount: res.playerCount,
        },
        { status: 422 },
      );
    }

    const qamfOptions: {
      Game?: { Id: number }[];
      Time?: { Id: number }[];
      Unlimited?: { Id: number }[];
    } = {};
    if (optionId) {
      if (optionType === "Time") qamfOptions.Time = [{ Id: optionId }];
      else if (optionType === "Unlimited") qamfOptions.Unlimited = [{ Id: optionId }];
      else qamfOptions.Game = [{ Id: optionId }];
    }

    try {
      const newReservation = await createReservation(centerId, {
        BookedAt: res.bookedAt,
        Title: `${res.guestName ?? "Guest"} (${res.playerCount ?? 1}p)`,
        Notes: res.notes,
        Customer: {
          Guest: {
            Name: res.guestName ?? "",
            PhoneNumber: res.guestPhone ?? "",
            Email: res.guestEmail ?? "",
          },
        },
        WebOffer: {
          Id: webOfferId,
          Options: qamfOptions,
          Services: ["BookForLater"],
        },
        TotalPlayers: res.playerCount ?? 1,
      });
      qamfReservationId = newReservation.Id;
      console.log(
        `[force-confirm] neonId=${neonId}: fresh QAMF reservation created: ${qamfReservationId}`,
      );

      await setReservationCustomer(centerId, qamfReservationId, {
        Guest: {
          Name: res.guestName ?? "",
          PhoneNumber: res.guestPhone ?? "",
          Email: res.guestEmail ?? "",
        },
      });

      const confirmed = await setReservationStatus(centerId, qamfReservationId, "Confirmed");
      if (!confirmed) {
        return NextResponse.json(
          {
            ok: false,
            error: "Fresh QAMF reservation created but PATCH /status failed",
            qamfReservationId,
            hint: "Reservation created as Temporary. Try calling force-confirm again.",
          },
          { status: 502 },
        );
      }

      // Update Neon with new QAMF ID
      const q = sql();
      await q`
        UPDATE bowling_reservations
        SET qamf_reservation_id = ${qamfReservationId}, status = 'confirmed'
        WHERE id = ${neonId}
      `;
      action = "recreated_and_confirmed";
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to create/confirm fresh QAMF reservation: ${err instanceof Error ? err.message : err}`,
          neonId,
        },
        { status: 502 },
      );
    }
  }

  if (action === "confirmed") {
    await updateBowlingReservationStatus(neonId, "confirmed");
  }

  console.log(`[force-confirm] neonId=${neonId} qamf=${qamfReservationId} action=${action} ✓`);
  return NextResponse.json({
    ok: true,
    neonId,
    qamfReservationId,
    action,
  });
}
