import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { logBmiCancelEvent } from "@/lib/bmi-cancel-log";

/**
 * POST /api/booking/v2/log-rebuild
 *
 * Records a PAYMENT-PATH rebuild (rebuildRaceBillIfExpired, client-side) into the
 * same bmi_cancel_events evidence log the cron uses — so "anytime we rebuild, on
 * a payment or on cron" is one durable record for the BMI bug report.
 *
 * The client fires this fire-and-forget right after it rebuilds a BMI-
 * auto-cancelled bill into a fresh one at checkout. The booking's BMI API calls
 * (availability / booking/book / register / confirm) were already logged to the
 * Redis `bmi:api:log` by the /api/bmi proxy; we pull the entries for the old +
 * new bill and persist them as this event's api_calls evidence.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      oldBillId?: string;
      newBillId?: string;
      heatStart?: string;
      guestName?: string;
      guestPhone?: string;
    };
    const oldBillId = String(body.oldBillId ?? "");
    const newBillId = String(body.newBillId ?? "");
    // Both must look like BMI bigint ids — reject anything else (low-trust route).
    if (!/^\d{10,}$/.test(oldBillId) || !/^\d{10,}$/.test(newBillId)) {
      return NextResponse.json({ error: "valid oldBillId + newBillId required" }, { status: 400 });
    }

    // Pull the matching BMI proxy call log entries as evidence (best-effort).
    let apiCalls: unknown[] = [];
    try {
      const raw = await redis.lrange("bmi:api:log", 0, 300);
      apiCalls = (raw || [])
        .map((e) => {
          try {
            return typeof e === "string" ? JSON.parse(e) : e;
          } catch {
            return null;
          }
        })
        .filter(
          (e): e is { orderId?: string } =>
            !!e && (e.orderId === oldBillId || e.orderId === newBillId),
        )
        .slice(0, 30);
    } catch {
      /* Redis miss — evidence still has the old→new linkage below */
    }

    await logBmiCancelEvent({
      billId: oldBillId,
      productKind: "race",
      heatStart: body.heatStart ?? null,
      // Payment-path rebuilds happen at checkout, so the race is always upcoming.
      isFuture: true,
      guestName: body.guestName ?? null,
      guestPhone: body.guestPhone ?? null,
      classification: "system_cancel",
      action: "rebuilt",
      rebuildBillId: newBillId,
      notes: "rebuilt at payment (pre-charge guard found the held bill auto-cancelled)",
      apiCalls: apiCalls.length
        ? apiCalls
        : [{ step: "payment-path-rebuild", oldBillId, newBillId }],
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "log-rebuild failed" },
      { status: 500 },
    );
  }
}
