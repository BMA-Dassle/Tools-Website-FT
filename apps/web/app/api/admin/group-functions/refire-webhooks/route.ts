import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { type GroupFunctionQuote } from "@/lib/group-function-db";
import { serviceChargeCentsFromLineItems } from "@/lib/service-charge";
import { firePortalWebhook, type PortalWebhookEvent } from "@/lib/portal-webhook";

/**
 * Admin: re-fire portal webhooks so the portal re-pulls events and grabs their
 * service charges.
 *
 * Background: the service-charge split on Square orders is forward-only. Events
 * paid before that deploy still carry the service charge in their line items
 * (and our /api/portal/documents API already exposes serviceChargeCents from
 * line_items) — the portal just needs to re-ingest them. This pushes a
 * notification per event so the portal re-pulls the (already-correct) data.
 *
 * POST /api/admin/group-functions/refire-webhooks?token=...
 *   &sinceDays=10        — events with a deposit/balance paid in the last N days (default 10)
 *   &bmiCodes=3286,3289  — OR an explicit comma-separated list (overrides sinceDays)
 *   &event=document.updated  — webhook event to fire (default document.updated)
 *   &dryRun=1            — list what WOULD fire, fire nothing
 *
 * Only events that actually have a service charge are re-fired.
 */

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 });
  }

  const params = req.nextUrl.searchParams;
  const dryRun = params.get("dryRun") === "1";
  const sinceDays = Math.min(Math.max(Number(params.get("sinceDays") || "10"), 1), 90);
  const event = (params.get("event") || "document.updated") as PortalWebhookEvent;
  const bmiCodes = (params.get("bmiCodes") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const q = sql();
  let rows: GroupFunctionQuote[];
  try {
    rows =
      bmiCodes.length > 0
        ? ((await q`
            SELECT * FROM group_function_quotes
            WHERE bmi_reservation_id = ANY(${bmiCodes})
              AND contract_short_id IS NOT NULL
          `) as GroupFunctionQuote[])
        : ((await q`
            SELECT * FROM group_function_quotes
            WHERE contract_short_id IS NOT NULL
              AND (deposit_paid_at >= NOW() - (${sinceDays} || ' days')::interval
                   OR balance_paid_at >= NOW() - (${sinceDays} || ' days')::interval)
            ORDER BY deposit_paid_at ASC NULLS LAST
          `) as GroupFunctionQuote[]);
  } catch (err) {
    console.error("[refire-webhooks] DB query failed:", err);
    return NextResponse.json({ error: "DB query failed" }, { status: 500 });
  }

  // Only events that actually carry a service charge need re-ingesting.
  const targets = rows
    .map((r) => ({ quote: r, serviceChargeCents: serviceChargeCentsFromLineItems(r.line_items) }))
    .filter((t) => t.serviceChargeCents > 0);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      event,
      count: targets.length,
      targets: targets.map((t) => ({
        bmiCode: t.quote.bmi_reservation_id,
        documentId: t.quote.contract_short_id,
        eventName: t.quote.event_name,
        venue: t.quote.center_code,
        status: t.quote.status,
        serviceChargeCents: t.serviceChargeCents,
      })),
    });
  }

  const results = await Promise.allSettled(
    targets.map((t) =>
      firePortalWebhook(event, {
        documentId: t.quote.contract_short_id,
        bmiCode: t.quote.bmi_reservation_id,
        venue: t.quote.center_code,
        status: t.quote.status,
      }),
    ),
  );

  const fired = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - fired;

  console.log(
    `[refire-webhooks] event=${event} targets=${targets.length} fired=${fired} failed=${failed}`,
  );

  return NextResponse.json({
    ok: true,
    event,
    total: targets.length,
    fired,
    failed,
    targets: targets.map((t, i) => ({
      bmiCode: t.quote.bmi_reservation_id,
      documentId: t.quote.contract_short_id,
      eventName: t.quote.event_name,
      serviceChargeCents: t.serviceChargeCents,
      delivered: results[i].status === "fulfilled",
    })),
  });
}
