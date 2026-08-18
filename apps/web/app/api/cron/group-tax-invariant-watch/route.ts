import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { verifyCron } from "@/lib/cron-auth";
import { sendEmail } from "@/lib/sendgrid";
import { sql, isDbConfigured } from "@/lib/db";

/**
 * Group-function TAX INVARIANT WATCH — the standing check that tax is both BILLED and
 * RECORDED, because between 2026-05 and 2026-08 neither was true and nothing noticed.
 *
 * What went wrong, and why no existing report could have caught it:
 *   1. NOT BILLED. An old formula computed line tax as `(tax * total) / price`, which
 *      reduces to `rate × qty` — so a $487 event billed $0.33 of tax instead of $31.69.
 *      Fixed in group-function-pricing.ts, but rows already written stayed wrong, and
 *      `group-quote-tax-backfill` (which repairs them) was never added to vercel.json, so
 *      it had never run. $2,416.20 of tax across 23 events was never charged to a guest.
 *   2. NOT RECORDED. The day-of Square order wrote `tax_cents` into `service_charges`
 *      instead of `taxes`, so `total_tax_money` read $0.00 on 211 orders — $22,616.55 of
 *      tax collected but invisible to every Square tax report.
 *
 * The two hid each other: Square's tax report showed $0 for group events either way, so a
 * whole event billing no tax looked exactly like a normal one. Hence a check that reads the
 * CONTRACT and the ORDER independently and compares each against the line items.
 *
 * INVARIANT A — billed: for a non-exempt contract, `tax_cents` must equal the sum of
 *   `line.tax × line.total` over its own line items. A shortfall is money never charged.
 * INVARIANT B — recorded: an OPEN day-of Square order must report `total_tax_money` equal
 *   to the contract's `tax_cents`. A mismatch means the dollars are in the wrong slot.
 *
 *   GET /api/cron/group-tax-invariant-watch
 *       ?force=1   — email even if the dedupe key says we alerted recently
 *       ?all=1     — include PAST events in the response body (never alerted on)
 *
 * Only FUTURE-dated events raise an email: those are the ones where money can still be
 * collected or an order corrected. Past breaches are reported in the JSON for the record
 * but must not page anyone nightly forever.
 */

const RECIPIENTS = (process.env.GF_TAX_ALERT_EMAILS || "eric@headpinz.com")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
/** BMI cents rounding — a 2c disagreement is arithmetic, not a missing tax. */
const TOLERANCE_CENTS = 2;
/** Cap Square reads so the cron stays cheap; future events are the actionable set. */
const MAX_ORDER_READS = 250;
/**
 * Weekly, not daily. The fingerprint below is the exact breach SET, so anything NEW alerts
 * on the next run regardless — this TTL only governs how often an UNCHANGED set nags. Daily
 * mail about the same known-stuck items is how an alert becomes wallpaper.
 */
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

interface Breach {
  invariant: "not_billed" | "not_recorded";
  eventNumber: string;
  eventDate: string;
  centerCode: string;
  status: string;
  future: boolean;
  detail: string;
  shortfallCents: number;
}

