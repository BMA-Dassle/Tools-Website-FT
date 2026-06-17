import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { sendEmail } from "@/lib/sendgrid";
import { buildAlmostHereEmail } from "@/lib/healthnet-almost-here";
import { verifyCron } from "@/lib/cron-auth";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

/**
 * ONE-TIME "your event is almost here" send for the Healthcare Network Team Day.
 *
 * Drives every healthcareswfl.org RSVP guest to the /event/healthnet-2026/confirm
 * page to capture a mobile number (so day-of e-tickets / check-in functions have
 * a phone). Sends ONCE per recipient (Redis flag), only within the intended
 * 24h window on the send date.
 *
 * REMOVE the vercel.json cron entry after it runs (one-shot, like the racing
 * survey backfill precedent).
 *
 * Query params:
 *   ?dryRun=1            count eligible recipients, send nothing
 *   ?test=email@x.com    send a single real email to this address (QA), bypasses window + dedup
 *   ?force=1             bypass the date window (still per-recipient deduped)
 *   ?limit=N             cap sends this run (default 1000)
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SLUG = "healthnet-2026";
// Real guests only — excludes staff/test entries on headpinz.com / fasttraxent.com.
const RECIPIENT_DOMAINS = ["healthcareswfl.org"];
const SENT_TTL = 60 * 60 * 24 * 14; // 14 days
const sentKey = (email: string) => `groupevent:${SLUG}:almosthere-sent:${email.toLowerCase()}`;

/** Send window start — Thursday 2026-06-18, 8:00 AM ET (12:00 UTC). Env-overridable. */
function windowStart(): number {
  return new Date(process.env.HEALTHNET_ALMOSTHERE_SEND_AT || "2026-06-18T12:00:00.000Z").getTime();
}
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const p = req.nextUrl.searchParams;
  const dryRun = p.get("dryRun") === "1";
  const test = p.get("test");
  const force = p.get("force") === "1";
  const limit = Number(p.get("limit") || 1000);

  // QA: send a single real email to a chosen address (uses their RSVP if present).
  // ?base=<url> points the confirm link at a preview deployment for testing.
  if (test) {
    const base = p.get("base") || undefined;
    const raw = await redis.get(`groupevent:${SLUG}:rsvp:${test.toLowerCase()}`);
    const rsvp: GroupEventRsvp = raw
      ? JSON.parse(raw)
      : {
          name: "Test Guest",
          email: test,
          freeflow: ["bowling", "food"],
          reservations: [],
          updatedAt: "",
        };
    const { subject, html, text } = buildAlmostHereEmail(
      { ...rsvp, email: test },
      { baseOverride: base },
    );
    const r = await sendEmail({ to: test, subject, html, text });
    return NextResponse.json({
      test,
      base: base ?? null,
      sent: r.ok,
      status: r.status,
      error: r.error,
    });
  }

  const now = Date.now();
  const start = windowStart();
  if (!force && (now < start || now >= start + WINDOW_MS)) {
    return NextResponse.json({
      ok: true,
      skipped: "outside send window",
      windowStart: new Date(start).toISOString(),
      now: new Date(now).toISOString(),
    });
  }

  const emails = await redis.smembers(`groupevent:${SLUG}:rsvp-index`);
  let eligible = 0,
    sent = 0,
    alreadySent = 0,
    skippedDomain = 0,
    skippedNoRecord = 0,
    failed = 0;
  const errors: { email: string; status: number | null; error?: string }[] = [];

  for (const email of emails) {
    if (sent >= limit) break;
    const lower = email.toLowerCase();
    const domain = lower.split("@")[1] || "";
    if (!RECIPIENT_DOMAINS.includes(domain)) {
      skippedDomain++;
      continue;
    }
    const raw = await redis.get(`groupevent:${SLUG}:rsvp:${lower}`);
    if (!raw) {
      skippedNoRecord++;
      continue;
    }
    let rsvp: GroupEventRsvp;
    try {
      rsvp = JSON.parse(raw);
    } catch {
      skippedNoRecord++;
      continue;
    }
    eligible++;
    if (await redis.get(sentKey(lower))) {
      alreadySent++;
      continue;
    }
    if (dryRun) continue;

    const { subject, html, text } = buildAlmostHereEmail(rsvp);
    const r = await sendEmail({ to: rsvp.email, toName: rsvp.name, subject, html, text });
    if (r.ok) {
      await redis.set(sentKey(lower), "1", "EX", SENT_TTL);
      sent++;
    } else {
      failed++;
      errors.push({ email: lower, status: r.status, error: r.error });
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    total: emails.length,
    eligible,
    sent,
    alreadySent,
    skippedDomain,
    skippedNoRecord,
    failed,
    errors: errors.slice(0, 10),
  });
}
