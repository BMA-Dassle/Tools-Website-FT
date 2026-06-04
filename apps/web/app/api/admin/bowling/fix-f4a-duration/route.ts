import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import {
  getReservation,
  createReservation,
  deleteReservation,
  setReservationStatus,
  patchReservation,
} from "@/lib/qamf-bowling";
import { buildQamfMemo } from "@/lib/bowling-db";

/**
 * POST /api/admin/bowling/fix-f4a-duration?token=…
 *
 * One-off fix: Fun 4 All reservations created since the Time-bowling
 * switch (2026-06-02) were booked with QAMF Time option 1226 (60 min)
 * instead of 1227 (90 min) for FM, or the Naples equivalent.
 *
 * This endpoint:
 *   1. Finds future open-kind reservations with a "Fun 4 All" line item
 *   2. Checks each QAMF reservation's Time option
 *   3. If wrong, reschedules at the same time with the correct option
 *
 * Pass ?dryRun=true to check without fixing.
 */

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

// Correct Time option IDs per center (90 min = 1.5 hours)
const CORRECT_OPTION: Record<string, { correct: number; wrong: number }> = {
  TXBSQN0FEKQ11: { correct: 1227, wrong: 1226 }, // FM: 90 min, not 60
  PPTR5G2N0QXF7: { correct: 939, wrong: 938 }, // Naples: 90 min, not 60
};

// VIP variants
const CORRECT_OPTION_VIP: Record<string, { correct: number; wrong: number }> = {
  TXBSQN0FEKQ11: { correct: 1235, wrong: 1234 }, // FM VIP
  PPTR5G2N0QXF7: { correct: 947, wrong: 946 }, // Naples VIP
};

// Web offer IDs for Fun 4 All
const F4A_OFFERS: Record<string, number> = {
  TXBSQN0FEKQ11: 154,
  PPTR5G2N0QXF7: 118,
};
const F4A_VIP_OFFERS: Record<string, number> = {
  TXBSQN0FEKQ11: 155,
  PPTR5G2N0QXF7: 119,
};

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";

  const q = sql();

  // Find future Fun 4 All reservations (both regular and VIP)
  const rows = await q`
    SELECT br.id, br.center_code, br.qamf_reservation_id, br.booked_at,
           br.player_count, br.guest_name, br.guest_phone, br.guest_email,
           br.notes, br.status,
           brl.label
    FROM bowling_reservations br
    JOIN bowling_reservation_lines brl ON brl.reservation_id = br.id
    WHERE br.product_kind = 'open'
      AND br.status NOT IN ('cancelled', 'completed')
      AND br.booked_at > NOW()
      AND brl.label ILIKE '%fun 4 all%'
    ORDER BY br.booked_at ASC
  `;

  type Row = {
    id: number;
    center_code: string;
    qamf_reservation_id: string | null;
    booked_at: string;
    player_count: number;
    guest_name: string;
    guest_phone: string;
    guest_email: string;
    notes: string | null;
    status: string;
    label: string;
  };

  const results: Array<{
    neonId: number;
    guestName: string;
    bookedAt: string;
    center: string;
    qamfId: string | null;
    currentOptionId: number | null;
    correctOptionId: number;
    action: string;
    newQamfId?: string;
    error?: string;
  }> = [];

  for (const raw of rows as Array<Record<string, unknown>>) {
    const row = raw as unknown as Row;
    const centerId = CENTER_CODE_TO_QAMF[row.center_code];
    if (!centerId) continue;

    const isVip = /vip/i.test(row.label);
    const optMap = isVip ? CORRECT_OPTION_VIP : CORRECT_OPTION;
    const offerMap = isVip ? F4A_VIP_OFFERS : F4A_OFFERS;
    const mapping = optMap[row.center_code];
    const webOfferId = offerMap[row.center_code];
    if (!mapping || !webOfferId) continue;

    const entry: (typeof results)[0] = {
      neonId: row.id,
      guestName: row.guest_name,
      bookedAt: row.booked_at,
      center: row.center_code === "TXBSQN0FEKQ11" ? "FM" : "Naples",
      qamfId: row.qamf_reservation_id,
      currentOptionId: null,
      correctOptionId: mapping.correct,
      action: "skipped",
    };

    if (!row.qamf_reservation_id) {
      entry.action = "no_qamf_id";
      results.push(entry);
      continue;
    }

    // Check the current QAMF reservation's Time option (or if it's still Unlimited)
    try {
      const qamfRes = await getReservation(centerId, row.qamf_reservation_id);
      const timeOpts = qamfRes.WebOffer?.Options?.Time ?? [];
      const unlimOpts = qamfRes.WebOffer?.Options?.Unlimited ?? [];
      const currentOpt = timeOpts[0]?.Id;
      entry.currentOptionId = typeof currentOpt === "number" ? currentOpt : null;

      // Already on the correct Time option
      if (currentOpt === mapping.correct) {
        entry.action = "already_correct";
        results.push(entry);
        continue;
      }

      // Detect Unlimited-mode reservations (pre-switch bookings)
      if (unlimOpts.length > 0 && timeOpts.length === 0) {
        entry.currentOptionId = -((unlimOpts[0]?.Id as number) ?? 0); // negative = Unlimited
      }

      if (dryRun) {
        entry.action = "would_fix";
        results.push(entry);
        continue;
      }

      // Fix: reschedule with correct option (same time, correct Time option)
      // 1. Unlink old QAMF ID (prevent webhook from cancelling)
      await q`
        UPDATE bowling_reservations
        SET qamf_reservation_id = NULL
        WHERE id = ${row.id}
      `;

      // 2. Revert to Temporary + delete old reservation
      try {
        await setReservationStatus(centerId, row.qamf_reservation_id, "Temporary");
      } catch {
        /* best effort */
      }
      try {
        await deleteReservation(centerId, row.qamf_reservation_id);
      } catch {
        /* best effort — may have expired */
      }

      // 3. Create new reservation with correct Time option
      const created = await createReservation(centerId, {
        BookedAt: new Date(row.booked_at).toISOString(),
        Title: `${row.guest_name || "Guest"} (${row.player_count || 1}p)`,
        Notes: row.notes ?? undefined,
        Customer: {
          Guest: {
            Name: row.guest_name || "Guest",
            PhoneNumber: row.guest_phone || "",
            Email: row.guest_email || "",
          },
        },
        WebOffer: {
          Id: webOfferId,
          Options: { Time: [{ Id: mapping.correct }] },
          Services: ["BookForLater"],
        },
        TotalPlayers: row.player_count || 1,
      });

      // 4. Confirm
      await setReservationStatus(centerId, created.Id, "Confirmed");

      // 5. Update Neon
      await q`
        UPDATE bowling_reservations
        SET qamf_reservation_id = ${created.Id}
        WHERE id = ${row.id}
      `;

      // 6. Restore memo
      try {
        const memo = await buildQamfMemo(row.id);
        if (memo) {
          await patchReservation(centerId, created.Id, { Notes: memo });
        }
      } catch {
        /* non-fatal */
      }

      entry.action = "fixed";
      entry.newQamfId = created.Id;
      results.push(entry);
    } catch (err) {
      entry.action = "error";
      entry.error = err instanceof Error ? err.message : String(err);
      results.push(entry);
    }
  }

  return NextResponse.json({
    dryRun,
    total: results.length,
    fixed: results.filter((r) => r.action === "fixed").length,
    wouldFix: results.filter((r) => r.action === "would_fix").length,
    alreadyCorrect: results.filter((r) => r.action === "already_correct").length,
    errors: results.filter((r) => r.action === "error").length,
    results,
  });
}
