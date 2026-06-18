import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { sendEmail } from "@/lib/sendgrid";
import { buildAlmostHereEmail } from "@/lib/healthnet-almost-here";
import { verifyCron } from "@/lib/cron-auth";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

/**
 * ONE-TIME "we haven't heard from you" reminder for the Healthcare Network Team
 * Day — goes out the afternoon before (default Thu 3 PM ET) to guests who have
 * NOT checked in yet (no confirmedAt). Same check-in CTA, "reminder" framing.
 *
 * REMOVE the vercel.json cron entry after it runs (one-shot).
 *
 * Query params: ?dryRun=1 | ?test=email[&base=url] | ?force=1 | ?limit=N
 * Kill switch: env HEALTHNET_REMINDER_DISABLE=1.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SLUG = "healthnet-2026";
const RECIPIENT_DOMAINS = ["healthcareswfl.org"];
const SENT_TTL = 60 * 60 * 24 * 14;
const sentKey = (email: string) => `groupevent:${SLUG}:reminder-sent:${email.toLowerCase()}`;
const AUDIT_BCC = "vendorcases@dassle.us";

/** Reminder window start — Thursday 2026-06-18, 3:00 PM ET (19:00 UTC). Env-overridable. */
function windowStart(): number {
  return new Date(process.env.HEALTHNET_REMINDER_SEND_AT || "2026-06-18T19:00:00.000Z").getTime();
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

  if (test) {
    const base = p.get("base") || undefined;
    const raw = await redis.get(`groupevent:${SLUG}:rsvp:${test.toLowerCase()}`);
    const rsvp: GroupEventRsvp = raw
      ? JSON.parse(raw)
      : { name: "Test Guest", email: test, freeflow: [], reservations: [], updatedAt: "" };
    const { subject, html, text } = buildAlmostHereEmail(
      { ...rsvp, email: test },
      { baseOverride: base, reminder: true },
    );
    const r = await sendEmail({ to: test, subject, html, text });
    return NextResponse.json({ test, sent: r.ok, status: r.status, error: r.error });
  }

  if (process.env.HEALTHNET_REMINDER_DISABLE === "1") {
    return NextResponse.json({ ok: true, skipped: "disabled — HEALTHNET_REMINDER_DISABLE=1" });
  }

  const now = Date.now();
  const start = windowStart();
  if (!force && (now < start || now >= start + WINDOW_MS)) {
    return NextResponse.json({
      ok: true,
      skipped: "outside reminder window",
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
    skippedCheckedIn = 0,
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
    // Only nudge guests who have NOT checked in yet.
    if (rsvp.confirmedAt) {
      skippedCheckedIn++;
      continue;
    }
    eligible++;
    if (await redis.get(sentKey(lower))) {
      alreadySent++;
      continue;
    }
    if (dryRun) continue;

    const { subject, html, text } = buildAlmostHereEmail(rsvp, { reminder: true });
    const r = await sendEmail({
      to: rsvp.email,
      toName: rsvp.name,
      subject,
      html,
      text,
      bcc: AUDIT_BCC,
    });
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
    skippedCheckedIn,
    failed,
    errors: errors.slice(0, 10),
  });
}
