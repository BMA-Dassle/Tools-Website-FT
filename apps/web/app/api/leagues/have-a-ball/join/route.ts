import { NextRequest, NextResponse } from "next/server";
import { processHabJoin } from "~/features/have-a-ball/service";

/**
 * POST /api/leagues/have-a-ball/join
 *
 * One atomic mid-season signup: customer + saved card → back-pay charge →
 * season-capped subscription → persist + email. All money math is recomputed
 * server-side in the service; the client sends no amounts.
 */

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { cardToken, firstName, lastName, email, phone, dob, teamName, smsOptIn, joinAttemptId } =
      body as Record<string, unknown>;

    if (typeof cardToken !== "string" || !cardToken)
      return NextResponse.json({ error: "cardToken required" }, { status: 400 });
    if (typeof email !== "string" || !email)
      return NextResponse.json({ error: "email required" }, { status: 400 });
    if (typeof firstName !== "string" || !firstName)
      return NextResponse.json({ error: "firstName required" }, { status: 400 });
    if (typeof joinAttemptId !== "string" || !joinAttemptId)
      return NextResponse.json({ error: "joinAttemptId required" }, { status: 400 });

    const result = await processHabJoin({
      cardToken,
      firstName,
      lastName: typeof lastName === "string" ? lastName : "",
      email,
      phone: typeof phone === "string" ? phone : "",
      dob: typeof dob === "string" ? dob : "",
      teamName: typeof teamName === "string" ? teamName : null,
      smsOptIn: smsOptIn === true,
      joinAttemptId,
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 500 });
    }

    return NextResponse.json({
      ok: true,
      subscriptionId: result.subscriptionId,
      customerId: result.customerId,
      backPayPaymentId: result.backPayPaymentId,
      plan: result.plan,
    });
  } catch (err) {
    console.error("[hab/join] route error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Join failed" },
      { status: 500 },
    );
  }
}
