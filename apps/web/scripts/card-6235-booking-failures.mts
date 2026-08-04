/**
 * READ-ONLY forensics: guest on card ****6235 says they tried to book online
 * today (2026-07-28) and kept failing.
 *
 * Three independent reads, no writes:
 *   1. Square — every payment on EVERY merchant location for 7/27–now,
 *      surfacing (a) all attempts on card ****6235 in ANY status
 *      (FAILED/CANCELED included — that's the whole point) and
 *      (b) every non-COMPLETED payment today, for context on shared failures.
 *   2. Neon reserve_attempts — the new durable booking-attempt log
 *      (added on main 7/28). Every attempt today + all failures.
 *   3. Neon bowling_reservations — anything that actually landed today.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-booking-failures.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const LAST4 = "6235";
const BEGIN = "2026-07-27T00:00:00Z";

const d = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;
/** Center-local (America/New_York) timestamp — how staff reads a clock. */
const et = (s: unknown) => {
  if (!s) return "";
  const dt = new Date(String(s));
  if (Number.isNaN(dt.getTime())) return String(s);
  return dt
    .toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false })
    .replace(",", "");
};

async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { headers: H, ...init });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j: j as Record<string, any> };
}

// ─────────────────────────── 1. SQUARE ───────────────────────────
const { j: lj } = await sq(`/locations`);
const locs = (lj.locations ?? []) as Array<Record<string, any>>;
console.log(`══════ SQUARE LOCATIONS (${locs.length}) ══════`);
for (const l of locs) console.log(`  ${l.id}  ${l.name}  ${l.status}`);

const cardHits: Array<Record<string, any>> = [];
const notCompleted: Array<Record<string, any>> = [];
console.log(`\n══════ SWEEP payments ${BEGIN} → now ══════`);
for (const loc of locs) {
  let cursor: string | undefined;
  let count = 0;
  do {
    const qs = new URLSearchParams({
      location_id: loc.id,
      begin_time: BEGIN,
      sort_order: "ASC",
      limit: "100",
    });
    if (cursor) qs.set("cursor", cursor);
    const { ok, j } = await sq(`/payments?${qs}`);
    if (!ok) {
      console.log(`  ! ${loc.name}: ${JSON.stringify(j).slice(0, 200)}`);
      break;
    }
    for (const p of (j.payments ?? []) as Array<Record<string, any>>) {
      count++;
      const l4 = p.card_details?.card?.last_4 ?? "";
      if (l4 === LAST4) cardHits.push({ ...p, _loc: loc.name });
      else if (p.status !== "COMPLETED") notCompleted.push({ ...p, _loc: loc.name });
    }
    cursor = j.cursor;
  } while (cursor);
  console.log(`  swept ${loc.name}: ${count}`);
}

function dumpPayment(p: Record<string, any>) {
  const c = p.card_details?.card ?? {};
  console.log(
    `\n  ${et(p.created_at)} ET  ${p.id}` +
      `\n    ${d(money(p.amount_money))}  status=${p.status}  src=${p.source_type}` +
      `  ${c.card_brand ?? ""}****${c.last_4 ?? ""} exp=${c.exp_month ?? ""}/${c.exp_year ?? ""}` +
      `\n    cardholder="${c.cardholder_name ?? "-"}" fp=${c.fingerprint ?? "-"} bin=${c.bin ?? "-"} type=${c.card_type ?? "-"} prepaid=${c.prepaid_type ?? "-"}` +
      `\n    loc=${p._loc} (${p.location_id})  order=${p.order_id ?? "-"}  customer=${p.customer_id ?? "-"}` +
      `\n    cvv=${p.card_details?.cvv_status ?? "-"} avs=${p.card_details?.avs_status ?? "-"} auth=${p.card_details?.auth_result_code ?? "-"} entry=${p.card_details?.entry_method ?? "-"}` +
      `\n    app=${p.application_details?.square_product ?? "-"} note="${p.note ?? ""}" ref="${p.reference_id ?? "-"}"` +
      (p.card_details?.errors?.length
        ? `\n    CARD ERRORS: ${JSON.stringify(p.card_details.errors)}`
        : "") +
      (p.processing_fee?.length ? "" : `\n    (no processing fee — never settled)`),
  );
  if (p.risk_evaluation) console.log(`    risk=${JSON.stringify(p.risk_evaluation)}`);
}

console.log(`\n\n══════ ALL PAYMENT ATTEMPTS ON ****${LAST4} — ${cardHits.length} ══════`);
cardHits.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
for (const p of cardHits) dumpPayment(p);
if (!cardHits.length) console.log(`  none — card ****${LAST4} never reached Square on any location`);

console.log(`\n\n══════ OTHER NON-COMPLETED PAYMENTS (context) — ${notCompleted.length} ══════`);
notCompleted.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
for (const p of notCompleted) {
  const c = p.card_details?.card ?? {};
  console.log(
    `  ${et(p.created_at)} ET ${p.id} ${d(money(p.amount_money))} ${p.status} ` +
      `${c.card_brand ?? ""}****${c.last_4 ?? ""} src=${p.source_type} loc=${p._loc} ` +
      `err=${JSON.stringify(p.card_details?.errors ?? [])}`,
  );
}

// ─────────────────────── 2. NEON reserve_attempts ───────────────────────
const sql = neon(process.env.DATABASE_URL!);

const exists = await sql`
  SELECT to_regclass('public.reserve_attempts') IS NOT NULL AS present`;
console.log(`\n\n══════ NEON reserve_attempts (present=${exists[0]?.present}) ══════`);

if (exists[0]?.present) {
  const attempts = await sql`
    SELECT * FROM reserve_attempts
    WHERE created_at > NOW() - INTERVAL '48 hours'
    ORDER BY created_at ASC`;
  console.log(`  ${attempts.length} attempts in the last 48h\n`);
  for (const a of attempts as any[]) {
    console.log(
      `  #${a.id} ${et(a.created_at)} ET  state=${a.state} surface=${a.surface} center=${a.center ?? "-"}` +
        `\n     charge=${d(a.charge_cents)} src=${a.payment_source} bill=${a.bill_id ?? "-"} loc=${a.location_id ?? "-"}` +
        `\n     base_key=${a.base_key}` +
        `\n     deposit_order=${a.deposit_order_id ?? "-"} deposit_payment=${a.deposit_payment_id ?? "-"}` +
        `\n     neon_ids=${JSON.stringify(a.neon_ids)} qamf=${JSON.stringify(a.qamf_reservation_ids)} bmi=${a.bmi_reservation_number ?? "-"}` +
        `\n     dropped=${JSON.stringify(a.dropped_legs)} failed_step=${a.failed_step ?? "-"}` +
        (a.error ? `\n     ERROR: ${a.error}` : "") +
        `\n     cart=${JSON.stringify(a.cart)}`,
    );
  }
}

// ─────────────────── 3. NEON — what actually landed today ───────────────────
const cols = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='bowling_reservations'
  ORDER BY ordinal_position`;
console.log(
  `\n\n══════ bowling_reservations columns ══════\n  ${(cols as any[]).map((c) => c.column_name).join(", ")}`,
);

process.exit(0);