async function squareOrderTax(
  orderId: string,
): Promise<{ state: string; taxCents: number } | null> {
  try {
    const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: {
        Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
        "Square-Version": "2024-12-18",
      },
    });
    if (!res.ok) return null;
    const o = (await res.json()).order;
    if (!o) return null;
    return { state: o.state ?? "?", taxCents: o.total_tax_money?.amount ?? 0 };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const force = req.nextUrl.searchParams.get("force") === "1";
  const includePast = req.nextUrl.searchParams.get("all") === "1";
  const q = sql();

  const rows = (await q`
    SELECT event_number, event_date, center_code, status, is_tax_exempt,
           tax_cents, total_cents, line_items, square_dayof_order_id
    FROM group_function_quotes
    WHERE line_items IS NOT NULL
    ORDER BY event_date DESC
  `) as Array<{
    event_number: string | null;
    event_date: string;
    center_code: string;
    status: string;
    is_tax_exempt: boolean;
    tax_cents: number;
    total_cents: number;
    line_items: unknown;
    square_dayof_order_id: string | null;
  }>;

  const now = Date.now();
  const breaches: Breach[] = [];
  let orderReads = 0;
  let scanned = 0;

  for (const r of rows) {
    const items = (Array.isArray(r.line_items) ? r.line_items : []) as Array<{
      tax?: number;
      total?: number;
    }>;
    const priced = items.filter((i) => i && i.total);
    if (!priced.length) continue;
    scanned++;

    const future = new Date(r.event_date).getTime() > now;
    const base = {
      eventNumber: r.event_number ?? "?",
      eventDate: new Date(r.event_date).toISOString().slice(0, 10),
      centerCode: r.center_code,
      status: r.status,
      future,
    };

    // ── INVARIANT A: does the contract bill the tax its lines imply? ──
    if (!r.is_tax_exempt) {
      const implied = Math.round(
        priced.reduce((s, i) => s + (i.tax || 0) * (i.total || 0), 0) * 100,
      );
      const shortfall = implied - r.tax_cents;
      if (shortfall > TOLERANCE_CENTS) {
        breaches.push({
          ...base,
          invariant: "not_billed",
          shortfallCents: shortfall,
          detail: `billed ${money(r.tax_cents)}, line items imply ${money(implied)} — ${money(shortfall)} never charged`,
        });
      }
    }

    // ── INVARIANT B: does the live day-of order RECORD that tax? ──
    // Future events only: a settled past order is history, and reading every order every
    // night would be hundreds of Square calls for nothing actionable.
    if (future && r.square_dayof_order_id && orderReads < MAX_ORDER_READS) {
      orderReads++;
      const ord = await squareOrderTax(r.square_dayof_order_id);
      if (ord && ord.state === "OPEN" && Math.abs(ord.taxCents - r.tax_cents) > TOLERANCE_CENTS) {
        breaches.push({
          ...base,
          invariant: "not_recorded",
          shortfallCents: Math.abs(r.tax_cents - ord.taxCents),
          detail:
            `day-of order ${r.square_dayof_order_id} reports ${money(ord.taxCents)} of tax, ` +
            `contract says ${money(r.tax_cents)}` +
            (ord.taxCents === 0 ? " — tax is in the WRONG SLOT and invisible to reporting" : ""),
        });
      }
    }
  }

  const actionable = breaches.filter((b) => b.future);
  const past = breaches.filter((b) => !b.future);
  const notBilled = actionable.filter((b) => b.invariant === "not_billed");
  const notRecorded = actionable.filter((b) => b.invariant === "not_recorded");
  const atRisk = notBilled.reduce((s, b) => s + b.shortfallCents, 0);

  let alerted = false;
  let deduped = false;
  if (actionable.length > 0) {
    // Dedupe on WHAT is wrong, not just that something is — a new breach alerts at once
    // even if a known one is still open.
    const fingerprint = actionable
      .map((b) => `${b.invariant}:${b.eventNumber}:${b.shortfallCents}`)
      .sort()
      .join("|");
    const key = `gf:tax-invariant:sent:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
    // Same Redis SET NX idiom as pov-pool-alert. A Redis outage must not silence the
    // alert, so a failed dedupe read errs toward sending.
    let first = true;
    if (!force && REDIS_URL) {
      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
      try {
        await redis.connect();
        first =
          (await redis.set(key, new Date().toISOString(), "EX", DEDUPE_TTL_SECONDS, "NX")) === "OK";
      } catch {
        first = true;
      } finally {
        redis.disconnect();
      }
    }

    if (!first) {
      deduped = true;
    } else {
      const line = (b: Breach) =>
        `<li><strong>${b.eventNumber}</strong> ${b.eventDate} ${b.centerCode} (${b.status}) — ${b.detail}</li>`;
      const html = `
<h2>Group-function tax invariant breach</h2>
${
  notBilled.length
    ? `<h3>Tax never charged to the guest — ${money(atRisk)} across ${notBilled.length} upcoming event(s)</h3>
<p>These contracts bill less tax than their own line items imply. The event has not happened yet, so it is still collectable.</p>
<ul>${notBilled.map(line).join("")}</ul>`
    : ""
}
${
  notRecorded.length
    ? `<h3>Tax charged but recorded in the wrong slot — ${notRecorded.length} upcoming order(s)</h3>
<p>The guest is being charged correctly, but the Square order does not report the tax, so it will not appear in a tax report. Re-run
<code>scripts/gf-reshape-future-dayof-orders.mts --execute</code>.</p>
<ul>${notRecorded.map(line).join("")}</ul>`
    : ""
}
<hr>
<p style="color:#666">Scanned ${scanned} contracts, read ${orderReads} Square orders.
${past.length} past breach(es) not listed — <code>?all=1</code> for the full set.
Why this check exists: lib/gf-square-tax.ts.</p>`;
      const subject =
        notBilled.length > 0
          ? `[GF TAX] ${money(atRisk)} of tax not charged on ${notBilled.length} upcoming event(s)`
          : `[GF TAX] ${notRecorded.length} upcoming order(s) not recording tax`;
      for (const to of RECIPIENTS) await sendEmail({ to, subject, html }).catch(() => {});
      alerted = true;
    }
  }

  console.log(
    `[group-tax-invariant-watch] scanned=${scanned} actionable=${actionable.length} ` +
      `notBilled=${notBilled.length} atRisk=${atRisk} notRecorded=${notRecorded.length} ` +
      `past=${past.length} alerted=${alerted} deduped=${deduped}`,
  );

  return NextResponse.json({
    ok: true,
    scanned,
    orderReads,
    alerted,
    deduped,
    atRiskCents: atRisk,
    actionable,
    pastCount: past.length,
    ...(includePast ? { past } : {}),
  });
}
