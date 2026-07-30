import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { type GroupFunctionQuote } from "@/lib/group-function-db";
import { hasWaiverRequiredActivities } from "@/lib/bmi-office-actions";
import { verifyCron } from "@/lib/cron-auth";

/**
 * 7-day waiver reminder cron.
 *
 * Runs every hour. Finds group function quotes where:
 *   - status = 'deposit_paid' (Confirmation + Waiver in BMI)
 *   - event is 6-8 days away
 *   - has waiver-required activities
 *   - 7-day waiver reminder hasn't been sent yet
 *
 * Sends a stronger "action required" waiver email urging completion
 * within 7 days. Replaces the BMI "Waiver Reminder" auto-email.
 */

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const q = sql();

  const quotes = (await q`
    SELECT gfq.* FROM group_function_quotes gfq
    WHERE gfq.status IN ('deposit_paid', 'balance_charged', 'balance_link_sent')
      AND gfq.event_date > NOW() + INTERVAL '6 days'
      AND gfq.event_date <= NOW() + INTERVAL '8 days'
      AND NOT EXISTS (
        SELECT 1 FROM contract_audit_log cal
        WHERE cal.quote_id = gfq.id AND cal.event = '7day_waiver_sent'
      )
    ORDER BY gfq.event_date ASC
    LIMIT 20
  `) as GroupFunctionQuote[];

  // Filter to only events with waiver-required activities
  const waiverQuotes = quotes.filter((quote) => {
    const items = (quote.line_items || []) as Array<{ name: string }>;
    return hasWaiverRequiredActivities(items);
  });

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      total: quotes.length,
      withWaivers: waiverQuotes.length,
      quotes: waiverQuotes.map((q) => ({
        id: q.id,
        eventName: q.event_name,
        eventNumber: q.event_number,
        eventDate: q.event_date,
        guestName: `${q.guest_first_name} ${q.guest_last_name}`,
      })),
    });
  }

  let sent = 0;
  let errors = 0;

  for (const quote of waiverQuotes) {
    try {
      // The waiver link is resolved inside the sender now (lib/waiver-link-send):
      // it needs only center_code + bmi_reservation_id, both already on the quote,
      // so the BMI Office lookup that used to sit here — and the "no waiver URL,
      // skipping" branch that silently dropped a reminder whenever that upstream
      // call failed — are both gone. The sender also needs TWO links (an organizer
      // link and a sign-only one to share), which a single URL argument could not
      // express.
      const { notify7DayWaiverReminder } = await import("@/lib/group-function-notify");
      await notify7DayWaiverReminder(quote);

      await q`INSERT INTO contract_audit_log (quote_id, event, metadata) VALUES (${quote.id}, '7day_waiver_sent', '{}')`;

      sent++;
      console.log(`[group-7day-waiver] sent for quote=${quote.id} event="${quote.event_name}"`);
    } catch (err) {
      errors++;
      console.error(`[group-7day-waiver] failed for quote=${quote.id}:`, err);
    }
  }

  // ── 2-day final waiver warning ──
  const twoDayQuotes = (await q`
    SELECT gfq.* FROM group_function_quotes gfq
    WHERE gfq.status IN ('deposit_paid', 'balance_charged', 'balance_link_sent')
      AND gfq.event_date > NOW() + INTERVAL '36 hours'
      AND gfq.event_date <= NOW() + INTERVAL '60 hours'
      AND NOT EXISTS (
        SELECT 1 FROM contract_audit_log cal
        WHERE cal.quote_id = gfq.id AND cal.event = '2day_waiver_sent'
      )
    ORDER BY gfq.event_date ASC
    LIMIT 20
  `) as GroupFunctionQuote[];

  const twoDayWaiverQuotes = twoDayQuotes.filter((quote) => {
    const items = (quote.line_items || []) as Array<{ name: string }>;
    return hasWaiverRequiredActivities(items);
  });

  let twoDaySent = 0;
  for (const quote of twoDayWaiverQuotes) {
    try {
      // Same as the 7-day path above: the sender resolves both links itself, so the
      // BMI lookup and the silent `continue` that dropped the FINAL waiver warning on
      // an upstream blip are gone.
      const { notify2DayWaiverWarning } = await import("@/lib/group-function-notify");
      await notify2DayWaiverWarning(quote);

      await q`INSERT INTO contract_audit_log (quote_id, event, metadata) VALUES (${quote.id}, '2day_waiver_sent', '{}')`;
      twoDaySent++;
      console.log(
        `[group-7day-waiver] 2-day warning sent for quote=${quote.id} event="${quote.event_name}"`,
      );
    } catch (err) {
      errors++;
      console.error(`[group-7day-waiver] 2-day warning failed for quote=${quote.id}:`, err);
    }
  }

  console.log(
    `[group-7day-waiver] 7day: checked=${quotes.length} sent=${sent} | 2day: checked=${twoDayQuotes.length} sent=${twoDaySent} | errors=${errors}`,
  );
  return NextResponse.json({
    ok: true,
    sevenDay: { checked: waiverQuotes.length, sent },
    twoDay: { checked: twoDayWaiverQuotes.length, sent: twoDaySent },
    errors,
  });
}
