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
 * POST /api/admin/bowling/fix-open-duration?token=…[&dryRun=true][&target=pizza-bowl|fun-4-all]
 *
 * Remediates fixed-duration OPEN packages (Pizza Bowl 2hr, Fun 4 All 1.5hr)
 * that were booked with QAMF's 60-min Time option instead of the package's
 * correct option.
 *
 * Root cause (fixed forward in BowlingOfferStep.selectSlot): open packages
 * carry no duration buttons, so the client fell back to slot.optionId — which
 * parseAvailabilities computes as "longest by Minutes". QAMF returns a
 * 60/90/120-min option triple with Minutes undefined and lists the 60-min one
 * first, so the reduce degraded to 1 hour. The correct option lives on the
 * experience's offer row (bowling_experience_offers.qamf_option_id) and is read
 * from the DB here so this auto-tracks any future config change.
 *
 * For each future, non-cancelled/completed open reservation whose line items
 * identify it as a target package:
 *   1. Look up the correct (webOfferId, optionId) for its experience + center
 *   2. Read the live QAMF reservation's current Time option
 *   3. If wrong → reschedule at the same time with the correct option
 *
 * Pass ?dryRun=true to report without changing anything.
 * Pass ?target=pizza-bowl or ?target=fun-4-all to scope to one package.
 *
 * Generalizes the one-off /fix-f4a-duration route (now superseded by this).
 */

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

interface Target {
  key: string;
  name: string;
  /** ILIKE pattern matching the base line label of this package. */
  labelLike: string;
  regularSlug: string;
  vipSlug: string;
}

const TARGETS: Target[] = [
  {
    key: "pizza-bowl",
    name: "Pizza Bowl",
    labelLike: "%pizza bowl%",
    regularSlug: "pizza-bowl",
    vipSlug: "pizza-bowl-vip",
  },
  {
    key: "fun-4-all",
    name: "Fun 4 All",
    labelLike: "%fun 4 all%",
    regularSlug: "fun-4-all",
    vipSlug: "fun-4-all-vip",
  },
];

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

