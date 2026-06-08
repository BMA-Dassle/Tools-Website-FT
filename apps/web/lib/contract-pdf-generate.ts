import { put } from "@vercel/blob";
import { getGfQuoteByShortId, getAuditLog, appendAuditLog } from "@/lib/group-function-db";
import { generateContractPdf } from "@/lib/contract-pdf";
import { sendEmail } from "@/lib/sendgrid";
import { sql } from "@/lib/db";

/**
 * Generate a signed contract PDF, upload to Vercel Blob, store URL, email guest,
 * and update BMI private notes. Returns the blob URL on success.
 *
 * Designed to be called from multiple server-side routes (deposit, resign-settle,
 * sign post-paid) so PDF generation is never fire-and-forget from the client.
 */
export async function generateAndStorePdf(shortId: string): Promise<string> {
  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) throw new Error(`Quote not found: ${shortId}`);

  const auditLog = await getAuditLog(quote.id);

  // 1. Generate PDF bytes
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateContractPdf(quote, auditLog);
  } catch (err) {
    console.error("[generate-pdf] PDF generation failed:", err);
    await safeAuditLog(quote.id, "pdf_generation_failed", { step: "generate", error: String(err) });
    throw err;
  }

  // 2. Upload to Vercel Blob
  let blobUrl: string;
  try {
    const filename = `contracts/${shortId}-signed.pdf`;
    const blob = await put(filename, Buffer.from(pdfBytes), {
      access: "public",
      contentType: "application/pdf",
    });
    blobUrl = blob.url;
  } catch (err) {
    console.error("[generate-pdf] Blob upload failed:", err);
    await safeAuditLog(quote.id, "pdf_generation_failed", {
      step: "blob_upload",
      error: String(err),
    });
    throw err;
  }

  // 3. Store URL in DB
  try {
    const q = sql();
    await q`UPDATE group_function_quotes SET signed_pdf_url = ${blobUrl}, updated_at = NOW() WHERE id = ${quote.id}`;
  } catch (err) {
    console.error("[generate-pdf] DB update failed:", err);
    await safeAuditLog(quote.id, "pdf_generation_failed", {
      step: "db_update",
      error: String(err),
      url: blobUrl,
    });
    throw err;
  }

  // 4. Audit log — success
  await safeAuditLog(quote.id, "pdf_generated", { url: blobUrl });

  // 5. Email the PDF to guest (non-fatal). Win-backs are intentionally skipped:
  // they get the win-back offer + "$20 e-gift card" receipt emails, so this generic
  // "Signed Contract" email is just confusing noise. The PDF is still generated +
  // stored above (signed_pdf_url) for their records.
  if (!quote.is_winback) {
    try {
      const plannerName = quote.planner_first
        ? `${quote.planner_first} ${quote.planner_last || ""}`.trim()
        : "Your Event Planner";

      const brandDomain = quote.brand === "headpinz" ? "headpinz.com" : "fasttraxent.com";

      await sendEmail({
        to: quote.guest_email,
        toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
        from: quote.planner_email ? { email: quote.planner_email, name: plannerName } : undefined,
        replyTo: quote.planner_email || undefined,
        cc: quote.planner_email || undefined,
        subject: `Signed Contract — ${quote.event_name || quote.center_name}`,
        html: buildPdfEmailHtml(quote, blobUrl, plannerName, brandDomain),
        text: `Hi ${quote.guest_first_name},\n\nYour signed event contract is ready.\n\nDownload: ${blobUrl}\n\nEvent: ${quote.event_name}\nDate: ${quote.event_date_display}\nDeposit: $${(quote.deposit_due_cents / 100).toFixed(2)}\n\nThank you!\n${plannerName}\n${quote.center_name}`,
      });
    } catch (err) {
      console.error("[generate-pdf] Email send failed:", err);
    }
  }

  // 6. Update BMI private notes (non-fatal)
  try {
    const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
    const contractPageUrl = `${quote.base_url || "https://fasttraxent.com"}/contract/${shortId}`;
    const pdfUrl = `${quote.base_url || "https://fasttraxent.com"}/contract/${shortId}/pdf`;
    const ts = noteTimestamp();

    await appendProjectPrivateNote({
      centerCode: quote.center_code,
      projectId: quote.bmi_reservation_id,
      note: `[${ts}] Contract signed`,
      contractUrl: contractPageUrl,
      pdfUrl,
    });
  } catch (err) {
    console.error("[generate-pdf] BMI private note update failed:", err);
  }

  return blobUrl;
}

async function safeAuditLog(quoteId: number, event: string, metadata: Record<string, unknown>) {
  try {
    await appendAuditLog({ quoteId, event, metadata });
  } catch {
    /* truly non-fatal */
  }
}

function buildPdfEmailHtml(
  quote: {
    guest_first_name: string;
    event_name: string | null;
    center_name: string;
    event_date_display: string | null;
    deposit_due_cents: number;
    balance_cents: number;
    planner_phone: string | null;
  },
  blobUrl: string,
  plannerName: string,
  brandDomain: string,
): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#0a1020;color:#e2e8f0">
<div style="max-width:600px;margin:0 auto">
  <div style="background:#0f172a;padding:32px 24px;border-radius:16px 16px 0 0;text-align:center">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:white">Contract Signed!</h1>
    <p style="margin:0;font-size:14px;color:#94a3b8">${quote.event_name || "Your Event"} at ${quote.center_name}</p>
  </div>
  <div style="background:#1e293b;padding:24px;border:1px solid rgba(148,163,184,0.1)">
    <p style="margin:0 0 16px;color:#cbd5e1">Hi ${quote.guest_first_name},</p>
    <p style="margin:0 0 16px;color:#cbd5e1">Your signed event contract is attached below. Keep this for your records.</p>
    <div style="background:#0f172a;border-radius:12px;padding:16px;margin:16px 0">
      <table style="width:100%;font-size:13px;color:#94a3b8">
        <tr><td>Event</td><td style="text-align:right;color:white;font-weight:600">${quote.event_name || ""}</td></tr>
        <tr><td>Date</td><td style="text-align:right;color:white">${quote.event_date_display || ""}</td></tr>
        <tr><td>Deposit Paid</td><td style="text-align:right;color:#22d3ee;font-weight:600">$${(quote.deposit_due_cents / 100).toFixed(2)}</td></tr>
        <tr><td>Balance (72hrs before)</td><td style="text-align:right;color:white">$${(quote.balance_cents / 100).toFixed(2)}</td></tr>
      </table>
    </div>
    <div style="text-align:center;margin:24px 0">
      <a href="${blobUrl}" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#06b6d4,#2563eb);color:white;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px">Download Signed Contract</a>
    </div>
  </div>
  <div style="background:#1e293b;padding:16px 24px;border-radius:0 0 16px 16px;border:1px solid rgba(148,163,184,0.1);border-top:none">
    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#64748b">Your Event Planner</p>
    <p style="margin:0;font-size:14px;font-weight:700;color:white">${plannerName}</p>
    ${quote.planner_phone ? `<p style="margin:0;font-size:12px;color:#22d3ee">${quote.planner_phone}</p>` : ""}
  </div>
  <p style="text-align:center;font-size:11px;color:#475569;margin-top:16px">${quote.center_name} · ${brandDomain}</p>
</div></body></html>`;
}
