import { NextRequest, NextResponse } from "next/server";
import { listBowlingReservations } from "@/lib/bowling-db";
import { getPhonesWithExistingSurveys } from "@/lib/guest-survey-db";
import { enqueueBowlingSurvey } from "~/features/guest-survey";
import { getConsent, normalizePhoneE164 } from "~/features/marketing";

// Backfill needs more than the default 10s Hobby budget — bumped to
// the Vercel Pro max so a single run can drain a meaningful chunk
// (each enqueue does a Square customer resolve + Vox SMS + Neon
// insert, roughly 1-2 sec per recipient).
export const maxDuration = 300;

/**
 * POST /api/admin/guest-survey/backfill-completed
 *
 * Manual one-shot: send a guest survey to every UNIQUE phone that
 * appears on a bowling reservation in `status='completed'` over the
 * last N days. Used to bootstrap survey data after enabling the flow.
 *
 * Dedup rules (in order of skip):
 *   1. Reservation has no guestPhone                → skipped no_phone
 *   2. Phone unparseable to E.164                   → skipped bad_phone
 *   3. Phone has explicit STOP on marketing_consent → skipped opted_out
 *   4. Phone already has ANY guest_surveys row      → skipped already_surveyed
 *   5. Phone appears twice in the window            → only the most
 *      recent (bookedAt DESC) reservation is used
 *
 * Auth: middleware enforces ADMIN_CAMERA_TOKEN.
 *
 * Body (all optional):
 *   {
 *     days?:       number   default 5, max 14
 *     centerCode?: string   limit to one center; default both
 *     dryRun?:     boolean  default false. preview without sending.
 *     limit?:      number   max sends per run (default 50, max 200)
 *   }
 *
 * Returns counts + the recipient list. The underlying
 * `enqueueBowlingSurvey` is idempotent on (origin='bowling',
 * origin_ref=reservation.id), so a second run is safe — it'll skip
 * reservations that were sent in the first run.
 */
export async function POST(req: NextRequest) {
  let body: {
    days?: number;
    centerCode?: string;
    dryRun?: boolean;
    limit?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — use defaults.
  }

  const days = Math.min(Math.max(body.days ?? 5, 1), 14);
  const dryRun = body.dryRun === true;
  const limit = Math.min(Math.max(body.limit ?? 50, 1), 200);
  const centerCode = body.centerCode || undefined;

  // Window: today (ET) − N days → today
  const endDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const startDateObj = new Date();
  startDateObj.setUTCDate(startDateObj.getUTCDate() - days);
  const startDate = startDateObj.toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });

  let reservations;
  try {
    reservations = await listBowlingReservations({ startDate, endDate, centerCode });
  } catch (err) {
    console.error("[admin-debug] backfill-completed listBowlingReservations failed:", err);
    return NextResponse.json(
      { error: "list failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const completed = reservations.filter((r) => r.status === "completed");
  // Sort newest-first so the most recent visit per phone wins.
  completed.sort((a, b) => (a.bookedAt < b.bookedAt ? 1 : -1));

  type Entry = {
    reservation: (typeof completed)[number];
    phoneE164: string;
  };

  let skippedNoPhone = 0;
  let skippedBadPhone = 0;
  let skippedDuplicateInWindow = 0;
  const dedupedByPhone = new Map<string, Entry>();
  for (const r of completed) {
    if (!r.guestPhone) {
      skippedNoPhone++;
      continue;
    }
    let phoneE164: string;
    try {
      phoneE164 = normalizePhoneE164(r.guestPhone);
    } catch {
      skippedBadPhone++;
      continue;
    }
    if (dedupedByPhone.has(phoneE164)) {
      skippedDuplicateInWindow++;
      continue;
    }
    dedupedByPhone.set(phoneE164, { reservation: r, phoneE164 });
  }

  // Block phones that already have any guest_surveys row (one survey
  // per phone, ever — per Eric's "don't duplicate numbers").
  const phones = Array.from(dedupedByPhone.keys());
  const alreadySurveyed = await getPhonesWithExistingSurveys(phones);

  const sent: Array<{
    phone: string;
    reservationId: number;
    guestName: string;
    surveyId?: string;
    token?: string;
  }> = [];
  const skipped: Array<{
    phone: string;
    reservationId: number;
    guestName: string;
    reason: string;
  }> = [];
  let cap = 0;

  for (const entry of dedupedByPhone.values()) {
    const { reservation, phoneE164 } = entry;
    const guestName = reservation.guestName ?? "";

    // Already surveyed? (any prior guest_surveys row)
    if (alreadySurveyed.has(phoneE164)) {
      skipped.push({
        phone: phoneE164,
        reservationId: reservation.id,
        guestName,
        reason: "already_surveyed",
      });
      continue;
    }

    // Explicit STOP on marketing_consent?
    const consent = await getConsent(phoneE164);
    if (consent && consent.optedIn === false) {
      skipped.push({
        phone: phoneE164,
        reservationId: reservation.id,
        guestName,
        reason: "opted_out",
      });
      continue;
    }

    if (cap >= limit) {
      skipped.push({
        phone: phoneE164,
        reservationId: reservation.id,
        guestName,
        reason: "batch_limit_reached",
      });
      continue;
    }

    if (dryRun) {
      sent.push({
        phone: phoneE164,
        reservationId: reservation.id,
        guestName,
      });
      cap++;
      continue;
    }

    const visitDate = new Date(reservation.bookedAt).toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });

    const outcome = await enqueueBowlingSurvey({
      reservationId: String(reservation.id),
      phone: phoneE164,
      guestName,
      guestEmail: reservation.guestEmail,
      centerCode: reservation.centerCode,
      visitDate,
    });

    if (outcome.status === "sent") {
      sent.push({
        phone: phoneE164,
        reservationId: reservation.id,
        guestName,
        surveyId: outcome.surveyId,
        token: outcome.token,
      });
      cap++;
    } else {
      skipped.push({
        phone: phoneE164,
        reservationId: reservation.id,
        guestName,
        reason: `enqueue_${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}`,
      });
    }
  }

  console.log(
    `[admin-debug] backfill-completed window=${startDate}..${endDate} dryRun=${dryRun} center=${centerCode ?? "all"} reservations=${reservations.length} completed=${completed.length} uniquePhones=${dedupedByPhone.size} sent=${sent.length} skipped=${skipped.length}`,
  );

  return NextResponse.json({
    ok: true,
    dryRun,
    window: { startDate, endDate, days },
    centerCode: centerCode ?? null,
    counts: {
      reservationsScanned: reservations.length,
      completedReservations: completed.length,
      skippedNoPhone,
      skippedBadPhone,
      skippedDuplicateInWindow,
      uniquePhones: dedupedByPhone.size,
      sent: sent.length,
      skipped: skipped.length,
      batchLimit: limit,
    },
    sent,
    skipped,
  });
}
