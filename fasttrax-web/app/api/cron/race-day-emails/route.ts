import { NextRequest, NextResponse } from "next/server";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const BOOKING_API_KEY = "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";
const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";

/**
 * Cron job: Send race-day-instructions emails 1 hour before each race.
 * Runs every 10 minutes via Vercel cron.
 *
 * Finds confirmed racing bookings for today where the earliest heat
 * starts in 60-75 minutes. Sends the race-day email if not already sent.
 */
export async function GET(req: NextRequest) {
  // Auth: Vercel cron sends Authorization header with CRON_SECRET
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();

    // Get today's date in ET (Eastern Time — FastTrax is in Florida)
    const now = new Date();
    const etFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const todayET = etFormatter.format(now); // YYYY-MM-DD

    // Get all booking records for today
    const billIds = await redis.smembers(`bookingrecord:date:${todayET}`);
    if (billIds.length === 0) {
      redis.disconnect();
      return NextResponse.json({ processed: 0, sent: 0, date: todayET });
    }

    let processed = 0;
    let sent = 0;
    const errors: string[] = [];

    for (const billId of billIds) {
      try {
        const raw = await redis.get(`bookingrecord:${billId}`);
        if (!raw) continue;
        const record = JSON.parse(raw);

        // Only confirmed racing bookings with racers
        if (record.status !== "confirmed") continue;
        const racers = record.racers || [];
        if (racers.length === 0) continue;

        // Find earliest heat start time
        const heatStarts = racers
          .map((r: { heatStart?: string }) => r.heatStart)
          .filter(Boolean)
          .sort();
        if (heatStarts.length === 0) continue; // Not a racing booking

        const earliestHeat = heatStarts[0];
        // Parse as local ET time (BMI times are local, no Z suffix)
        const heatTime = new Date(earliestHeat.replace(/Z$/, ""));

        // Check if heat is 60-75 minutes from now
        const nowMs = Date.now();
        const heatMs = heatTime.getTime();
        const diffMin = (heatMs - nowMs) / 60_000;

        if (diffMin < 55 || diffMin > 80) continue; // Outside window (with 5min buffer)

        // Check dedup — already sent?
        const dedupKey = `notif:raceday:${billId}`;
        const alreadySent = await redis.get(dedupKey);
        if (alreadySent) continue;

        processed++;

        // Get contact info
        const contact = record.contact || {};
        const email = contact.email;
        if (!email) continue;

        // Build schedule text
        const scheduleLines = racers
          .filter((r: { heatStart?: string }) => r.heatStart)
          .map((r: { racerName?: string; heatName?: string; heatStart?: string }) => {
            const time = new Date(r.heatStart!.replace(/Z$/, "")).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
            return `<strong>${r.racerName || "Racer"}</strong> — ${r.heatName || "Race"} at ${time}`;
          });
        const schedule = scheduleLines.join("<br/>");

        // Build confirmation URL
        const confirmUrl = `${BASE_URL}/book/confirmation?billId=${billId}`;

        // Determine express lane
        const expressLane = record.fastLane === true;

        // Determine waiver URL
        const waiverUrl = record.waiverUrl || "https://kiosk.sms-timing.com/headpinzftmyers/subscribe";

        // Send via the notification API
        const notifRes = await fetch(`${BASE_URL}/api/notifications/race-day-instructions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            billId,
            email,
            firstName: contact.firstName || "Racer",
            expressLane,
            schedule,
            waiverUrl,
            confirmUrl,
          }),
        });

        if (notifRes.ok) {
          const result = await notifRes.json();
          if (!result.duplicate) sent++;
          console.log(`[race-day-cron] ${result.duplicate ? "SKIP (dup)" : "SENT"} ${billId} → ${email} (heat in ${Math.round(diffMin)}min, express=${expressLane})`);
        } else {
          errors.push(`${billId}: HTTP ${notifRes.status}`);
        }
      } catch (err) {
        errors.push(`${billId}: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    redis.disconnect();
    return NextResponse.json({
      date: todayET,
      totalBookings: billIds.length,
      processed,
      sent,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    redis.disconnect();
    console.error("[race-day-cron] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
