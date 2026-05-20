import { NextRequest, NextResponse } from "next/server";
import { enqueueBowlingSurvey } from "~/features/guest-survey";
import { deleteGuestSurveysByPhone } from "@/lib/guest-survey-db";
import { deleteMarketingTouchesByPhone } from "@/lib/marketing-db";
import { normalizePhoneE164, recordOptIn } from "~/features/marketing";

/**
 * POST /api/admin/guest-survey/send-test
 *
 * Admin-gated live-fire test for the bowling-survey flow.
 * Middleware enforces ADMIN_CAMERA_TOKEN via header `x-admin-token` or
 * `?token=` query — no extra auth check needed here.
 *
 * Body:
 *   {
 *     phone:       string;          // any format, normalized to E.164
 *     guestName:   string;          // "First Last"; split server-side
 *     guestEmail?: string;
 *     centerCode:  string;          // "TXBSQN0FEKQ11" | "PPTR5G2N0QXF7"
 *     reservationId?: string;       // override origin_ref; defaults to "admin-test-<phoneDigits>-<date>"
 *     ensureOptIn?: boolean;        // default true — seed marketing_consent so the send isn't skipped
 *   }
 *
 * Returns the full EnqueueOutcome so the operator can verify:
 *   { ok: true, outcome: { status: "sent", surveyId, token, tags } }
 * or
 *   { ok: true, outcome: { status: "skipped", reason, detail? } }
 *
 * Cost / safety: the customer at `phone` will receive a real SMS. The
 * 30-day frequency cap and (origin, origin_ref) unique constraint
 * apply. Re-running with the same default reservationId on the same
 * day is a no-op (uniqueness blocks it).
 */
export async function POST(req: NextRequest) {
  let body: {
    phone?: string;
    guestName?: string;
    guestEmail?: string;
    centerCode?: string;
    reservationId?: string;
    ensureOptIn?: boolean;
    /** Force-retry: wipe prior guest_surveys + marketing_touches rows for this
     *  phone before enqueuing. Used to re-test the same phone within the
     *  30-day cap window. Destructive — admin only. */
    force?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.phone || !body.guestName || !body.centerCode) {
    return NextResponse.json(
      { error: "phone, guestName, centerCode are required" },
      { status: 400 },
    );
  }

  let phoneE164: string;
  try {
    phoneE164 = normalizePhoneE164(body.phone);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid phone" },
      { status: 400 },
    );
  }

  // Force-retry: clear any prior survey row + sent touches for this phone
  // so the 30-day cap and (origin, origin_ref) uniqueness don't block.
  // Destructive — only here on the admin debug path.
  let wiped: { surveys: number; touches: number } | undefined;
  if (body.force === true) {
    const surveys = await deleteGuestSurveysByPhone(phoneE164);
    const touches = await deleteMarketingTouchesByPhone({
      phoneE164,
      campaign: "guest_survey",
    });
    wiped = { surveys, touches };
    console.log(
      `[admin-debug] force-retry: wiped ${surveys} survey(s) and ${touches} touch(es) for ${phoneE164}`,
    );
  }

  // Default-true: assume the operator wants the send to actually fire.
  // Pass `ensureOptIn: false` to test the no-consent skip path.
  if (body.ensureOptIn !== false) {
    try {
      await recordOptIn({ phoneE164, source: "admin" });
    } catch (err) {
      console.warn("[admin-debug] marketing opt-in seed failed (non-fatal):", err);
    }
  }

  // Default origin_ref: stable per-day so re-running the SAME test on the
  // SAME day is idempotent (uniqueness block kicks in). New day → fresh
  // ref → fresh attempt (still blocked by the 30-day cap, which is the
  // point).
  const phoneDigits = phoneE164.replace(/\D/g, "");
  const dayStamp = new Date().toISOString().slice(0, 10);
  const reservationId = body.reservationId ?? `admin-test-${phoneDigits}-${dayStamp}`;

  const visitDate = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });

  console.log(
    `[admin-debug] send-test phone=${phoneE164} center=${body.centerCode}` +
      ` reservationId=${reservationId} ensureOptIn=${body.ensureOptIn !== false}`,
  );

  const outcome = await enqueueBowlingSurvey({
    reservationId,
    phone: phoneE164,
    guestName: body.guestName,
    guestEmail: body.guestEmail,
    centerCode: body.centerCode,
    visitDate,
  });

  console.log(`[admin-debug] send-test outcome=${JSON.stringify(outcome)}`);

  return NextResponse.json({ ok: true, outcome, ...(wiped ? { wiped } : {}) });
}
