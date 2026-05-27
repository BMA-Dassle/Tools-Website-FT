import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  fetchPandaDocQueue,
  completePandaDocQueue,
  resolveCenter,
  selectTemplate,
  PANDADOC_TEMPLATE_IDS,
  type HermesQueueItem,
} from "@/lib/hermes-client";
import {
  insertGfQuote,
  getGfQuoteByReservationId,
  updateGfContractSent,
} from "@/lib/group-function-db";
import {
  buildDocumentBody,
  createDocument,
  waitForDraft,
  sendDocument,
  searchDocumentsByReservation,
  cancelDocument,
} from "@/lib/pandadoc";

/**
 * Group Quote Dispatch cron.
 *
 * Polls Hermes /queue/pandadoc for pending event quotes, creates
 * PandaDoc contracts, persists to Neon, and acknowledges processing.
 *
 * Schedule: every 2 minutes via vercel.json.
 *
 * Query params:
 *   ?dryRun=1  — scan + report, no PandaDoc creation or Hermes completion
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
        template: selectTemplate(i),
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

    // Rate limit: 15s between PandaDoc API calls
    if (validItems.indexOf(item) < validItems.length - 1) {
      await new Promise((r) => setTimeout(r, 15_000));
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

  // Idempotency: skip if already in Neon
  const existing = await getGfQuoteByReservationId(item.reservationId);
  if (existing?.contract_sent_at) {
    // Already processed — just complete the Hermes queue item
    await completePandaDocQueue({
      center: item.center,
      queueId: item.queueId,
      logId: item.logId,
      message: `${item.customer.email} (already processed)`,
    });
    return { reservationId: item.reservationId, action: "skipped" };
  }

  // Cancel any existing PandaDoc docs for this reservation
  const existingDocs = await searchDocumentsByReservation(center.centerCode, item.reservationId);
  for (const doc of existingDocs) {
    if (doc.status !== "document.voided" && doc.status !== "document.deleted") {
      await cancelDocument(center.centerCode, doc.id);
    }
  }

  // Build and create PandaDoc document
  const { template, templateId, body } = buildDocumentBody(item);
  const { documentId } = await createDocument(center.centerCode, body);

  // Wait for PandaDoc to finish processing
  await waitForDraft(center.centerCode, documentId);

  // Send the document
  await sendDocument(center.centerCode, documentId, item.planner.email);

  // Generate short ID for the contract landing page
  const contractShortId = randomBytes(4).toString("hex");

  // Persist to Neon (insert or update if row exists but wasn't sent yet)
  const depositDueCents = Math.round(item.depositDue * 100);
  const totalCents = Math.round(item.totalBill * 100);
  const taxCents = Math.round(item.tax * 100);
  const balanceCents = totalCents - depositDueCents;

  let quoteId: number;
  if (existing) {
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
      pandadoc_template: template,
      pandadoc_template_id: templateId,
    });
    quoteId = quote.id;
  }

  // Update with PandaDoc details
  await updateGfContractSent(quoteId, {
    pandadoc_document_id: documentId,
    pandadoc_template: template,
    pandadoc_template_id: templateId,
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

  // TODO: Send branded SMS + email to guest with /contract/{shortId} link
  // TODO: Post Teams adaptive card to planner

  console.log(
    `[group-quote-dispatch] created contract for reservation=${item.reservationId} ` +
      `doc=${documentId} shortId=${contractShortId} template=${template}`,
  );

  return { reservationId: item.reservationId, action: "created" };
}
