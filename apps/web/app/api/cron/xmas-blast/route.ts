import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { sendEmail } from "@/lib/sendgrid";
import { voxSend } from "@/lib/sms-retry";
import { hasMarketingOptIn, normalizePhoneE164, recordTouch } from "~/features/marketing";
import {
  XMAS_SEGMENTS,
  XMAS_CAMPAIGN,
  XMAS_AUDIT_BCC,
  renderXmasEmail,
  getSegmentEmails,
  getRecipient,
  wasEmailSent,
  markEmailSent,
  wasSmsSent,
  markSmsSent,
  type XmasSegment,
} from "@/lib/xmas-blast";

/**
 * ONE-TIME "Christmas in July" business-partner blast.
 *
 * Emails every seeded 2025 group-event contact their center's invite (Naples →
 * July 23, Fort Myers → July 30). SMS is a CONSENT-GATED supplement: only sent to
 * numbers with a marketing opt-in on file (default-deny), never the raw list.
 *
 * Seed the audience first:  npx tsx scripts/seed-xmas-recipients.mts
 * Upload the flyers first:   node scripts/upload-xmas-flyers.mjs
 *
 * Sends ONCE per recipient (Redis flag), only within a 24h window on the send
 * date (XMAS_BLAST_SEND_AT). REMOVE the vercel.json cron entry after it runs.
 *
 * Query params:
 *   ?dryRun=1              count eligible, send nothing
 *   ?test=email@x.com      send ONE real email to this address (bypasses window+dedup)
 *   ?testSms=+12395551234  send ONE real SMS to this number (QA — bypasses consent+dedup)
 *   ?segment=naples|fortmyers|both   (default both)
 *   ?channel=email|sms|both          (default both; sms still consent-gated)
 *   ?force=1               bypass the date window (still per-recipient deduped)
 *   ?limit=N               cap emails sent this run (default 2000)
 *
 * Kill switch: set XMAS_BLAST_DISABLE=1.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Send-window start. Default 2026-07-17 09:00 ET (13:00 UTC). Owner sets the real date via env. */
function windowStart(): number {
  return new Date(process.env.XMAS_BLAST_SEND_AT || "2026-07-17T13:00:00.000Z").getTime();
}

const ASM_GROUP = process.env.XMAS_ASM_GROUP_ID ? Number(process.env.XMAS_ASM_GROUP_ID) : null;

/** Unsubscribe link for the template: SendGrid ASM tag when a group is configured, else a mailto fallback. */
function unsubUrl(): string {
  return ASM_GROUP
    ? "<%asm_group_unsubscribe_raw_url%>"
    : "mailto:unsubscribe@headpinz.com?subject=Unsubscribe%20-%20Christmas%20in%20July";
}

