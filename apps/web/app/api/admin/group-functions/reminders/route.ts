import { NextRequest, NextResponse } from "next/server";
import {
  getGfQuoteByShortId,
  getAuditLog,
  getEventNotifications,
  recordEventNotification,
} from "@/lib/group-function-db";
import { RULES, buildWaiverUrl, type RuleContext } from "@/lib/group-event-rules";

/**
 * Admin reminder visibility + manual fire.
 *
 * GET  /api/admin/group-functions/reminders?token=&shortId=
 *      → reminder audit history + the group_event_notifications ledger for one event.
 *
 * POST /api/admin/group-functions/reminders
 *      body { token, shortId, ruleKey }
 *      → fire one rule NOW for that event, ignoring the dedup gate. Records a
 *        ledger row but does NOT write the audit dedup row (so scheduled sends
 *        still fire normally).
 */

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

// Audit-log events emitted by the reminder engine / win-back flow.
const REMINDER_EVENTS = new Set([
  ...RULES.map((r) => r.dedupKey ?? r.key),
  "legacy_winback_ingested",
  "winback_incentive_issued",
]);

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shortId = req.nextUrl.searchParams.get("shortId") || "";
  if (!shortId) return NextResponse.json({ error: "shortId required" }, { status: 400 });

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });

  const [audit, ledger] = await Promise.all([
    getAuditLog(quote.id),
    getEventNotifications(quote.id),
  ]);
  const reminders = audit.filter(
    (a) =>
      REMINDER_EVENTS.has(a.event) ||
      a.event.startsWith("rem_") ||
      a.event.endsWith("_waiver_sent"),
  );

  return NextResponse.json({
    ok: true,
    quoteId: quote.id,
    shortId,
    event: quote.event_name,
    isWinback: quote.is_winback,
    incentiveIssuedAt: quote.incentive_issued_at,
    remindersSuppressed: quote.reminders_suppressed,
    reminderAudit: reminders,
    ledger,
    availableRules: RULES.map((r) => ({ key: r.key, label: r.label })),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { token, shortId, ruleKey } = body as {
    token?: string;
    shortId?: string;
    ruleKey?: string;
  };

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!shortId || !ruleKey) {
    return NextResponse.json({ error: "shortId and ruleKey required" }, { status: 400 });
  }

  const rule = RULES.find((r) => r.key === ruleKey);
  if (!rule) return NextResponse.json({ error: `Unknown ruleKey: ${ruleKey}` }, { status: 400 });

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });

  let waiverCache: string | null = null;
  let waiverDone = false;
  const ctx: RuleContext = {
    quote,
    getWaiverUrl: async () => {
      if (!waiverDone) {
        waiverCache = await buildWaiverUrl(quote);
        waiverDone = true;
      }
      return waiverCache;
    },
    firedEvents: new Set(),
    allowSms: true,
    dryRun: false,
  };

  try {
    const result = await rule.send(ctx);
    for (const ch of result.channelsAttempted) {
      const ok = ch === "email" ? result.emailOk : result.smsOk;
      await recordEventNotification({
        quoteId: quote.id,
        ruleKey: rule.key,
        dedupKey: rule.dedupKey ?? rule.key,
        channel: ch,
        status: ok === false ? "failed" : ok === null || ok === undefined ? "skipped" : "sent",
        provider: ch === "sms" ? "vox" : "sendgrid",
        providerMessageId: ch === "sms" ? result.providerMessageId : undefined,
        toAddress: ch === "email" ? quote.guest_email : quote.guest_phone || undefined,
        error: result.error,
        metadata: { manualFire: true },
      });
    }
    return NextResponse.json({ ok: true, ruleKey, shortId, result });
  } catch (err) {
    console.error(`[admin/reminders] manual fire ${ruleKey} failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fire rule" },
      { status: 500 },
    );
  }
}
