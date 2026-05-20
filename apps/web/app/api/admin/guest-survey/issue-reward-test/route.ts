import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  issueReward,
  normalizePhoneE164,
  resolveAudienceMember,
  type RewardKind,
} from "~/features/marketing";

/**
 * POST /api/admin/guest-survey/issue-reward-test
 *
 * Admin-gated live-fire test for the reward issuance path. Doesn't
 * require a survey row — just resolves the audience by phone and fires
 * the reward.
 *
 * Body:
 *   {
 *     phone:       string;          // any format, normalized to E.164
 *     guestName:   string;          // "First Last" — used to find/create Square customer
 *     guestEmail?: string;
 *     centerCode:  string;          // Square location id (= QAMF center code for HP)
 *     kind:        "pinz" | "gift_card";
 *     surveyId?:   string;          // required for gift_card path (links promo code → survey)
 *   }
 *
 * Returns the full IssueRewardResult including the GAN (gift card) or
 * loyalty account id (Pinz) for the operator's audit trail. SMS is
 * NOT sent — this endpoint is for verifying the Square mutation
 * succeeded. To exercise the full flow including SMS + survey-row
 * persistence, use POST /api/surveys/[token]/reward against a real
 * survey token.
 *
 * Cost: real Square mutation. Pinz adjustments and gift-card mints
 * appear in the Square dashboard. Test against an internal phone.
 */
export async function POST(req: NextRequest) {
  let body: {
    phone?: string;
    guestName?: string;
    guestEmail?: string;
    centerCode?: string;
    kind?: RewardKind;
    surveyId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.phone || !body.guestName || !body.centerCode || !body.kind) {
    return NextResponse.json(
      { error: "phone, guestName, centerCode, kind are required" },
      { status: 400 },
    );
  }
  if (body.kind !== "pinz" && body.kind !== "gift_card") {
    return NextResponse.json({ error: "kind must be 'pinz' or 'gift_card'" }, { status: 400 });
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

  // Resolve Square customer (same path used by enqueueBowlingSurvey).
  let audience;
  try {
    const [firstName, ...rest] = body.guestName.trim().split(/\s+/);
    audience = await resolveAudienceMember({
      phone: phoneE164,
      firstName,
      lastName: rest.join(" "),
      email: body.guestEmail,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "audience resolve failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  const baseKey = `gsrt-${randomBytes(8).toString("hex")}`;
  console.log(
    `[admin-debug] issue-reward-test phone=${phoneE164} customer=${audience.squareCustomerId}` +
      ` kind=${body.kind} baseKey=${baseKey}`,
  );

  let result;
  try {
    result = await issueReward({
      customerId: audience.squareCustomerId,
      phoneE164,
      locationId: body.centerCode,
      kind: body.kind,
      baseKey,
      surveyId: body.surveyId,
      reason: "Admin reward test",
    });
  } catch (err) {
    console.error("[admin-debug] issue-reward-test failed:", err);
    return NextResponse.json(
      {
        error: "reward issuance failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  console.log(`[admin-debug] issue-reward-test result=${JSON.stringify(result)}`);
  return NextResponse.json({
    ok: true,
    customerId: audience.squareCustomerId,
    result,
  });
}
