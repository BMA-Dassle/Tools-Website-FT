import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  resolveCenter,
  selectTemplate,
  isTaxExempt,
  type HermesQueueItem,
} from "@/lib/hermes-client";
import { scanLegacyDepositCohort, LEGACY_DEPOSIT_STATE_IDS } from "@/lib/bmi-scan";
import {
  insertGfQuote,
  getGfQuoteByReservationId,
  getGfQuoteByShortId,
  markGfQuoteIngestedWinback,
  appendAuditLog,
} from "@/lib/group-function-db";
import { searchDocumentsByReservation } from "@/lib/pandadoc";
import { notifyWinbackOffer } from "@/lib/group-function-notify";
import { findSettlementCheck } from "@/lib/square-settled-check";
import { withinQuietHours } from "@/lib/group-event-rules";

/**
 * Admin: ingest legacy deposit events into the new flow as $20 win-back offers.
 *
 * Scans BMI for confirmed, deposit-paid events (LEGACY_DEPOSIT_STATE_IDS),
 * filters out post-pay / no-deposit / past / already-ingested, then for each
 * survivor inserts a `contract_sent` quote with the deposit applied
 * (prior_payments) + is_winback, and sends the "add your card on file & get
 * $20" offer pointing at the /contract portal. NOTHING is charged or changed in
 * BMI at ingestion — the guest adds a card via the portal (which issues the $20
 * + sets up the day-of), then the standard 72h cron charges the card.
 *
 * POST body:
 *   { token, dryRun=true, reservationIds?, stateIds?, maxIngest=25, incentiveCents=2000 }
 *
 * dryRun (default TRUE) reports what WOULD ingest without any writes.
 */

function formatEventDate(dateRaw: string): string {
  const hasTz = dateRaw.includes("Z") || dateRaw.includes("+") || /\d-\d{2}:\d{2}$/.test(dateRaw);
  const d = new Date(hasTz ? dateRaw : `${dateRaw}-04:00`);
  return (
    d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    }) +
    " " +
    d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
  );
}

interface Money {
  totalCents: number;
  taxCents: number;
  depositCents: number;
  balanceCents: number;
  taxExempt: boolean;
  isPostPay: boolean;
}

function money(item: HermesQueueItem): Money {
  const taxExempt = isTaxExempt(item.products);
  const taxCents = taxExempt ? 0 : Math.round(item.tax * 100);
  const totalCents = Math.round(item.totalBill * 100) + taxCents;
  const payments = (item.payments ?? []) as Array<{ amount: number }>;
  const depositCents = Math.round(payments.reduce((s, p) => s + (p.amount || 0), 0) * 100);
  return {
    totalCents,
    taxCents,
    depositCents,
    balanceCents: Math.max(0, totalCents - depositCents),
    taxExempt,
    isPostPay: selectTemplate(item) === "postpay",
  };
}

