import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/pandadoc";
import { getGfQuoteByPandaDocId, updateGfContractStatus } from "@/lib/group-function-db";

/**
 * PandaDoc webhook receiver.
 *
 * PandaDoc sends document state changes here. Signature is in
 * the ?signature= query param (HMAC-SHA256 of raw body with
 * per-workspace shared key).
 *
 * Events we handle:
 *   document_state_changed → document.viewed, document.completed, document.declined
 */

export async function POST(req: NextRequest) {
  const signatureHex = req.nextUrl.searchParams.get("signature") || "";

  const rawBody = Buffer.from(await req.arrayBuffer());
  const { valid } = verifyWebhookSignature(rawBody, signatureHex);

  if (!valid) {
    console.warn("[pandadoc-webhook] Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let events: Array<{
    event: string;
    data: { id: string; name: string; status: string; [k: string]: unknown };
  }>;

  try {
    const body = JSON.parse(rawBody.toString("utf-8"));
    events = Array.isArray(body) ? body : [body];
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const results = await Promise.allSettled(events.map((evt) => handleEvent(evt)));

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(
    `[pandadoc-webhook] processed=${events.length} succeeded=${succeeded} failed=${failed}`,
  );

  return NextResponse.json({ ok: true, processed: events.length });
}

async function handleEvent(evt: {
  event: string;
  data: { id: string; status: string; [k: string]: unknown };
}) {
  const documentId = evt.data?.id;
  if (!documentId) return;

  const quote = await getGfQuoteByPandaDocId(documentId);
  if (!quote) {
    console.log(`[pandadoc-webhook] No quote found for documentId=${documentId}, ignoring`);
    return;
  }

  const status = evt.data.status;

  switch (status) {
    case "document.viewed":
      await updateGfContractStatus(quote.id, "viewed");
      console.log(`[pandadoc-webhook] quote=${quote.id} viewed by guest`);
      break;

    case "document.completed":
      await updateGfContractStatus(quote.id, "signed", new Date().toISOString());
      console.log(
        `[pandadoc-webhook] quote=${quote.id} signed! ` +
          `guest=${quote.guest_email} event=${quote.event_name}`,
      );
      // TODO: Update Teams adaptive card ("Contract signed")
      // TODO: Send celebration SMS + email to guest
      break;

    case "document.declined":
      await updateGfContractStatus(quote.id, "declined");
      console.log(`[pandadoc-webhook] quote=${quote.id} declined by guest`);
      // TODO: Alert planner via Teams
      break;

    case "document.voided":
      await updateGfContractStatus(quote.id, "voided");
      console.log(`[pandadoc-webhook] quote=${quote.id} voided`);
      break;

    default:
      console.log(`[pandadoc-webhook] Unhandled status=${status} for doc=${documentId}`);
  }
}
