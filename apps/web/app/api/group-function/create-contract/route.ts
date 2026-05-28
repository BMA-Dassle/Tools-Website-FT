import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { fetchReservationProducts, resolveCenter, type HermesQueueItem } from "@/lib/hermes-client";
import {
  insertGfQuote,
  getGfQuoteByReservationId,
  getGfQuoteByShortId,
  updateGfContractSent,
} from "@/lib/group-function-db";
import { notifyContractSent } from "@/lib/group-function-notify";
import {
  buildDocumentBodyFromQuote,
  createDocument,
  waitForDraft,
  sendDocument,
  searchDocumentsByReservation,
  cancelDocument,
} from "@/lib/pandadoc";

/**
 * Manual contract creation endpoint.
 *
 * POST /api/group-function/create-contract
 *   Header: x-admin-key: {CONTRACTS_ADMIN_KEY}
 *   Body: { reservationId, center } — center is the Hermes center IP
 *
 * This creates a PandaDoc contract for an existing Neon row (inserted
 * by the cron or manually). If the row doesn't exist, provide full
 * Hermes-style data in the body to create it.
 */

const ADMIN_KEY = process.env.CONTRACTS_ADMIN_KEY || "";

export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key") || "";
  if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { reservationId } = body as { reservationId: string };

  if (!reservationId) {
    return NextResponse.json({ error: "reservationId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByReservationId(reservationId);
  if (!quote) {
    return NextResponse.json(
      {
        error: `No quote found for reservationId=${reservationId}. Insert via cron first or provide full data.`,
      },
      { status: 404 },
    );
  }

  if (quote.contract_sent_at) {
    return NextResponse.json({
      ok: true,
      action: "already_sent",
      contractShortId: quote.contract_short_id,
      pandadocDocumentId: quote.pandadoc_document_id,
    });
  }

  // Cancel any existing PandaDoc docs for this reservation
  const existingDocs = await searchDocumentsByReservation(quote.center_code, reservationId);
  for (const doc of existingDocs) {
    if (doc.status !== "document.voided" && doc.status !== "document.deleted") {
      await cancelDocument(quote.center_code, doc.id);
    }
  }

  // Build and create PandaDoc document from the persisted quote
  const { template, templateId, body: docBody } = buildDocumentBodyFromQuote(quote);
  const { documentId } = await createDocument(quote.center_code, docBody);

  await waitForDraft(quote.center_code, documentId);
  await sendDocument(quote.center_code, documentId, quote.planner_email || "");

  const contractShortId = randomBytes(4).toString("hex");

  await updateGfContractSent(quote.id, {
    pandadoc_document_id: documentId,
    pandadoc_template: template,
    pandadoc_template_id: templateId,
    contract_short_id: contractShortId,
    contract_status: "sent",
    contract_sent_at: new Date().toISOString(),
  });

  const updatedQuote = await getGfQuoteByShortId(contractShortId);
  if (updatedQuote) {
    notifyContractSent(updatedQuote).catch((err) =>
      console.error("[create-contract] notify error:", err),
    );
  }

  return NextResponse.json({
    ok: true,
    action: "created",
    contractShortId,
    pandadocDocumentId: documentId,
    template,
  });
}
