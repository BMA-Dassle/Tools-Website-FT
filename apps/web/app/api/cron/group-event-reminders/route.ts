import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { recordEventNotification, type GroupFunctionQuote } from "@/lib/group-function-db";
import { verifyCron } from "@/lib/cron-auth";
import {
  RULES,
  buildWaiverUrl,
  isEngineKilled,
  isPandoraPlaceholder,
  isRuleEnabled,
  withinQuietHours,
  type ReminderRule,
  type RuleContext,
  type RuleSendResult,
} from "@/lib/group-event-rules";

/**
 * Group-event reminder dispatcher.
 *
 * Every ~15 min, evaluates every rule in lib/group-event-rules.ts: selects
 * candidate quotes (status + event_date window), dedups via contract_audit_log
 * (the existing NOT EXISTS gate), sends, then records a ledger row + the audit
 * dedup row (audit LAST — a crash mid-write re-sends next run, preferable to a
 * silent drop for payment/waiver reminders).
 *
 * Generalizes group-7day-waiver / group-96hr-reminder. Runs ALONGSIDE them
 * during cutover: waiver rules reuse the legacy dedup keys so only one of
 * {legacy cron, this dispatcher} ever sends a given reminder.
 *
 * Query params:
 *   ?dryRun=1        scan + report candidate counts, send nothing
 *   ?rule=<key>      evaluate only this rule
 */

function truthy(v: string | null): boolean {
  return v === "1" || v === "true";
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }
  if (isEngineKilled()) {
    return NextResponse.json({ ok: true, skipped: "GF_REMINDERS_KILL" });
  }

  const dryRun = truthy(req.nextUrl.searchParams.get("dryRun"));
  const onlyRule = req.nextUrl.searchParams.get("rule");
  const MAX = Number(process.env.GF_REMINDER_MAX_PER_RUN || 40);

  let totalSent = 0;
  const report: Record<
    string,
    { candidates: number; sent: number; skipped: number; errors: number }
  > = {};

  for (const rule of RULES) {
    if (onlyRule && rule.key !== onlyRule) continue;
    if (!isRuleEnabled(rule)) continue;
    if (totalSent >= MAX) break;

    const dedupKey = rule.dedupKey ?? rule.key;
    const r = { candidates: 0, sent: 0, skipped: 0, errors: 0 };
    report[rule.key] = r;

    let candidates: GroupFunctionQuote[];
    try {
      candidates = await selectCandidates(rule, dedupKey, MAX - totalSent);
    } catch (err) {
      console.error(`[group-event-reminders] candidate query failed for ${rule.key}:`, err);
      r.errors++;
      continue;
    }
    r.candidates = candidates.length;

    for (const quote of candidates) {
      if (totalSent >= MAX) break;

      if (isPandoraPlaceholder(quote)) {
        r.skipped++;
        continue;
      }

      const smsOnly = rule.channels.length === 1 && rule.channels[0] === "sms";
      const allowSms = rule.channels.includes("sms") ? !withinQuietHours() : true;
      if (smsOnly && !allowSms) {
        // Defer SMS-only rule until after quiet hours — do NOT record dedup.
        r.skipped++;
        continue;
      }

      const firedEvents = await loadFiredEvents(quote.id);

      // Recurring (drip) rules dedup per-occurrence; one-shot rules use dedupKey.
      let effectiveDedup = dedupKey;
      if (rule.recurring) {
        const occ = rule.occurrenceFor?.(quote) ?? null;
        if (occ === null) {
          r.skipped++;
          continue;
        }
        effectiveDedup = `${dedupKey}:${occ}`;
        if (firedEvents.has(effectiveDedup)) {
          r.skipped++;
          continue;
        }
      }

      const ctx: RuleContext = {
        quote,
        getWaiverUrl: memoWaiverUrl(quote),
        firedEvents,
        allowSms,
        dryRun,
      };

      if (rule.eligible && !(await rule.eligible(ctx))) {
        r.skipped++;
        continue;
      }

      if (dryRun) {
        r.sent++; // "would send"
        continue;
      }

      try {
        const result = await rule.send(ctx);
        await recordResult(quote, rule, effectiveDedup, result);
        if (result.channelsAttempted.length > 0) {
          r.sent++;
          totalSent++;
        } else {
          r.errors++; // e.g. no waiver URL — recorded, but NOT deduped (will retry)
        }
      } catch (err) {
        r.errors++;
        console.error(
          `[group-event-reminders] ${rule.key} send failed for quote=${quote.id}:`,
          err,
        );
        await recordError(quote, rule, effectiveDedup, err);
      }
    }
  }

  console.log(
    `[group-event-reminders] dryRun=${dryRun} totalSent=${totalSent} ${JSON.stringify(report)}`,
  );
  return NextResponse.json({ ok: true, dryRun, totalSent, rules: report });
}

// ── candidate selection ───────────────────────────────────────────────

/**
 * Anti-spam backstop: a rule whose send() THROWS never writes the dedup gate
 * (recordError) and would otherwise retry every cron tick for as long as the
 * quote stays in its window — a deliver-then-throw bug could re-email a guest
 * dozens of times. After this many failed attempts (ledger rows with
 * status='failed') the rule is permanently silenced for that quote.
 * Reported-failure sends (e.g. SendGrid reject) already write the dedup gate
 * and never retry; intentional no-channel retries record status='skipped' and
 * stay unlimited — they send nothing.
 */
