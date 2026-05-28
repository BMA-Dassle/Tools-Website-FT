import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  fetchPandaDocQueue,
  completePandaDocQueue,
  resolveCenter,
  type HermesQueueItem,
} from "@/lib/hermes-client";
import {
  insertGfQuote,
  getGfQuoteByReservationId,
  getGfQuoteByShortId,
  updateGfContractSent,
  updateGfQuoteDetails,
} from "@/lib/group-function-db";
import { notifyContractSent, notifyContractUpdated } from "@/lib/group-function-notify";

/**
 * Group Quote Dispatch cron.
 *
 * Polls Hermes /queue/pandadoc for pending event quotes, creates
 * internal contracts (no PandaDoc), persists to Neon, and acknowledges.
 *
 * Schedule: every 2 minutes via vercel.json.
 *
 * Query params:
 *   ?dryRun=1  — scan + report, no creation or Hermes completion
 *   ?limit=N   — max items to process per run (default 5)
 */

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || "5"), 20);

  const results: Array<{
    reservationId: string;
    action: string;
    error?: string;
  }> = [];

  let queueItems: HermesQueueItem[];
  try {
    queueItems = await fetchPandaDocQueue();
  } catch (err) {
    console.error("[group-quote-dispatch] Hermes queue fetch failed:", err);
    return NextResponse.json({ ok: false, error: "Hermes queue fetch failed" }, { status: 502 });
  }

  const validItems = queueItems.filter((item) => !item.error).slice(0, limit);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      total: queueItems.length,
      valid: validItems.length,
      items: validItems.map((i) => ({
        reservationId: i.reservationId,
        centerName: i.centerName,
        eventName: i.event.name,
        depositDue: i.depositDue,
      })),
    });
  }

  for (const item of validItems) {
    try {
      const result = await processQueueItem(item);
      results.push(result);
    } catch (err) {
      console.error(`[group-quote-dispatch] Error processing ${item.reservationId}:`, err);
      results.push({
        reservationId: item.reservationId,
        action: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(
    `[group-quote-dispatch] processed=${results.length} ` +
      `created=${results.filter((r) => r.action === "created").length} ` +
      `skipped=${results.filter((r) => r.action === "skipped").length} ` +
      `errors=${results.filter((r) => r.action === "error").length}`,
  );

  return NextResponse.json({ ok: true, results });
}

async function processQueueItem(
  item: HermesQueueItem,
): Promise<{ reservationId: string; action: string }> {
  const center = resolveCenter(item.center);
  if (!center) {
    return { reservationId: item.reservationId, action: "skipped_unknown_center" };
  }

  const existing = await getGfQuoteByReservationId(item.reservationId);

  // Debounce: skip if processed within the last 60 seconds
  if (
    existing?.hermes_last_processed_at &&
    Date.now() - new Date(existing.hermes_last_processed_at).getTime() < 60_000
  ) {
    await completePandaDocQueue({
      center: item.center,
      queueId: item.queueId,
      logId: item.logId,
      message: `${item.customer.email} (debounced)`,
    });
    return { reservationId: item.reservationId, action: "debounced" };
  }

  const depositDueCents = Math.round(item.depositDue * 100);
  const totalCents = Math.round(item.totalBill * 100);
  const taxCents = Math.round(item.tax * 100);

  // No-changes check: if data matches, just re-send the link
  if (existing && existing.contract_sent_at) {
    const existingProducts = (existing.line_items as unknown[]) || [];
    const unchanged =
      existing.total_cents === totalCents &&
      existing.deposit_due_cents === depositDueCents &&
      existing.tax_cents === taxCents &&
      existing.event_name === item.event.name &&
      existing.guest_email === item.customer.email &&
      existingProducts.length === item.products.length;

    if (unchanged) {
      await updateGfQuoteDetails(existing.id, {
        hermes_last_processed_at: new Date().toISOString(),
      });
      const refreshedQuote = await getGfQuoteByShortId(existing.contract_short_id!);
      if (refreshedQuote) {
        notifyContractSent(refreshedQuote).catch((err) =>
          console.error("[group-quote-dispatch] resend notify error:", err),
        );
      }
      await completePandaDocQueue({
        center: item.center,
        queueId: item.queueId,
        logId: item.logId,
        message: `${item.customer.email} (resent)`,
      });
      console.log(
        `[group-quote-dispatch] no changes, resent link for reservation=${item.reservationId}`,
      );
      return { reservationId: item.reservationId, action: "resent" };
    }
  }

  // Post-signing update: data only, preserve gift card
  if (existing && (existing.status === "deposit_paid" || existing.status === "resign_required" || existing.status === "balance_charged" || existing.status === "balance_link_sent" || existing.status === "completed")) {
    const priceChanged = existing.total_cents !== totalCents;
    const balanceCents = totalCents - existing.deposit_due_cents;
    await updateGfQuoteDetails(existing.id, {
      event_name: item.event.name,
      event_number: item.event.number,
      event_date: item.event.dateRaw,
      event_date_display: item.event.date,
      notes: item.event.notes,
      total_cents: totalCents,
      tax_cents: taxCents,
      deposit_due_cents: depositDueCents,
      balance_cents: Math.max(0, balanceCents),
      line_items: item.products,
      prior_payments: item.payments,
      planner_first: item.planner.first,
      planner_last: item.planner.last,
      planner_email: item.planner.email,
      planner_phone: item.planner.phone,
      guest_first_name: item.customer.first,
      guest_last_name: item.customer.last,
      guest_email: item.customer.email,
      guest_phone: item.customer.phone,
      hermes_last_processed_at: new Date().toISOString(),
    });

    if (priceChanged && (existing.status === "deposit_paid" || existing.status === "balance_charged")) {
      const q = (await import("@/lib/db")).sql();
      await q`UPDATE group_function_quotes SET status = 'resign_required', updated_at = NOW() WHERE id = ${existing.id}`;
      console.log(
        `[group-quote-dispatch] PRICE CHANGED for reservation=${item.reservationId} — resign_required ` +
          `(was ${existing.total_cents} → now ${totalCents})`,
      );
    }

    await completePandaDocQueue({
      center: item.center,
      queueId: item.queueId,
      logId: item.logId,
      message: `${item.customer.email} (post-sign update${priceChanged ? " — price changed" : ""})`,
    });
    console.log(
      `[group-quote-dispatch] post-sign data update for reservation=${item.reservationId}${priceChanged ? " (PRICE CHANGED)" : ""}`,
    );
    return { reservationId: item.reservationId, action: priceChanged ? "resign_required" : "updated_data" };
  }

  // Create or update internal contract (no PandaDoc)
  const contractShortId = existing?.contract_short_id || randomBytes(4).toString("hex");
  const balanceCents = totalCents - depositDueCents;

  let quoteId: number;
  if (existing) {
    await updateGfQuoteDetails(existing.id, {
      event_name: item.event.name,
      event_number: item.event.number,
      event_date: item.event.dateRaw,
      event_date_display: item.event.date,
      notes: item.event.notes,
      total_cents: totalCents,
      tax_cents: taxCents,
      deposit_due_cents: depositDueCents,
      balance_cents: balanceCents,
      line_items: item.products,
      prior_payments: item.payments,
      planner_first: item.planner.first,
      planner_last: item.planner.last,
      planner_email: item.planner.email,
      planner_phone: item.planner.phone,
      guest_first_name: item.customer.first,
      guest_last_name: item.customer.last,
      guest_email: item.customer.email,
      guest_phone: item.customer.phone,
      hermes_last_processed_at: new Date().toISOString(),
    });
    quoteId = existing.id;
  } else {
    const quote = await insertGfQuote({
      bmi_reservation_id: item.reservationId,
      hermes_queue_id: item.queueId,
      hermes_log_id: item.logId,
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
      event_date_display: item.event.date,
      notes: item.event.notes,
      total_cents: totalCents,
      tax_cents: taxCents,
      deposit_due_cents: depositDueCents,
      balance_cents: balanceCents,
      line_items: item.products,
      prior_payments: item.payments,
    });
    quoteId = quote.id;
  }

  // Mark contract as sent
  await updateGfContractSent(quoteId, {
    contract_short_id: contractShortId,
    contract_status: "sent",
    contract_sent_at: new Date().toISOString(),
  });

  // Complete the Hermes queue item
  const now = new Date();
  const dateStr = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;
  await completePandaDocQueue({
    center: item.center,
    queueId: item.queueId,
    logId: item.logId,
    message: `${item.customer.email} ${dateStr}`,
  });

  // Notify guest + planner (non-blocking)
  const updatedQuote = await getGfQuoteByShortId(contractShortId);
  if (updatedQuote) {
    const notify = existing ? notifyContractUpdated : notifyContractSent;
    notify(updatedQuote).catch((err) =>
      console.error("[group-quote-dispatch] notify error:", err),
    );
  }

  console.log(
    `[group-quote-dispatch] contract created for reservation=${item.reservationId} shortId=${contractShortId}`,
  );

  return { reservationId: item.reservationId, action: "created" };
}