type ResultEntry = {
  neonId: number;
  package: string;
  guestName: string;
  bookedAt: string;
  center: string;
  qamfId: string | null;
  correctOptionId: number | null;
  currentOptionId: number | null;
  action: string;
  newQamfId?: string;
  error?: string;
};

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";
  const targetParam = req.nextUrl.searchParams.get("target");
  const targets = targetParam ? TARGETS.filter((t) => t.key === targetParam) : TARGETS;
  if (targetParam && targets.length === 0) {
    return NextResponse.json(
      { error: `unknown target: ${targetParam}. Valid: ${TARGETS.map((t) => t.key).join(", ")}` },
      { status: 400 },
    );
  }

  const q = sql();

  // Cache the correct (webOfferId, optionId) per experience slug + center so we
  // don't re-query for every reservation.
  const offerCache = new Map<string, { webOfferId: number; optionId: number } | null>();
  async function correctOptionFor(
    slug: string,
    centerCode: string,
  ): Promise<{ webOfferId: number; optionId: number } | null> {
    const cacheKey = `${slug}::${centerCode}`;
    if (offerCache.has(cacheKey)) return offerCache.get(cacheKey)!;
    const rows = await q`
      SELECT eo.qamf_web_offer_id, eo.qamf_option_id
      FROM bowling_experience_offers eo
      JOIN bowling_experiences e ON e.id = eo.experience_id
      WHERE e.slug = ${slug} AND eo.center_code = ${centerCode} AND eo.is_active = TRUE
      LIMIT 1
    `;
    const r = rows[0] as Record<string, unknown> | undefined;
    const resolved =
      r && r.qamf_web_offer_id != null && r.qamf_option_id != null
        ? { webOfferId: r.qamf_web_offer_id as number, optionId: r.qamf_option_id as number }
        : null;
    offerCache.set(cacheKey, resolved);
    return resolved;
  }

  const results: ResultEntry[] = [];
  const seen = new Set<number>(); // dedupe reservations matched on multiple lines

  for (const target of targets) {
    const rows = (await q`
      SELECT DISTINCT ON (br.id)
             br.id, br.center_code, br.qamf_reservation_id, br.booked_at,
             br.player_count, br.guest_name, br.guest_phone, br.guest_email,
             br.notes, br.status, brl.label
      FROM bowling_reservations br
      JOIN bowling_reservation_lines brl ON brl.reservation_id = br.id
      WHERE br.product_kind = 'open'
        AND br.status NOT IN ('cancelled', 'completed')
        AND br.booked_at > NOW()
        AND brl.label ILIKE ${target.labelLike}
      ORDER BY br.id, br.booked_at ASC
    `) as Array<Record<string, unknown>>;

    for (const raw of rows) {
      const row = raw as unknown as Row;
      if (seen.has(row.id)) continue;
      seen.add(row.id);

      const centerId = CENTER_CODE_TO_QAMF[row.center_code];
      const isVip = /vip/i.test(row.label);
      const slug = isVip ? target.vipSlug : target.regularSlug;

      const entry: ResultEntry = {
        neonId: row.id,
        package: `${target.name}${isVip ? " VIP" : ""}`,
        guestName: row.guest_name,
        bookedAt: row.booked_at,
        center: row.center_code === "TXBSQN0FEKQ11" ? "FM" : "Naples",
        qamfId: row.qamf_reservation_id,
        correctOptionId: null,
        currentOptionId: null,
        action: "skipped",
      };

      if (!centerId) {
        entry.action = "unknown_center";
        results.push(entry);
        continue;
      }

      const correct = await correctOptionFor(slug, row.center_code);
      if (!correct) {
        entry.action = "no_offer_config";
        results.push(entry);
        continue;
      }
      entry.correctOptionId = correct.optionId;

      if (!row.qamf_reservation_id) {
        entry.action = "no_qamf_id";
        results.push(entry);
        continue;
      }

      try {
        const qamfRes = await getReservation(centerId, row.qamf_reservation_id);
        const timeOpts = qamfRes.WebOffer?.Options?.Time ?? [];
        const currentOpt = timeOpts[0]?.Id;
        entry.currentOptionId = typeof currentOpt === "number" ? currentOpt : null;

        if (currentOpt === correct.optionId) {
          entry.action = "already_correct";
          results.push(entry);
          continue;
        }

        if (dryRun) {
          entry.action = "would_fix";
          results.push(entry);
          continue;
        }

        // Reschedule with the correct option (same time).
        // 1. Unlink old QAMF id so the cancel webhook can't void the Neon row.
        await q`UPDATE bowling_reservations SET qamf_reservation_id = NULL WHERE id = ${row.id}`;

        // 2. Revert to Temporary + delete the old reservation (best effort).
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

        // 3. Create the replacement with the correct Time option.
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
            Id: correct.webOfferId,
            Options: { Time: [{ Id: correct.optionId }] },
            Services: ["BookForLater"],
          },
          TotalPlayers: row.player_count || 1,
        });

        // 4. Confirm.
        await setReservationStatus(centerId, created.Id, "Confirmed");

        // 5. Repoint Neon at the new reservation.
        await q`UPDATE bowling_reservations SET qamf_reservation_id = ${created.Id} WHERE id = ${row.id}`;

        // 6. Restore the staff-facing memo (non-fatal).
        try {
          const memo = await buildQamfMemo(row.id);
          if (memo) await patchReservation(centerId, created.Id, { Notes: memo });
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
  }

  return NextResponse.json({
    dryRun,
    target: targetParam ?? "all",
    total: results.length,
    fixed: results.filter((r) => r.action === "fixed").length,
    wouldFix: results.filter((r) => r.action === "would_fix").length,
    alreadyCorrect: results.filter((r) => r.action === "already_correct").length,
    errors: results.filter((r) => r.action === "error").length,
    results,
  });
}
