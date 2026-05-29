import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  resolveCenter,
  selectTemplate,
  isTaxExempt,
  type HermesQueueItem,
} from "@/lib/hermes-client";
import {
  insertGfQuote,
  getGfQuoteByReservationId,
  getGfQuoteByShortId,
  updateGfContractSent,
  updateGfQuoteDetails,
} from "@/lib/group-function-db";
import {
  notifyContractSent,
  notifyContractUpdated,
  notifyApprovalNeeded,
} from "@/lib/group-function-notify";
import { scanForNewEvents, CENTERS } from "@/lib/bmi-scan";
import { verifyCron } from "@/lib/cron-auth";

/**
 * Group Quote Dispatch cron.
 *
 * Scans BMI Office directly for events in "New Deposit Requested"
 * state, creates internal contracts, persists to Neon, and sends
 * contract emails.
 *
 * Replaces the Hermes queue-based approach to eliminate the
 * "read = consumed" bug and Hermes polling dependency.
 *
 * Schedule: every 2 minutes via vercel.json.
 *
 * Query params:
 *   ?dryRun=1  — scan + report, no creation
 *   ?limit=N   — max items to process per run (default 5)
 */

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || "5"), 20);

  const results: Array<{
    reservationId: string;
    action: string;
    error?: string;
  }> = [];

  let scannedItems: HermesQueueItem[];
  try {
    scannedItems = await scanForNewEvents();
  } catch (err) {
    console.error("[group-quote-dispatch] BMI scan failed:", err);
    return NextResponse.json({ ok: false, error: "BMI scan failed" }, { status: 502 });
  }

  // All scanned items are in "Send Contract" state — process all of them
  // (sales explicitly requested send/resend by setting this state)
  const itemsToProcess = scannedItems.slice(0, limit);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      scanned: scannedItems.length,
      toProcess: itemsToProcess.length,
      items: itemsToProcess.map((i) => ({
        reservationId: i.reservationId,
        centerName: i.centerName,
        eventName: i.event.name,
        totalBill: i.totalBill,
      })),
    });
  }

  for (const item of itemsToProcess) {
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
    `[group-quote-dispatch] scanned=${scannedItems.length} processed=${results.length} ` +
      `created=${results.filter((r) => r.action === "created").length} ` +
      `resent=${results.filter((r) => r.action === "resent").length} ` +
      `errors=${results.filter((r) => r.action === "error").length}`,
  );

  return NextResponse.json({
    ok: true,
    scanned: scannedItems.length,
    processed: results.length,
    results,
  });
}

