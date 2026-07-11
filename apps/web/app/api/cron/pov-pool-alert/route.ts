import { NextRequest, NextResponse } from "next/server";
import { Redis } from "ioredis";
import { verifyCron } from "@/lib/cron-auth";
import { sendEmail } from "@/lib/sendgrid";

/**
 * POV code pool low-water alert.
 *
 * The POV voucher pool (Redis SET `pov:codes`) is refilled manually —
 * staff export a batch from VT3 and import via
 * `scripts/import-pov-codes.ts`. When it runs dry, every claim silently
 * returns zero codes (the confirmation page, BMI memo, email and SMS
 * all gate on `codes.length > 0`), so racers stop receiving codes with
 * no visible error anywhere. That's exactly what happened 2026-07-09 →
 * 2026-07-10: the pool sat at 0 for ~30 hours and 19 paid bookings (57
 * codes) had to be backfilled by hand.
 *
 * This cron checks the pool every run and emails ops when it drops
 * below the threshold. Burn rate is ~50-70 codes/day, so the default
 * threshold of 200 gives ~3 days of runway.
 *
 *   GET /api/cron/pov-pool-alert
 *       ?force=1   — send even if the dedupe key says we alerted recently
 *
 * Dedupe: one email per severity level per ~20h (Redis SET NX), so the
 * 6-hourly schedule doesn't spam. Escalation low → EMPTY alerts again
 * immediately (separate dedupe key per level).
 */

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const POOL_KEY = "pov:codes";
const USED_KEY = "pov:used";
const THRESHOLD = parseInt(process.env.POV_POOL_ALERT_THRESHOLD || "200", 10);
const RECIPIENTS = (process.env.POV_POOL_ALERT_EMAILS || "eric@headpinz.com,alex@headpinz.com")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
const DEDUPE_TTL_SECONDS = 20 * 60 * 60;

export async function GET(req: NextRequest) {
  const authFail = verifyCron(req);
  if (authFail) return authFail;

  const force = req.nextUrl.searchParams.get("force") === "1";
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();
    const available = await redis.scard(POOL_KEY);
    const used = await redis.hlen(USED_KEY);

    if (available >= THRESHOLD) {
      return NextResponse.json({ ok: true, available, used, threshold: THRESHOLD });
    }

    const level = available === 0 ? "empty" : "low";
    const dedupeKey = `pov:pool-alert:sent:${level}`;
    if (!force) {
      const first = await redis.set(dedupeKey, new Date().toISOString(), "EX", DEDUPE_TTL_SECONDS, "NX");
      if (first !== "OK") {
        return NextResponse.json({ ok: true, available, level, alerted: false, deduped: true });
      }
    }

    const subject =
      level === "empty"
        ? "POV code pool EMPTY - racers are NOT receiving codes"
        : `POV code pool low: ${available} codes left`;
    const html = `<p style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A1A;">
The POV voucher pool is ${level === "empty" ? "<strong>EMPTY</strong>. Every booking with POV since it ran out has received no codes — silently." : `down to <strong>${available}</strong> codes (threshold ${THRESHOLD}).`}
</p>
<p style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A1A;">
Burn rate is roughly 50–70 codes/day. To refill:
</p>
<ol style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A1A;">
  <li>Export a fresh unlock-code batch from VT3.</li>
  <li>Import it: <code>npx tsx scripts/import-pov-codes.ts codes.csv</code> (repo apps/web).</li>
</ol>
<p style="font-family:Arial,sans-serif;font-size:13px;color:#555;">
Pool stats: ${available} available / ${used} used — live at
<a href="https://fasttraxent.com/api/pov-codes?action=stats">/api/pov-codes?action=stats</a>.
${level === "empty" ? "Bookings shorted while empty need a manual backfill (claim per bill + resend) — see tasks/lessons or the 2026-07-10 incident notes." : ""}
</p>`;

    const results: Record<string, boolean> = {};
    for (const to of RECIPIENTS) {
      try {
        const sent = await sendEmail({ to, subject, html });
        results[to] = sent.ok;
      } catch {
        results[to] = false;
      }
    }
    console.log(
      `[pov-pool-alert] ${level}: available=${available} threshold=${THRESHOLD} sent=${JSON.stringify(results)}`,
    );

    return NextResponse.json({ ok: true, available, used, level, alerted: true, results });
  } catch (err) {
    console.error("[pov-pool-alert] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "alert check failed" },
      { status: 500 },
    );
  } finally {
    redis.disconnect();
  }
}
