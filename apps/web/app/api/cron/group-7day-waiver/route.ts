import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { type GroupFunctionQuote } from "@/lib/group-function-db";
import { fetchProject, hasWaiverRequiredActivities } from "@/lib/bmi-office-actions";

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
      let waiverUrl: string | null = null;
      try {
        const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
        if (project?.projectReference) {
          const clientKey = CLIENT_KEYS[quote.center_code] || "headpinzftmyers";
          waiverUrl = `https://kiosk.sms-timing.com/${clientKey}/subscribe/event?id=${encodeURIComponent(project.projectReference as string)}`;
        }
      } catch {
        /* non-fatal */
      }

      if (!waiverUrl) {
        console.warn(`[group-7day-waiver] no waiver URL for quote=${quote.id}, skipping`);
        continue;
      }

      const { notify7DayWaiverReminder } = await import("@/lib/group-function-notify");
      await notify7DayWaiverReminder(quote, waiverUrl);

      await q`INSERT INTO contract_audit_log (quote_id, event, metadata) VALUES (${quote.id}, '7day_waiver_sent', '{}')`;

      sent++;
      console.log(`[group-7day-waiver] sent for quote=${quote.id} event="${quote.event_name}"`);
    } catch (err) {
      errors++;
      console.error(`[group-7day-waiver] failed for quote=${quote.id}:`, err);
    }
  }

  console.log(
    `[group-7day-waiver] checked=${quotes.length} withWaivers=${waiverQuotes.length} sent=${sent} errors=${errors}`,
  );
  return NextResponse.json({
    ok: true,
    checked: quotes.length,
    withWaivers: waiverQuotes.length,
    sent,
    errors,
  });
}