function formatEventDate(dateRaw: string): string {
  // BMI dates are local ET without timezone (e.g. "2026-10-17T11:30:00")
  // Hermes has a bug in its moment format string (MM instead of mm)
  // so we format it ourselves
  const hasTimezone =
    dateRaw.includes("Z") || dateRaw.includes("+") || /\d-\d{2}:\d{2}$/.test(dateRaw);
  const d = new Date(hasTimezone ? dateRaw : `${dateRaw}-04:00`);
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

async function processQueueItem(
  item: HermesQueueItem,
): Promise<{ reservationId: string; action: string }> {
  // Hermes sometimes sends "10.48.0.14" for FastTrax events — detect via subject
  let hermesCenter = item.center;
  if (
    hermesCenter === "10.48.0.14" &&
    (item.subject?.includes("FT") || item.subject?.includes("FastTrax"))
  ) {
    hermesCenter = "10.48.0.14_FT";
  }

  const center = resolveCenter(hermesCenter);
  if (!center) {
    return { reservationId: item.reservationId, action: "skipped_unknown_center" };
  }

  let existing = await getGfQuoteByReservationId(item.reservationId);

  // If previous quote was cancelled/denied/expired, reset it for re-processing
  if (existing && ["cancelled", "denied", "expired"].includes(existing.status)) {
    const { sql } = await import("@/lib/db");
    const q = sql();
    await q`UPDATE group_function_quotes SET
      status = 'pending',
      contract_sent_at = NULL,
      contract_status = NULL,
      contract_short_id = NULL,
      deposit_paid_at = NULL,
      square_deposit_order_id = NULL,
      square_deposit_payment_id = NULL,
      square_gift_card_id = NULL,
      square_gift_card_gan = NULL,
      square_dayof_order_id = NULL,
      signed_pdf_url = NULL,
      hermes_last_processed_at = NOW(),
      updated_at = NOW()
    WHERE id = ${existing.id}`;
    existing = null;
    console.log(
      `[group-quote-dispatch] reset cancelled quote for reservation=${item.reservationId}`,
    );
  }

  // Debounce: skip if processed within the last 60 seconds
  if (
    existing?.hermes_last_processed_at &&
    Date.now() - new Date(existing.hermes_last_processed_at).getTime() < 60_000
  ) {
    return { reservationId: item.reservationId, action: "debounced" };
  }

  let totalCents = Math.round(item.totalBill * 100);
  const taxExempt = isTaxExempt(item.products);
  const taxCents = taxExempt ? 0 : Math.round(item.tax * 100);
  const isPostPaid = selectTemplate(item) === "postpay";

  // Post-paid: no deposit, full amount billed day-of
  // Events within 96 hours: full payment upfront
  const eventTime = new Date(item.event.dateRaw).getTime();
  const hoursUntilEvent = (eventTime - Date.now()) / 3_600_000;
  const fullPaymentRequired = !isPostPaid && hoursUntilEvent <= 96;
  let depositDueCents = isPostPaid
    ? 0
    : fullPaymentRequired
      ? totalCents
      : Math.round(totalCents / 2);

  // No-changes check: if pricing/products match, update contact info and re-send
  if (existing && existing.contract_sent_at) {
    const existingProducts = (existing.line_items as unknown[]) || [];
    const pricingUnchanged =
      existing.total_cents === totalCents &&
      existing.deposit_due_cents === depositDueCents &&
      existing.tax_cents === taxCents &&
      existing.event_name === item.event.name &&
      existingProducts.length === item.products.length;

    if (pricingUnchanged) {
      await updateGfQuoteDetails(existing.id, {
        guest_first_name: item.customer.first,
        guest_last_name: item.customer.last,
        guest_email: item.customer.email,
        guest_phone: item.customer.phone,
        planner_first: item.planner.first,
        planner_last: item.planner.last,
        planner_email: item.planner.email,
        planner_phone: item.planner.phone,
        notes: item.event.notes,
        hermes_last_processed_at: new Date().toISOString(),
      });
      const refreshedQuote = await getGfQuoteByShortId(existing.contract_short_id!);
      if (refreshedQuote) {
        notifyContractSent(refreshedQuote).catch((err) =>
          console.error("[group-quote-dispatch] resend notify error:", err),
        );
      }
      // Transition back to Pending Signed Contract
      try {
        const { setProjectState } = await import("@/lib/bmi-office-actions");
        const scanCenter = CENTERS.find((c) => item.center.startsWith(c.hermesCenter));
        if (scanCenter) {
          await setProjectState({
            centerCode: center.centerCode,
            projectId: item.reservationId,
            stateId: scanCenter.pendingSignedContractStateId,
            label: "Pending Signed Contract",
          });
        }
      } catch {
        /* non-fatal */
      }
      // Log to BMI private notes
      try {
        const { appendProjectPrivateNote, noteTimestamp } =
          await import("@/lib/bmi-office-actions");
        const contractUrl = `${center.baseUrl}/contract/${existing.contract_short_id}`;
        await appendProjectPrivateNote({
          centerCode: center.centerCode,
          projectId: item.reservationId,
          note: `[${noteTimestamp()}] Contract resent to ${item.customer.email}`,
          contractUrl,
        });
      } catch {
        /* non-fatal */
      }
      console.log(
        `[group-quote-dispatch] pricing unchanged, updated contacts + resent link for reservation=${item.reservationId}`,
      );
      return { reservationId: item.reservationId, action: "resent" };
    }
  }

  // Post-signing update: data only, preserve gift card
  if (
    existing &&
    (existing.status === "deposit_paid" ||
      existing.status === "resign_required" ||
      existing.status === "balance_charged" ||
      existing.status === "balance_link_sent" ||
      existing.status === "completed")
  ) {
    const priceChanged = existing.total_cents !== totalCents;
    const balanceCents = totalCents - existing.deposit_due_cents;
    await updateGfQuoteDetails(existing.id, {
      event_name: item.event.name,
      event_number: item.event.number,
      event_date: item.event.dateRaw,
      event_date_display: formatEventDate(item.event.dateRaw),
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

    if (
      priceChanged &&
      (existing.status === "deposit_paid" || existing.status === "balance_charged")
    ) {
      const q = (await import("@/lib/db")).sql();
      await q`UPDATE group_function_quotes SET status = 'resign_required', updated_at = NOW() WHERE id = ${existing.id}`;
      console.log(
        `[group-quote-dispatch] PRICE CHANGED for reservation=${item.reservationId} — resign_required ` +
          `(was ${existing.total_cents} → now ${totalCents})`,
      );
    }

    // Log to BMI private notes
    try {
      const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
      const contractUrl = `${center.baseUrl}/contract/${existing.contract_short_id}`;
      await appendProjectPrivateNote({
        centerCode: center.centerCode,
        projectId: item.reservationId,
        note: `[${noteTimestamp()}] Contract updated${priceChanged ? " (price changed — resign required)" : ""}`,
        contractUrl,
      });
    } catch {
      /* non-fatal */
    }

    console.log(
      `[group-quote-dispatch] post-sign data update for reservation=${item.reservationId}${priceChanged ? " (PRICE CHANGED)" : ""}`,
    );
    return {
      reservationId: item.reservationId,
      action: priceChanged ? "resign_required" : "updated_data",
    };
  }

  // Verify and correct service charge tier before processing
  let activeProducts = item.products;
  try {
    const { verifyAndCorrectServiceCharge } = await import("@/lib/service-charge");
    const scCheck = await verifyAndCorrectServiceCharge(
      center.centerCode,
      item.reservationId,
      item.products,
    );
    if (scCheck.corrected) {
      activeProducts = scCheck.products;
      const oldTotal = totalCents;
      // Recalculate from corrected products so DB stays consistent with BMI
      totalCents = Math.round(activeProducts.reduce((s, p) => s + p.total, 0) * 100) + taxCents;
      depositDueCents = fullPaymentRequired ? totalCents : Math.round(totalCents / 2);
      console.log(
        `[group-quote-dispatch] service charge corrected for reservation=${item.reservationId} ` +
          `(total ${oldTotal} → ${totalCents})`,
      );
    }
  } catch (err) {
    console.warn("[group-quote-dispatch] service charge check failed:", err);
  }

  // AI cleanup: format event name + clean up notes grammar
  let eventName = item.event.name || "";
  let eventNotes = item.event.notes || "";
  try {
    const [{ formatEventName }, { cleanupNotesGrammar }] = await Promise.all([
      import("@/lib/event-name-format"),
      import("@/lib/notes-grammar"),
    ]);

    const [formattedName, cleanedNotes] = await Promise.all([
      eventName.trim() ? formatEventName(eventName) : Promise.resolve(eventName),
      eventNotes.trim() ? cleanupNotesGrammar(eventNotes) : Promise.resolve(eventNotes),
    ]);

    const nameChanged = formattedName !== eventName;
    const notesChanged = cleanedNotes !== eventNotes;

    if (nameChanged) {
      eventName = formattedName;
      console.log(
        `[group-quote-dispatch] AI formatted name: "${item.event.name}" → "${formattedName}"`,
      );
    }
    if (notesChanged) {
      eventNotes = cleanedNotes;
      console.log(
        `[group-quote-dispatch] AI grammar-cleaned notes for reservation=${item.reservationId}`,
      );
    }

    // Update BMI Office with corrected name + notes
    if (nameChanged || notesChanged) {
      const bmi = await import("@/lib/bmi-office-actions");
      const updates: Promise<void>[] = [];
      if (nameChanged) {
        updates.push(
          bmi.updateProjectName({
            centerCode: center.centerCode,
            projectId: item.reservationId,
            name: formattedName,
          }),
        );
      }
      if (notesChanged) {
        updates.push(
          bmi.updateProjectPublicNotes({
            centerCode: center.centerCode,
            projectId: item.reservationId,
            notes: cleanedNotes,
          }),
        );
      }
      await Promise.allSettled(updates);
    }
  } catch (err) {
    console.warn("[group-quote-dispatch] AI cleanup failed:", err);
  }

  // Create or update internal contract (no PandaDoc)
  const contractShortId = existing?.contract_short_id || randomBytes(4).toString("hex");
  const balanceCents = totalCents - depositDueCents;

  if (fullPaymentRequired) {
    console.log(
      `[group-quote-dispatch] FULL PAYMENT: event within ${Math.round(hoursUntilEvent)}hrs — deposit=${totalCents} balance=0 for reservation=${item.reservationId}`,
    );
  }

  let quoteId: number;
  if (existing) {
    await updateGfQuoteDetails(existing.id, {
      event_name: eventName,
      event_number: item.event.number,
      event_date: item.event.dateRaw,
      event_date_display: formatEventDate(item.event.dateRaw),
      notes: eventNotes,
      total_cents: totalCents,
      tax_cents: taxCents,
      deposit_due_cents: depositDueCents,
      balance_cents: balanceCents,
      line_items: activeProducts,
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
      event_name: eventName,
      event_number: item.event.number,
      event_date: item.event.dateRaw,
      event_date_display: formatEventDate(item.event.dateRaw),
      notes: eventNotes,
      total_cents: totalCents,
      tax_cents: taxCents,
      deposit_due_cents: depositDueCents,
      balance_cents: balanceCents,
      line_items: activeProducts,
      prior_payments: item.payments,
      is_tax_exempt: taxExempt,
    });
    quoteId = quote.id;
  }

  // Check if post-paid account (requires management approval before sending)
  const isPostPaid = selectTemplate(item) === "postpay";

  if (isPostPaid && !existing?.approved_at) {
    // Hold for approval — don't send contract yet
    const q = (await import("@/lib/db")).sql();
    await q`UPDATE group_function_quotes SET
      contract_short_id = ${contractShortId},
      approval_required = TRUE,
      status = 'pending_approval',
      updated_at = NOW()
    WHERE id = ${quoteId}`;

    const pendingQuote = await getGfQuoteByShortId(contractShortId);
    if (pendingQuote) {
      notifyApprovalNeeded(pendingQuote).catch((err) =>
        console.error("[group-quote-dispatch] approval notify error:", err),
      );
    }

    console.log(
      `[group-quote-dispatch] POST-PAID: pending approval for reservation=${item.reservationId} shortId=${contractShortId}`,
    );
    return { reservationId: item.reservationId, action: "pending_approval" };
  }

  // Mark contract as sent
  await updateGfContractSent(quoteId, {
    contract_short_id: contractShortId,
    contract_status: "sent",
    contract_sent_at: new Date().toISOString(),
  });

  // Notify guest + planner (non-blocking)
  const updatedQuote = await getGfQuoteByShortId(contractShortId);
  if (updatedQuote) {
    const notify = existing ? notifyContractUpdated : notifyContractSent;
    notify(updatedQuote).catch((err) => console.error("[group-quote-dispatch] notify error:", err));
  }

  // Log to BMI private notes
  try {
    const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
    const contractUrl = `${center.baseUrl}/contract/${contractShortId}`;
    const ts = noteTimestamp();
    await appendProjectPrivateNote({
      centerCode: center.centerCode,
      projectId: item.reservationId,
      note: `[${ts}] Contract sent to ${item.customer.email}`,
      contractUrl,
    });
  } catch {
    /* non-fatal */
  }

  // Transition BMI state from "Send Contract" → "Pending Signed Contract"
  try {
    const { setProjectState } = await import("@/lib/bmi-office-actions");
    const scanCenter = CENTERS.find((c) => item.center.startsWith(c.hermesCenter));
    if (scanCenter) {
      await setProjectState({
        centerCode: center.centerCode,
        projectId: item.reservationId,
        stateId: scanCenter.pendingSignedContractStateId,
        label: "Pending Signed Contract",
      });
    }
  } catch (err) {
    console.warn(
      `[group-quote-dispatch] failed to set Pending Signed Contract for ${item.reservationId}:`,
      err,
    );
  }

  console.log(
    `[group-quote-dispatch] contract created for reservation=${item.reservationId} shortId=${contractShortId}`,
  );

  return { reservationId: item.reservationId, action: "created" };
}
