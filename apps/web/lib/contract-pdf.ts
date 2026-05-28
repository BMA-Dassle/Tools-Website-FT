import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { GroupFunctionQuote, AuditLogEntry } from "@/lib/group-function-db";

/**
 * Generate a tamper-evident PDF contract with:
 * - Event details + line items
 * - Agreement checkboxes + signature
 * - Document seal (SHA-256)
 * - Full audit trail
 */

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function generateContractPdf(
  quote: GroupFunctionQuote,
  auditLog: AuditLogEntry[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontSize = 10;
  const lineHeight = 14;
  const margin = 50;

  const dark = rgb(0.06, 0.09, 0.16);
  const gray = rgb(0.5, 0.5, 0.55);
  const white = rgb(1, 1, 1);
  const cyan = rgb(0.13, 0.83, 0.91);

  // ── Page 1: Contract Summary ──────────────────────────────

  let page = doc.addPage([612, 792]);
  let y = 742;

  const drawText = (text: string, x: number, yPos: number, options?: { font?: typeof font; size?: number; color?: typeof dark }) => {
    page.drawText(text, { x, y: yPos, font: options?.font || font, size: options?.size || fontSize, color: options?.color || dark });
  };

  // Header
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: dark });
  drawText("Event Contract", margin, 762, { font: fontBold, size: 18, color: white });
  drawText(quote.center_name, margin, 748, { size: 9, color: cyan });

  y = 720;
  drawText("EVENT DETAILS", margin, y, { font: fontBold, size: 11 });
  y -= 20;

  const details = [
    ["Event", quote.event_name || ""],
    ["Date", quote.event_date_display || ""],
    ["Center", quote.center_name],
    ["Guest Count", String(quote.guest_count || "")],
  ];
  for (const [label, value] of details) {
    drawText(label, margin, y, { color: gray, size: 9 });
    drawText(value, margin + 100, y, { font: fontBold });
    y -= lineHeight;
  }

  y -= 10;
  drawText("PRICING", margin, y, { font: fontBold, size: 11 });
  y -= 18;

  const lineItems = (quote.line_items || []) as Array<{ name: string; price: number; qty: number; total: number }>;
  for (const item of lineItems) {
    drawText(`${item.name} x${item.qty}`, margin, y);
    drawText(dollars(Math.round(item.total * 100)), 500, y, { font: fontBold });
    y -= lineHeight;
  }
  if (quote.tax_cents > 0) {
    drawText("Tax", margin, y, { color: gray });
    drawText(dollars(quote.tax_cents), 500, y);
    y -= lineHeight;
  }
  page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: 562, y: y + 4 }, thickness: 0.5, color: gray });
  drawText("Total", margin, y - 4, { font: fontBold });
  drawText(dollars(quote.total_cents), 500, y - 4, { font: fontBold });
  y -= 24;

  drawText("PAYMENT SCHEDULE", margin, y, { font: fontBold, size: 11 });
  y -= 18;
  drawText("50% Deposit (due at signing)", margin, y);
  drawText(dollars(quote.deposit_due_cents), 500, y, { font: fontBold });
  y -= lineHeight;
  drawText("Remaining Balance (72 hours before event)", margin, y);
  drawText(dollars(quote.balance_cents), 500, y);
  y -= 24;

  // Planner + Customer
  drawText("EVENT PLANNER", margin, y, { font: fontBold, size: 11 });
  y -= 16;
  drawText(`${quote.planner_first || ""} ${quote.planner_last || ""}`.trim(), margin, y);
  y -= lineHeight;
  if (quote.planner_email) { drawText(quote.planner_email, margin, y, { color: gray }); y -= lineHeight; }
  if (quote.planner_phone) { drawText(quote.planner_phone, margin, y, { color: gray }); y -= lineHeight; }

  y -= 10;
  drawText("CUSTOMER", margin, y, { font: fontBold, size: 11 });
  y -= 16;
  drawText(`${quote.guest_first_name} ${quote.guest_last_name}`, margin, y);
  y -= lineHeight;
  drawText(quote.guest_email, margin, y, { color: gray });
  y -= lineHeight;
  if (quote.guest_phone) { drawText(quote.guest_phone, margin, y, { color: gray }); y -= lineHeight; }

  // Planner notes
  if (quote.notes) {
    y -= 16;
    drawText("PLANNER NOTES", margin, y, { font: fontBold, size: 11 });
    y -= 16;
    const noteLines = quote.notes.split("\n").slice(0, 8);
    for (const line of noteLines) {
      if (y < 60) break;
      drawText(line.slice(0, 90), margin, y, { size: 9, color: gray });
      y -= 12;
    }
  }

  // Footer
  if (quote.document_seal) {
    page.drawRectangle({ x: 0, y: 0, width: 612, height: 30, color: dark });
    drawText(`Document Seal: ${quote.document_seal.slice(0, 32)}...`, margin, 10, { size: 7, color: cyan });
  }

  // ── Page 2: Signature + Agreements ────────────────────────

  page = doc.addPage([612, 792]);
  y = 742;

  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: dark });
  drawText("Signature & Agreements", margin, 762, { font: fontBold, size: 18, color: white });

  y = 710;
  drawText("AGREEMENTS", margin, y, { font: fontBold, size: 11 });
  y -= 18;

  const agreements = [
    "I agree to make a 50% deposit via credit card after completing this document.",
    "I understand the remaining balance will be automatically charged 72 hours prior.",
    "I understand that waivers are required for all participants.",
    "I have read and understand the event information.",
    "I have read and agree to the cancellation policy.",
  ];
  for (const text of agreements) {
    drawText("[x]  " + text, margin, y, { size: 9 });
    y -= 14;
  }

  y -= 10;
  drawText("TAX EXEMPT", margin, y, { font: fontBold, size: 11 });
  y -= 16;
  drawText(`Tax Exempt: ${quote.signature_type ? "Declared at signing" : "N/A"}`, margin, y, { size: 9 });
  y -= 24;

  drawText("SIGNATURE", margin, y, { font: fontBold, size: 11 });
  y -= 18;
  drawText(`Type: ${quote.signature_type || "typed"}`, margin, y, { size: 9, color: gray });
  y -= lineHeight;
  if (quote.signature_type === "typed" && quote.signature_data) {
    drawText(quote.signature_data, margin, y, { font: fontBold, size: 20 });
    y -= 30;
  }
  drawText(`Signed at: ${quote.contract_signed_at || ""}`, margin, y, { size: 9, color: gray });
  y -= lineHeight;
  if (quote.signer_ip) {
    drawText(`IP: ${quote.signer_ip}`, margin, y, { size: 8, color: gray });
    y -= 12;
  }
  if (quote.signer_ua) {
    drawText(`User Agent: ${quote.signer_ua.slice(0, 80)}`, margin, y, { size: 7, color: gray });
    y -= 12;
  }

  // Seal
  y -= 16;
  drawText("DOCUMENT SEAL (SHA-256)", margin, y, { font: fontBold, size: 11 });
  y -= 16;
  if (quote.document_seal) {
    drawText(quote.document_seal, margin, y, { size: 8, color: cyan });
  }

  // Footer
  if (quote.document_seal) {
    page.drawRectangle({ x: 0, y: 0, width: 612, height: 30, color: dark });
    drawText(`Document Seal: ${quote.document_seal.slice(0, 32)}...`, margin, 10, { size: 7, color: cyan });
  }

  // ── Page 3: Audit Trail ───────────────────────────────────

  if (auditLog.length > 0) {
    page = doc.addPage([612, 792]);
    y = 742;

    page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: dark });
    drawText("Audit Trail", margin, 762, { font: fontBold, size: 18, color: white });

    y = 710;
    drawText("CHRONOLOGICAL EVENT LOG", margin, y, { font: fontBold, size: 11 });
    y -= 18;

    for (const entry of auditLog) {
      if (y < 60) {
        page = doc.addPage([612, 792]);
        y = 742;
      }
      const ts = new Date(entry.created_at).toLocaleString("en-US", { timeZone: "America/New_York" });
      drawText(ts, margin, y, { size: 8, color: gray });
      drawText(entry.event, margin + 160, y, { font: fontBold, size: 9 });
      if (entry.actor_email) {
        drawText(entry.actor_email, margin + 320, y, { size: 8, color: gray });
      }
      if (entry.actor_ip) {
        drawText(entry.actor_ip, margin + 460, y, { size: 7, color: gray });
      }
      y -= 12;
    }

    // Footer
    if (quote.document_seal) {
      page.drawRectangle({ x: 0, y: 0, width: 612, height: 30, color: dark });
      drawText(`Document Seal: ${quote.document_seal.slice(0, 32)}...`, margin, 10, { size: 7, color: cyan });
    }
  }

  // Metadata
  doc.setTitle(`Event Contract - ${quote.event_name || ""}`);
  doc.setSubject(`Contract for ${quote.guest_first_name} ${quote.guest_last_name}`);
  doc.setCreator("FastTrax Entertainment / HeadPinz");
  if (quote.document_seal) {
    doc.setKeywords([`seal:${quote.document_seal}`]);
  }

  return doc.save();
}
