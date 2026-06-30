/**
 * READ-ONLY health snapshot of group-function contracts + bowling reservations.
 * Flags stuck/anomalous records so we can spot ongoing operational issues at a glance.
 * Usage (from apps/web): npx tsx scripts/health-snapshot.mts
 * Zero writes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { sql } = await import("@/lib/db");
const q = sql();

const money = (c: unknown) => (typeof c === "number" ? `$${(c / 100).toFixed(2)}` : "—");

console.log("=== DB time ===");
const [{ now }] = (await q`SELECT NOW() AS now`) as Array<{ now: string }>;
console.log(now, "\n");

// ---- 1. Status distribution -------------------------------------------------
console.log("=== Group-function quotes by status ===");
const byStatus = (await q`
  SELECT status, COUNT(*)::int AS n
  FROM group_function_quotes
  GROUP BY status
  ORDER BY n DESC
`) as Array<{ status: string; n: number }>;
for (const r of byStatus) console.log(`  ${String(r.status).padEnd(20)} ${r.n}`);
console.log("");

// ---- 2. The big flagged-issues query ---------------------------------------
const rows = (await q`
  SELECT id, event_number, event_name, contract_short_id, status,
         event_date, event_date <= NOW() AS started,
         total_cents, collected_cents, balance_cents, deposit_due_cents,
         deposit_paid_at, balance_paid_at, balance_link_sent_at,
         balance_charge_attempts, balance_last_error,
         square_dayof_order_id, dayof_paid_at, dayof_payment_error,
         square_settled_order_id, approval_required, approved_at,
         is_winback, reminders_suppressed,
         guest_first_name, guest_last_name, guest_email,
         created_at, updated_at
  FROM group_function_quotes
  ORDER BY event_date DESC NULLS LAST
`) as Array<Record<string, any>>;

const flagged: Array<{ q: Record<string, any>; flags: string[] }> = [];
const now2 = new Date(now).getTime();
const HOUR = 3600_000;

for (const r of rows) {
  const flags: string[] = [];
  const ev = r.event_date ? new Date(r.event_date).getTime() : null;
  const started = r.started === true;
  const terminal = ["completed", "cancelled", "denied", "expired"].includes(r.status);

  // Stuck before event: deposit_paid but event already passed and no day-of payment
  if (!terminal && started && !r.dayof_paid_at && !r.square_settled_order_id) {
    flags.push("EVENT_PASSED_UNSETTLED");
  }
  // Day-of order open but never paid, event started
  if (r.square_dayof_order_id && !r.dayof_paid_at && started && !terminal) {
    flags.push("DAYOF_ORDER_OPEN");
  }
  // Day-of payment error recorded
  if (r.dayof_payment_error) flags.push("DAYOF_PAYMENT_ERROR");
  // Balance charge errors / retries
  if (r.balance_last_error) flags.push("BALANCE_ERROR");
  if ((r.balance_charge_attempts ?? 0) >= 3) flags.push("BALANCE_RETRIES>=3");
  // Balance link sent but never paid, within/after event window
  if (r.status === "balance_link_sent" && ev && ev - now2 < 72 * HOUR && !r.balance_paid_at) {
    flags.push("BALANCE_LINK_UNPAID_NEAR_EVENT");
  }
  // resign_required lingering
  if (r.status === "resign_required") flags.push("RESIGN_REQUIRED");
  // Awaiting approval
  if (r.status === "pending_approval") flags.push("PENDING_APPROVAL");
  // Collected exceeds total (overcharge signal)
  if (typeof r.collected_cents === "number" && typeof r.total_cents === "number" &&
      r.collected_cents > r.total_cents + 1) {
    flags.push("OVERCOLLECTED");
  }
  // Deposit paid but stuck in contract_sent (status not advanced)
  if (r.status === "contract_sent" && r.deposit_paid_at) flags.push("STATUS_LAG_DEPOSIT");

  if (flags.length) flagged.push({ q: r, flags });
}

console.log(`=== Flagged GF contracts: ${flagged.length} of ${rows.length} ===\n`);
for (const { q: r, flags } of flagged) {
  console.log(
    `#${r.id} ${r.event_number ?? "—"} "${r.event_name ?? ""}" [${r.status}]`
  );
  console.log(
    `    event=${r.event_date ?? "—"} started=${r.started}` +
    `  total=${money(r.total_cents)} collected=${money(r.collected_cents)} balance=${money(r.balance_cents)}`
  );
  console.log(`    guest=${r.guest_first_name ?? ""} ${r.guest_last_name ?? ""} <${r.guest_email ?? ""}>`);
  if (r.balance_last_error) console.log(`    balance_err: ${r.balance_last_error}`);
  if (r.dayof_payment_error) console.log(`    dayof_err: ${r.dayof_payment_error}`);
  console.log(`    FLAGS: ${flags.join(", ")}`);
  console.log("");
}

// ---- 3. Bowling reservations quick health ----------------------------------
console.log("=== Bowling reservations by status ===");
try {
  const bw = (await q`
    SELECT status, COUNT(*)::int AS n
    FROM bowling_reservations
    GROUP BY status ORDER BY n DESC
  `) as Array<{ status: string; n: number }>;
  for (const r of bw) console.log(`  ${String(r.status).padEnd(20)} ${r.n}`);

  const bwStuck = (await q`
    SELECT id, center_code, qamf_reservation_id, bmi_bill_id,
           square_dayof_order_id, total_cents, deposit_cents, status,
           booked_at, guest_name, guest_email
    FROM bowling_reservations
    WHERE status NOT IN ('confirmed','completed','cancelled')
       OR (square_dayof_order_id IS NULL AND status = 'confirmed')
    ORDER BY booked_at DESC NULLS LAST
    LIMIT 50
  `) as Array<Record<string, any>>;
  console.log(`\n  Bowling rows needing a look: ${bwStuck.length}`);
  for (const r of bwStuck) {
    console.log(
      `    #${r.id} ${r.center_code} [${r.status}] dayof=${r.square_dayof_order_id ?? "NULL"} ` +
      `total=${money(r.total_cents)} ${r.guest_name ?? ""} <${r.guest_email ?? ""}> booked=${r.booked_at}`
    );
  }
} catch (e) {
  console.log("  (bowling_reservations not available:", (e as Error).message, ")");
}

process.exit(0);