const MAX_FAILED_ATTEMPTS = 3;

async function selectCandidates(
  rule: ReminderRule,
  dedupKey: string,
  limit: number,
): Promise<GroupFunctionQuote[]> {
  const q = sql();
  const { statuses } = rule;
  const minH = rule.window.minHours;
  const maxH = rule.window.maxHours;
  const notExWb = !rule.excludeWinback; // true => no winback constraint
  const notWbOnly = !rule.winbackOnly;

  if (rule.recurring) {
    // Per-occurrence dedup happens in JS; omit the NOT EXISTS gate here.
    const rows = await q`
      SELECT * FROM group_function_quotes
      WHERE status = ANY(${statuses})
        AND reminders_suppressed = FALSE
        AND event_date > NOW() + make_interval(hours => ${minH})
        AND event_date <= NOW() + make_interval(hours => ${maxH})
        AND (${notExWb} OR is_winback = FALSE)
        AND (${notWbOnly} OR is_winback = TRUE)
        AND (
          SELECT COUNT(*) FROM group_event_notifications gen
          WHERE gen.quote_id = group_function_quotes.id
            AND gen.rule_key = ${rule.key}
            AND gen.status = 'failed'
        ) < ${MAX_FAILED_ATTEMPTS}
      ORDER BY event_date ASC
      LIMIT ${limit}
    `;
    return rows as GroupFunctionQuote[];
  }

  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE status = ANY(${statuses})
      AND reminders_suppressed = FALSE
      AND event_date > NOW() + make_interval(hours => ${minH})
      AND event_date <= NOW() + make_interval(hours => ${maxH})
      AND (${notExWb} OR is_winback = FALSE)
      AND (${notWbOnly} OR is_winback = TRUE)
      AND NOT EXISTS (
        SELECT 1 FROM contract_audit_log cal
        WHERE cal.quote_id = group_function_quotes.id AND cal.event = ${dedupKey}
      )
      AND (
        SELECT COUNT(*) FROM group_event_notifications gen
        WHERE gen.quote_id = group_function_quotes.id
          AND gen.rule_key = ${rule.key}
          AND gen.status = 'failed'
      ) < ${MAX_FAILED_ATTEMPTS}
    ORDER BY event_date ASC
    LIMIT ${limit}
  `;
  return rows as GroupFunctionQuote[];
}

// ── ledger + dedup writes ─────────────────────────────────────────────

async function loadFiredEvents(quoteId: number): Promise<Set<string>> {
  const q = sql();
  const rows =
    (await q`SELECT event FROM contract_audit_log WHERE quote_id = ${quoteId}`) as Array<{
      event: string;
    }>;
  return new Set(rows.map((r) => r.event));
}

function memoWaiverUrl(quote: GroupFunctionQuote): () => Promise<string | null> {
  let cached: string | null = null;
  let done = false;
  return async () => {
    if (!done) {
      cached = await buildWaiverUrl(quote);
      done = true;
    }
    return cached;
  };
}

async function recordResult(
  quote: GroupFunctionQuote,
  rule: ReminderRule,
  dedupKey: string,
  result: RuleSendResult,
): Promise<void> {
  for (const ch of result.channelsAttempted) {
    const ok = ch === "email" ? result.emailOk : result.smsOk;
    await recordEventNotification({
      quoteId: quote.id,
      ruleKey: rule.key,
      dedupKey,
      channel: ch,
      status: ok === false ? "failed" : ok === null || ok === undefined ? "skipped" : "sent",
      provider: ch === "sms" ? "vox" : "sendgrid",
      providerMessageId: ch === "sms" ? result.providerMessageId : undefined,
      toAddress: ch === "email" ? quote.guest_email : quote.guest_phone || undefined,
      error: result.error,
    });
  }

  // No channel attempted (e.g. missing waiver URL): record the miss but do NOT
  // write the dedup gate, so the rule retries on a later run.
  if (result.channelsAttempted.length === 0) {
    await recordEventNotification({
      quoteId: quote.id,
      ruleKey: rule.key,
      dedupKey,
      channel: "none",
      status: "skipped",
      error: result.error || "no channel attempted",
    });
    return;
  }

  const q = sql();
  await q`
    INSERT INTO contract_audit_log (quote_id, event, metadata)
    VALUES (${quote.id}, ${dedupKey}, ${JSON.stringify({
      rule: rule.key,
      channels: result.channelsAttempted,
      providerMessageId: result.providerMessageId ?? null,
    })})
  `;
}

async function recordError(
  quote: GroupFunctionQuote,
  rule: ReminderRule,
  dedupKey: string,
  err: unknown,
): Promise<void> {
  // Record the failure but NOT the dedup gate, so the rule retries.
  await recordEventNotification({
    quoteId: quote.id,
    ruleKey: rule.key,
    dedupKey,
    channel: "none",
    status: "failed",
    error: err instanceof Error ? err.message : String(err),
  }).catch(() => {});
}