async function sendOneEmail(
  segment: XmasSegment,
  to: string,
  toName: string | undefined,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const { subject, html, text, fromName } = renderXmasEmail(segment, { unsubUrl: unsubUrl() });
  return sendEmail({
    to,
    toName,
    from: { email: "noreply@headpinz.com", name: fromName },
    subject,
    html,
    text,
    bcc: XMAS_AUDIT_BCC,
    categories: [XMAS_CAMPAIGN, `xmas_${segment}`],
    ...(ASM_GROUP
      ? { asm: { groupId: ASM_GROUP } }
      : { headers: { "List-Unsubscribe": "<mailto:unsubscribe@headpinz.com>" } }),
  });
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const p = req.nextUrl.searchParams;
  const dryRun = p.get("dryRun") === "1";
  const test = p.get("test");
  const testSms = p.get("testSms");
  const force = p.get("force") === "1";
  const limit = Number(p.get("limit") || 2000);
  const segParam = (p.get("segment") || "both").toLowerCase();
  const channel = (p.get("channel") || "both").toLowerCase();
  const doEmail = channel === "both" || channel === "email";
  const doSms = channel === "both" || channel === "sms";

  const segments: XmasSegment[] =
    segParam === "naples"
      ? ["naples"]
      : segParam === "fortmyers"
        ? ["fortmyers"]
        : ["naples", "fortmyers"];

  // ── QA: single real email ────────────────────────────────────────────────
  if (test) {
    const seg: XmasSegment = segParam === "naples" ? "naples" : "fortmyers";
    const r = await sendOneEmailSafe(seg, test);
    return NextResponse.json({ test, segment: seg, sent: r.ok, status: r.status, error: r.error });
  }
  // ── QA: single real SMS (bypasses consent + dedup — QA only) ──────────────
  if (testSms) {
    const seg: XmasSegment = segParam === "naples" ? "naples" : "fortmyers";
    const phone = normalizePhoneE164(testSms);
    if (!/^\+1\d{10}$/.test(phone)) {
      return NextResponse.json(
        { testSms, error: "invalid phone (want +1XXXXXXXXXX)" },
        { status: 400 },
      );
    }
    const sr = await voxSend(phone, XMAS_SEGMENTS[seg].smsBody);
    return NextResponse.json({
      testSms: phone,
      segment: seg,
      sent: sr.ok,
      status: sr.status,
      error: sr.error,
    });
  }

  if (process.env.XMAS_BLAST_DISABLE === "1") {
    return NextResponse.json({ ok: true, skipped: "disabled — XMAS_BLAST_DISABLE=1" });
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

  const stats = {
    emailEligible: 0,
    emailSent: 0,
    emailAlready: 0,
    emailFailed: 0,
    smsEligible: 0,
    smsSent: 0,
    smsAlready: 0,
    smsNoConsent: 0,
    smsNoPhone: 0,
    smsFailed: 0,
    perSegment: {} as Record<string, { emails: number; emailSent: number; smsSent: number }>,
  };
  const errors: { email: string; kind: string; status: number | null; error?: string }[] = [];

  for (const seg of segments) {
    const segStat = { emails: 0, emailSent: 0, smsSent: 0 };
    stats.perSegment[seg] = segStat;
    const emails = await getSegmentEmails(seg);

    for (const emailRaw of emails) {
      if (stats.emailSent >= limit) break;
      const email = emailRaw.toLowerCase();
      const rec = await getRecipient(email);
      if (!rec) continue;
      segStat.emails++;

      // ── Email ────────────────────────────────────────────────────────────
      if (doEmail) {
        stats.emailEligible++;
        if (await wasEmailSent(email)) {
          stats.emailAlready++;
        } else if (!dryRun) {
          const r = await sendOneEmailSafe(seg, email, rec.name || undefined);
          if (r.ok) {
            await markEmailSent(email);
            stats.emailSent++;
            segStat.emailSent++;
          } else {
            stats.emailFailed++;
            errors.push({ email, kind: "email", status: r.status, error: r.error });
          }
        }
      }

      // ── SMS (consent-gated) ────────────────────────────────────────────────
      if (doSms) {
        const phone = rec.phone ? normalizePhoneE164(rec.phone) : "";
        if (!/^\+1\d{10}$/.test(phone)) {
          stats.smsNoPhone++;
        } else if (await wasSmsSent(phone)) {
          stats.smsAlready++;
        } else if (!(await hasMarketingOptIn(phone))) {
          stats.smsNoConsent++;
        } else {
          stats.smsEligible++;
          if (!dryRun) {
            const sr = await voxSend(phone, XMAS_SEGMENTS[seg].smsBody);
            if (sr.ok) {
              await markSmsSent(phone);
              stats.smsSent++;
              segStat.smsSent++;
              try {
                await recordTouch({
                  customerId: `email:${email}`,
                  phoneE164: phone,
                  campaign: XMAS_CAMPAIGN,
                  event: "sent",
                  channel: "sms",
                  refId: seg,
                });
              } catch {
                /* touch logging is best-effort */
              }
            } else {
              stats.smsFailed++;
              errors.push({ email, kind: "sms", status: sr.status, error: sr.error });
            }
          }
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    channel,
    segments,
    ...stats,
    errors: errors.slice(0, 10),
  });
}

/** Wrap the email send so a render/throw on one recipient never aborts the batch. */
async function sendOneEmailSafe(
  segment: XmasSegment,
  to: string,
  toName?: string,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  try {
    return await sendOneEmail(segment, to, toName);
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "render/send threw",
    };
  }
}
