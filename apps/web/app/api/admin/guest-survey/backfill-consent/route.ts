import { NextRequest, NextResponse } from "next/server";
import { listBowlingReservations } from "@/lib/bowling-db";
import { getConsent, normalizePhoneE164, recordOptIn } from "~/features/marketing";

/**
 * POST /api/admin/guest-survey/backfill-consent
 *
 * Backfill marketing_consent for upcoming bowling reservations that have
 * a phone on file. We send these guests transactional confirmation +
 * lane-ready SMS, so they've consented to SMS contact — that consent
 * extends to a single post-visit survey with a STOP footer.
 *
 * Auth: middleware enforces ADMIN_CAMERA_TOKEN via header x-admin-token
 * or ?token=.
 *
 * Body (all optional):
 *   {
 *     days?:        number;   // window size from today (default 14, max 60)
 *     centerCode?:  string;   // limit to one center; default both
 *     dryRun?:      boolean;  // default false. true = report only, no writes.
 *   }
 *
 * Safety:
 *   - **Never** overrides an explicit STOP (opted_in=false). Phones in
 *     that state stay opted-out; backfill counts them under
 *     `skippedExplicitStop`.
 *   - Already-opted-in rows (opted_in=true) are left as-is (counted
 *     under `skippedAlreadyConsented`).
 *   - Idempotent: re-running is safe.
 */
export async function POST(req: NextRequest) {
  let body: { days?: number; centerCode?: string; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — use defaults.
  }

  const days = Math.min(Math.max(body.days ?? 14, 1), 60);
  const dryRun = body.dryRun === true;
  const centerCode = body.centerCode || undefined;

  // Window: today (ET) → today + days
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const endDate = new Date();
  endDate.setUTCDate(endDate.getUTCDate() + days);
  const endDateStr = endDate.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  let reservations;
  try {
    reservations = await listBowlingReservations({
      startDate: today,
      endDate: endDateStr,
      centerCode,
    });
  } catch (err) {
    console.error("[admin-debug] backfill-consent listBowlingReservations failed:", err);
    return NextResponse.json(
      { error: "list failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // Filter: reservations with a phone and not cancelled.
  const eligible = reservations.filter((r) => r.guestPhone && r.status !== "cancelled");

  // Deduplicate by normalized E.164 — one customer may have multiple
  // upcoming reservations, but we only need to write one consent row.
  const uniquePhones = new Map<
    string,
    { phone: string; reservationId: number; guestName: string }
  >();
  for (const r of eligible) {
    if (!r.guestPhone) continue;
    let phoneE164: string;
    try {
      phoneE164 = normalizePhoneE164(r.guestPhone);
    } catch {
      // Skip unparseable phones — surfaces under skippedBadPhone below.
      uniquePhones.set(`__bad__${r.id}`, {
        phone: r.guestPhone,
        reservationId: r.id,
        guestName: r.guestName ?? "",
      });
      continue;
    }
    if (!uniquePhones.has(phoneE164)) {
      uniquePhones.set(phoneE164, {
        phone: phoneE164,
        reservationId: r.id,
        guestName: r.guestName ?? "",
      });
    }
  }

  let recorded = 0;
  let skippedAlreadyConsented = 0;
  let skippedExplicitStop = 0;
  let skippedBadPhone = 0;
  const recordedList: Array<{ phone: string; reservationId: number; guestName: string }> = [];
  const stoppedList: Array<{ phone: string; reservationId: number; guestName: string }> = [];

  for (const [key, entry] of uniquePhones.entries()) {
    if (key.startsWith("__bad__")) {
      skippedBadPhone++;
      continue;
    }
    const existing = await getConsent(entry.phone);
    if (existing?.optedIn === false) {
      skippedExplicitStop++;
      stoppedList.push(entry);
      continue;
    }
    if (existing?.optedIn === true) {
      skippedAlreadyConsented++;
      continue;
    }
    // No row → record implicit opt-in with source=booking_confirmation.
    if (!dryRun) {
      await recordOptIn({ phoneE164: entry.phone, source: "booking_confirmation" });
    }
    recorded++;
    recordedList.push(entry);
  }

  console.log(
    `[admin-debug] backfill-consent window=${today}..${endDateStr} center=${centerCode ?? "all"}` +
      ` dryRun=${dryRun} reservations=${reservations.length} eligible=${eligible.length}` +
      ` uniquePhones=${uniquePhones.size} recorded=${recorded}` +
      ` skippedAlreadyConsented=${skippedAlreadyConsented} skippedExplicitStop=${skippedExplicitStop}` +
      ` skippedBadPhone=${skippedBadPhone}`,
  );

  return NextResponse.json({
    ok: true,
    dryRun,
    window: { startDate: today, endDate: endDateStr, days },
    centerCode: centerCode ?? null,
    counts: {
      reservationsScanned: reservations.length,
      eligibleReservations: eligible.length,
      uniquePhones: uniquePhones.size,
      recorded,
      skippedAlreadyConsented,
      skippedExplicitStop,
      skippedBadPhone,
    },
    recorded: recordedList,
    skippedExplicitStop: stoppedList,
  });
}
