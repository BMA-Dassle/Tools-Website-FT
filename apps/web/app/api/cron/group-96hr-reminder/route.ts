import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { type GroupFunctionQuote } from "@/lib/group-function-db";
import { notify96HourReminder } from "@/lib/group-function-notify";
import { fetchProject } from "@/lib/bmi-office-actions";

/**
 * 96-hour reminder cron.
 *
 * Runs every 15 minutes. Finds group function quotes where:
 *   - status = 'deposit_paid'
 *   - event is within 96 hours but more than 72 hours away
 *   - reminder hasn't been sent yet (no 96hr_reminder audit log)
 *
 * Sends a reminder email: verify details, update card, complete waivers.
 */

const CLIENT_KEYS: Record<string, string> = {
  "fort-myers": "headpinzftmyers",
  fasttrax: "headpinzftmyers",
  naples: "headpinznaples",
};

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const q = sql();

  // Find events 72-96 hours away that haven't had a reminder sent
  const quotes = (await q`
    SELECT gfq.* FROM group_function_quotes gfq
    WHERE gfq.status = 'deposit_paid'
      AND gfq.event_date > NOW() + INTERVAL '72 hours'
      AND gfq.event_date <= NOW() + INTERVAL '96 hours'
      AND NOT EXISTS (
        SELECT 1 FROM contract_audit_log cal
        WHERE cal.quote_id = gfq.id AND cal.event = '96hr_reminder_sent'
      )
    ORDER BY gfq.event_date ASC
    LIMIT 20
  `) as GroupFunctionQuote[];

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      count: quotes.length,
      quotes: quotes.map((q) => ({
        id: q.id,
        eventName: q.event_name,
        eventDate: q.event_date,
        balanceCents: q.balance_cents,
      })),
    });
  }

  let sent = 0;
  let errors = 0;

  for (const quote of quotes) {
    try {
      // Fetch waiver URL from BMI Office
      let waiverUrl: string | null = null;
      try {
        const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
        if (project?.projectReference) {
          const clientKey = CLIENT_KEYS[quote.center_code] || "headpinzftmyers";
          waiverUrl = `https://kiosk.sms-timing.com/${clientKey}/subscribe/event?id=${encodeURIComponent(project.projectReference as string)}`;
        }
      } catch { /* non-fatal */ }

      await notify96HourReminder(quote, waiverUrl);

      // Record that reminder was sent
      await q`INSERT INTO contract_audit_log (quote_id, event, metadata) VALUES (${quote.id}, '96hr_reminder_sent', '{}')`;

      sent++;
      console.log(`[group-96hr-reminder] sent for quote=${quote.id} event="${quote.event_name}"`);
    } catch (err) {
      errors++;
      console.error(`[group-96hr-reminder] failed for quote=${quote.id}:`, err);
    }
  }

  console.log(`[group-96hr-reminder] checked=${quotes.length} sent=${sent} errors=${errors}`);
  return NextResponse.json({ ok: true, checked: quotes.length, sent, errors });
}
