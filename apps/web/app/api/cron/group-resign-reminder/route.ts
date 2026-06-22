import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { type GroupFunctionQuote } from "@/lib/group-function-db";
import { notifyResignReminder } from "@/lib/group-function-notify";
import { verifyCron } from "@/lib/cron-auth";

/**
 * Re-sign urgency reminder cron.
 *
 * Runs every 15 minutes. Targets quotes stuck in `resign_required` — the contract
 * was reissued (price/details changed after deposit) and the guest must re-sign
 * before we can re-confirm the BMI event and settle the balance. Two escalating
 * tiers keyed off time-to-event, each with its own audit-log dedup so a quote gets
 * at most one of each:
 *
 *   - "48h": event in 24–48h, no `resign_48hr_reminder_sent` yet.
 *   - "24h": event in 0–24h (future), no `resign_24hr_reminder_sent` yet — FINAL NOTICE.
 *
 * A quote that first enters the window inside 24h gets only the 24h notice (the 48h
 * window has already passed), which is the correct, non-spammy behavior.
 */

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const q = sql();

  // 48h tier: event 24–48h away, no 48h reminder yet.
  const tier48 = (await q`
    SELECT gfq.* FROM group_function_quotes gfq
    WHERE gfq.status = 'resign_required'
      AND gfq.event_date > NOW() + INTERVAL '24 hours'
      AND gfq.event_date <= NOW() + INTERVAL '48 hours'
      AND NOT EXISTS (
        SELECT 1 FROM contract_audit_log cal
        WHERE cal.quote_id = gfq.id AND cal.event = 'resign_48hr_reminder_sent'
      )
    ORDER BY gfq.event_date ASC
    LIMIT 25
  `) as GroupFunctionQuote[];

  // 24h tier: event 0–24h away (still future), no 24h reminder yet.
  const tier24 = (await q`
    SELECT gfq.* FROM group_function_quotes gfq
    WHERE gfq.status = 'resign_required'
      AND gfq.event_date > NOW()
      AND gfq.event_date <= NOW() + INTERVAL '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM contract_audit_log cal
        WHERE cal.quote_id = gfq.id AND cal.event = 'resign_24hr_reminder_sent'
      )
    ORDER BY gfq.event_date ASC
    LIMIT 25
  `) as GroupFunctionQuote[];

  if (dryRun) {
    const shape = (qq: GroupFunctionQuote) => ({
      id: qq.id,
      eventName: qq.event_name,
      eventDate: qq.event_date,
      balanceCents: qq.balance_cents,
      guestEmail: qq.guest_email,
      hasPhone: Boolean(qq.guest_phone),
    });
    return NextResponse.json({
      ok: true,
      dryRun: true,
      tier48: { count: tier48.length, quotes: tier48.map(shape) },
      tier24: { count: tier24.length, quotes: tier24.map(shape) },
    });
  }

  let sent = 0;
  let errors = 0;

  const run = async (quotes: GroupFunctionQuote[], tier: "48h" | "24h") => {
    const auditEvent = tier === "48h" ? "resign_48hr_reminder_sent" : "resign_24hr_reminder_sent";
    for (const quote of quotes) {
      try {
        await notifyResignReminder(quote, tier);
        await q`INSERT INTO contract_audit_log (quote_id, event, metadata)
          VALUES (${quote.id}, ${auditEvent}, ${JSON.stringify({ balanceCents: quote.balance_cents })})`;
        sent++;
        console.log(
          `[group-resign-reminder] ${tier} sent for quote=${quote.id} event="${quote.event_name}"`,
        );
      } catch (err) {
        errors++;
        console.error(`[group-resign-reminder] ${tier} failed for quote=${quote.id}:`, err);
      }
    }
  };

  await run(tier48, "48h");
  await run(tier24, "24h");

  console.log(
    `[group-resign-reminder] checked48=${tier48.length} checked24=${tier24.length} sent=${sent} errors=${errors}`,
  );
  return NextResponse.json({
    ok: true,
    checked48: tier48.length,
    checked24: tier24.length,
    sent,
    errors,
  });
}