async function mintShortId(): Promise<string | null> {
  for (let i = 0; i < 6; i++) {
    const id = randomBytes(4).toString("hex");
    if (!(await getGfQuoteByShortId(id))) return id;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const {
    token,
    dryRun = true,
    reservationIds,
    stateIds,
    maxIngest = 25,
    incentiveCents = 2000,
    maxDaysOut = 10,
  } = body as {
    token?: string;
    dryRun?: boolean;
    reservationIds?: string[];
    stateIds?: string[];
    maxIngest?: number;
    incentiveCents?: number;
    maxDaysOut?: number;
  };

  const expected = process.env.ADMIN_GF_INGEST_TOKEN;
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let cohort: HermesQueueItem[];
  try {
    cohort = await scanLegacyDepositCohort(stateIds ?? LEGACY_DEPOSIT_STATE_IDS);
  } catch (err) {
    console.error("[ingest-legacy] BMI scan failed:", err);
    return NextResponse.json({ ok: false, error: "BMI scan failed" }, { status: 502 });
  }

  const wanted = reservationIds?.length ? new Set(reservationIds.map(String)) : null;
  const now = Date.now();
  const results: Array<Record<string, unknown>> = [];
  let ingested = 0;

  for (const item of cohort) {
    const resId = item.reservationId;
    if (wanted && !wanted.has(resId)) continue;
    if (ingested >= maxIngest) {
      results.push({ reservationId: resId, action: "skipped", reason: "maxIngest reached" });
      continue;
    }

    const m = money(item);
    const eventTime = new Date(
      item.event.dateRaw.match(/Z|\+|\d-\d{2}:\d{2}$/)
        ? item.event.dateRaw
        : `${item.event.dateRaw}-04:00`,
    ).getTime();

    // Server-side exclusion re-checks (never trust the client list).
    if (m.isPostPay) {
      results.push({
        reservationId: resId,
        action: "excluded",
        reason: "post-pay",
        name: item.event.name,
      });
      continue;
    }
    if (m.depositCents <= 0) {
      results.push({
        reservationId: resId,
        action: "excluded",
        reason: "no deposit",
        name: item.event.name,
      });
      continue;
    }
    if (m.balanceCents <= 100) {
      results.push({
        reservationId: resId,
        action: "excluded",
        reason: "no balance due",
        name: item.event.name,
      });
      continue;
    }
    if (!eventTime || eventTime <= now) {
      results.push({
        reservationId: resId,
        action: "excluded",
        reason: "past event",
        name: item.event.name,
      });
      continue;
    }
    // Only offer events that are close (~a week out) — never blast a "$20, pay now"
    // offer months in advance. Mirrors the payment-due nudge cadence. Far-future
    // events get picked up on a later run as they enter the window.
    if (eventTime > now + maxDaysOut * 86_400_000) {
      results.push({
        reservationId: resId,
        action: "excluded",
        reason: `too far out (>${maxDaysOut}d)`,
        name: item.event.name,
        eventDate: formatEventDate(item.event.dateRaw),
      });
      continue;
    }
    const center = resolveCenter(item.center);
    if (!center) {
      results.push({
        reservationId: resId,
        action: "excluded",
        reason: "unknown center",
        name: item.event.name,
      });
      continue;
    }
    if (await getGfQuoteByReservationId(resId)) {
      results.push({
        reservationId: resId,
        action: "skipped",
        reason: "already on new flow",
        name: item.event.name,
      });
      continue;
    }

    // Don't win-back an event already settled at the POS (a COMPLETED "BMI <event#>"
    // check). BMI's bill can still show a balance owed even though the venue collected
    // it in Square — offering "$20 to pay your balance" to someone who already paid is
    // wrong. Fail-open on a Square error (the balance>$1 + past-event filters above
    // already guard the common cases).
    if (item.event.number) {
      try {
        const settled = await findSettlementCheck({
          locationId: center.squareLocationId,
          eventNumber: item.event.number,
          eventMs: eventTime,
        });
        if (settled) {
          results.push({
            reservationId: resId,
            action: "excluded",
            reason: "already settled at POS",
            name: item.event.name,
            settledCheck: settled.ticketName,
          });
          continue;
        }
      } catch (err) {
        console.warn(`[ingest-legacy] settled-check lookup failed for ${resId}:`, err);
      }
    }

    if (dryRun) {
      results.push({
        reservationId: resId,
        action: "would_ingest",
        name: item.event.name,
        center: center.centerCode,
        eventDate: formatEventDate(item.event.dateRaw),
        totalCents: m.totalCents,
        depositCents: m.depositCents,
        balanceCents: m.balanceCents,
        guest: `${item.customer.first} ${item.customer.last}`.trim(),
        email: item.customer.email,
      });
      continue;
    }

    // ── Real ingestion ────────────────────────────────────────────────
    try {
      const shortId = await mintShortId();
      if (!shortId) throw new Error("could not mint unique contract_short_id");

      // Best-effort: link the original signed PandaDoc doc (reference only).
      let pandadocDocId: string | null = null;
      try {
        const docs = await searchDocumentsByReservation(center.centerCode, resId);
        pandadocDocId =
          docs.find((d) => /completed|paid/i.test(d.status))?.id || docs[0]?.id || null;
      } catch {
        /* non-fatal */
      }

      const quote = await insertGfQuote({
        bmi_reservation_id: resId,
        hermes_center: item.center,
        center_code: center.centerCode,
        center_name: item.centerName,
        square_location_id: center.squareLocationId,
        brand: center.brand,
        base_url: center.baseUrl,
        gan_prefix: center.ganPrefix,
        planner_first: item.planner.first,
        planner_last: item.planner.last,
        planner_email: item.planner.email,
        planner_phone: item.planner.phone,
        guest_first_name: item.customer.first,
        guest_last_name: item.customer.last,
        guest_email: item.customer.email,
        guest_phone: item.customer.phone,
        event_name: item.event.name,
        event_number: item.event.number,
        event_date: item.event.dateRaw,
        event_date_display: formatEventDate(item.event.dateRaw),
        notes: item.event.notes,
        total_cents: m.totalCents,
        tax_cents: m.taxCents,
        deposit_due_cents: m.depositCents,
        balance_cents: m.balanceCents,
        line_items: item.products,
        prior_payments: item.payments,
        is_tax_exempt: m.taxExempt,
      });

      const nowIso = new Date().toISOString();
      // Land in `contract_sent` (card-on-file model): the guest re-confirms +
      // adds a card via the /contract portal. No charge, no BMI change here.
      await markGfQuoteIngestedWinback(quote.id, {
        contract_short_id: shortId,
        pandadoc_document_id: pandadocDocId,
        contract_sent_at: nowIso,
        deposit_due_cents: m.depositCents,
        balance_cents: m.balanceCents,
        incentive_cents: incentiveCents,
      });

      await appendAuditLog({
        quoteId: quote.id,
        event: "legacy_winback_ingested",
        metadata: {
          reservationId: resId,
          totalCents: m.totalCents,
          depositCents: m.depositCents,
          balanceCents: m.balanceCents,
          pandadocDocId,
        },
      });
      // Mark occurrence 0 of the drip as sent so the reminder rule starts at +7d.
      await appendAuditLog({
        quoteId: quote.id,
        event: "rem_winback_offer:0",
        metadata: { source: "ingest" },
      });

      const fresh = await getGfQuoteByShortId(shortId);
      if (fresh) {
        notifyWinbackOffer(fresh, { smsSuppressed: withinQuietHours() }).catch((err) =>
          console.error(`[ingest-legacy] offer notify failed quote=${quote.id}:`, err),
        );
      }

      ingested++;
      results.push({
        reservationId: resId,
        action: "ingested",
        quoteId: quote.id,
        shortId,
        balanceCents: m.balanceCents,
        name: item.event.name,
      });
    } catch (err) {
      console.error(`[ingest-legacy] failed for ${resId}:`, err);
      results.push({
        reservationId: resId,
        action: "error",
        error: err instanceof Error ? err.message : String(err),
        name: item.event.name,
      });
    }
  }

  const summary = results.reduce<Record<string, number>>((acc, r) => {
    const a = String(r.action);
    acc[a] = (acc[a] || 0) + 1;
    return acc;
  }, {});

  console.log(`[ingest-legacy] dryRun=${dryRun} ${JSON.stringify(summary)}`);
  return NextResponse.json({ ok: true, dryRun, scanned: cohort.length, summary, results });
}
