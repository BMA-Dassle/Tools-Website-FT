import { NextRequest, NextResponse } from "next/server";
import { getGfQuoteByShortId, appendAuditLog } from "@/lib/group-function-db";
import { computeDocumentSeal } from "@/lib/contract-seal";
import { sql } from "@/lib/db";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

/**
 * Record the guest's signature, compute document seal, update Neon.
 *
 * POST /api/group-function/sign
 * Body: { shortId, signatureType, signatureData, agreements, taxExempt, taxFileUrl }
 *
 * Called when the guest clicks "Sign & Continue to Payment" on the contract page.
 */

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { shortId, signatureType, signatureData, agreements, taxExempt, taxFileUrl } = body as {
    shortId: string;
    signatureType: "typed" | "drawn";
    signatureData: string;
    agreements: {
      deposit: boolean;
      autoCharge: boolean;
      waiverAcknowledged: boolean;
      tipsAcknowledged: boolean;
      policyAcknowledged: boolean;
    };
    taxExempt: "yes" | "no";
    taxFileUrl?: string;
  };

  if (!shortId || !signatureData) {
    return NextResponse.json({ error: "shortId and signatureData required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const signerIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const signerUa = req.headers.get("user-agent") || "unknown";
  const signedAt = new Date().toISOString();

  // Compute document seal
  const seal = computeDocumentSeal({
    quoteId: quote.id,
    reservationId: quote.bmi_reservation_id,
    eventName: quote.event_name || "",
    eventDate: quote.event_date,
    centerName: quote.center_name,
    lineItems: quote.line_items as unknown[],
    totalCents: quote.total_cents,
    taxCents: quote.tax_cents,
    depositDueCents: quote.deposit_due_cents,
    guestName: `${quote.guest_first_name} ${quote.guest_last_name}`,
    guestEmail: quote.guest_email,
    plannerName: `${quote.planner_first || ""} ${quote.planner_last || ""}`.trim(),
    plannerEmail: quote.planner_email || "",
    agreements: { ...agreements, taxExempt },
    signature: { type: signatureType, value: signatureData, timestamp: signedAt },
    signerIp,
    signerUserAgent: signerUa,
    policyVersion: "v1-2026-05-28",
  });

  // Update Neon
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      signature_type = ${signatureType},
      signature_data = ${signatureData},
      signer_ip = ${signerIp},
      signer_ua = ${signerUa},
      contract_signed_at = ${signedAt},
      contract_status = 'signed',
      document_seal = ${seal},
      tax_file_url = ${taxFileUrl || null},
      updated_at = NOW()
    WHERE id = ${quote.id}
  `;

  // Audit trail
  await appendAuditLog({
    quoteId: quote.id,
    event: "signed",
    actorEmail: quote.guest_email,
    actorIp: signerIp,
    actorUa: signerUa,
    documentHash: seal,
    metadata: {
      signatureType,
      agreements,
      taxExempt,
      taxFileUrl: taxFileUrl || null,
      signedAt,
    },
  });

  // Post-paid: no deposit step — mark as confirmed and update BMI
  if (quote.approval_required && quote.deposit_due_cents === 0) {
    await q`
      UPDATE group_function_quotes SET
        status = 'deposit_paid',
        deposit_paid_at = ${signedAt},
        updated_at = NOW()
      WHERE id = ${quote.id}
    `;

    try {
      const { updateProjectStatus } = await import("@/lib/bmi-office-actions");
      await updateProjectStatus({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
      });
    } catch (err) {
      console.warn(`[sign] BMI status update failed for post-paid quote ${quote.id}:`, err);
    }

    try {
      const { notifyDepositPaid } = await import("@/lib/group-function-notify");
      const refreshed = await getGfQuoteByShortId(shortId);
      if (refreshed) notifyDepositPaid(refreshed).catch(() => {});
    } catch {
      /* non-fatal */
    }

    console.log(`[sign] post-paid quote ${quote.id} confirmed (no deposit)`);
  }

  firePortalWebhookAsync("document.signed", {
    documentId: quote.contract_short_id,
    bmiCode: quote.bmi_reservation_id,
    venue: quote.center_code,
    status: quote.status,
  });

  return NextResponse.json({ ok: true, seal, signedAt });
}
