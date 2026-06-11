/**
 * Send the T-24h "final balance ask" emails to an INTERNAL inbox for copy
 * review, using the real notify builders + a real quote's data. The quote's
 * guest contact is overridden, so no customer is contacted; the dispatcher's
 * dedup ledger is untouched (direct builder call), so the real send to the
 * guest still happens on schedule.
 *
 * Usage (from apps/web):  npx tsx scripts/preview-t24-email.ts [--to you@x.com]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const TO = process.argv.includes("--to")
  ? process.argv[process.argv.indexOf("--to") + 1]
  : "eric@headpinz.com";

const { sql } = await import("@/lib/db");
const { notifyBalanceDueFinal, notifyWinbackBalanceDueFinal } = await import(
  "@/lib/group-function-notify"
);

// Mirrors the rules engine's private payUrl(): stored link first, portal fallback.
function payUrl(quote: Record<string, unknown>, src: string): string {
  return (
    (quote.balance_payment_link_url as string) ||
    `${quote.base_url || "https://fasttraxent.com"}/contract/${quote.contract_short_id}?src=${src}`
  );
}

const q = sql();

const [wb] = (await q`
  SELECT * FROM group_function_quotes
  WHERE status = 'contract_sent' AND is_winback = TRUE
    AND saved_card_id IS NULL AND deposit_paid_at IS NULL
    AND total_cents - deposit_due_cents > 0
    AND event_date > NOW() AND event_date <= NOW() + INTERVAL '24 hours'
  ORDER BY event_date ASC LIMIT 1
`) as Array<Record<string, unknown>>;

const [normal] = (await q`
  SELECT * FROM group_function_quotes
  WHERE status IN ('deposit_paid','balance_link_sent') AND is_winback = FALSE
    AND saved_card_id IS NULL AND total_cents - collected_cents > 0
    AND event_date > NOW()
  ORDER BY event_date ASC LIMIT 1
`) as Array<Record<string, unknown>>;

async function preview(label: string, quote: Record<string, unknown> | undefined) {
  if (!quote) {
    console.log(`[${label}] no matching quote found — skipped`);
    return;
  }
  const test = { ...quote, guest_email: TO, guest_phone: null } as never;
  console.log(
    `[${label}] event #${quote.event_number} "${quote.event_name}" on ${quote.event_date_display} ` +
      `(quote=${quote.id}) -> sending preview to ${TO}`,
  );
  const res =
    label === "winback"
      ? await notifyWinbackBalanceDueFinal(test)
      : await notifyBalanceDueFinal(test, payUrl(test, "t24_preview"));
  console.log(`[${label}] emailOk=${res.emailOk}`);
}

await preview("winback", wb);
await preview("normal", normal);
process.exit(0);
