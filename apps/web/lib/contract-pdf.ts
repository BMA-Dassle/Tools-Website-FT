import { PDFDocument, rgb, StandardFonts, PDFPage, PDFFont } from "pdf-lib";
import type { GroupFunctionQuote, AuditLogEntry } from "@/lib/group-function-db";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const COLORS = {
  darkBg: rgb(0.03, 0.06, 0.12),
  cardBg: rgb(0.027, 0.063, 0.153),
  cyan: rgb(0.13, 0.83, 0.91),
  white: rgb(1, 1, 1),
  gray: rgb(0.58, 0.64, 0.72),
  lightGray: rgb(0.78, 0.82, 0.86),
  emerald: rgb(0.13, 0.83, 0.53),
  line: rgb(1, 1, 1),
  red: rgb(0.9, 0.22, 0.21),
};

interface DrawCtx {
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  y: number;
  margin: number;
  width: number;
}

function drawRect(
  page: PDFPage,
  x: number,
  y: number,
  w: number,
  h: number,
  color: ReturnType<typeof rgb>,
) {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

function drawLine(
  page: PDFPage,
  x1: number,
  y1: number,
  x2: number,
  color: ReturnType<typeof rgb>,
) {
  page.drawLine({
    start: { x: x1, y: y1 },
    end: { x: x2, y: y1 },
    thickness: 0.5,
    color,
    opacity: 0.15,
  });
}

function text(
  ctx: DrawCtx,
  str: string,
  x: number,
  y: number,
  opts?: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> },
) {
  ctx.page.drawText(str, {
    x,
    y,
    font: opts?.font || ctx.font,
    size: opts?.size || 10,
    color: opts?.color || COLORS.white,
  });
}

function sectionLabel(ctx: DrawCtx, label: string) {
  text(ctx, label, ctx.margin, ctx.y, { font: ctx.fontBold, size: 8, color: COLORS.cyan });
  ctx.y -= 16;
}

function newPage(doc: PDFDocument, ctx: DrawCtx): DrawCtx {
  const page = doc.addPage([612, 792]);
  drawRect(page, 0, 0, 612, 792, COLORS.darkBg);
  return { ...ctx, page, y: 742 };
}

export async function generateContractPdf(
  quote: GroupFunctionQuote,
  auditLog: AuditLogEntry[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 50;
  const contentWidth = 512;
  const rightEdge = margin + contentWidth;

  let ctx: DrawCtx = { page: null!, font, fontBold, y: 742, margin, width: contentWidth };

  // ── Page 1: Contract Summary ──────────────────────────────

  const p1 = doc.addPage([612, 792]);
  drawRect(p1, 0, 0, 612, 792, COLORS.darkBg);
  ctx.page = p1;

  // Header bar
  drawRect(p1, 0, 742, 612, 50, COLORS.cardBg);
  drawRect(p1, 0, 742, 612, 2, COLORS.cyan);
  text(ctx, "EVENT CONTRACT", margin, 764, { font: fontBold, size: 20, color: COLORS.white });
  text(ctx, quote.center_name.toUpperCase(), margin, 750, { size: 9, color: COLORS.cyan });

  ctx.y = 720;

  // Event Details Card
  drawRect(p1, margin - 10, ctx.y - 110, contentWidth + 20, 120, COLORS.cardBg);
  ctx.y -= 6;
  sectionLabel(ctx, "EVENT DETAILS");

  const details: [string, string][] = [
    ["Event", quote.event_name || ""],
    ["Date", quote.event_date_display || ""],
    ["Center", quote.center_name],
    ["Guests", String(quote.guest_count || "—")],
  ];
  for (const [label, value] of details) {
    text(ctx, label, margin, ctx.y, { size: 9, color: COLORS.gray });
    text(ctx, value, margin + 110, ctx.y, { font: fontBold, size: 10, color: COLORS.white });
    ctx.y -= 16;
  }

  ctx.y -= 16;

  // Pricing Card
  const lineItems = (quote.line_items || []) as Array<{
    name: string;
    price: number;
    qty: number;
    total: number;
  }>;
  const pricingHeight = 24 + lineItems.length * 18 + (quote.tax_cents > 0 ? 18 : 0) + 28;
  drawRect(
    p1,
    margin - 10,
    ctx.y - pricingHeight,
    contentWidth + 20,
    pricingHeight + 8,
    COLORS.cardBg,
  );
  ctx.y -= 2;
  sectionLabel(ctx, "PRICING");

  for (const item of lineItems) {
    text(ctx, `${item.name}`, margin, ctx.y, { size: 9, color: COLORS.lightGray });
    text(ctx, `x${item.qty}`, margin + 300, ctx.y, { size: 9, color: COLORS.gray });
    const dollarStr = dollars(Math.round(item.total * 100));
    const dollarWidth = fontBold.widthOfTextAtSize(dollarStr, 10);
    text(ctx, dollarStr, rightEdge - dollarWidth, ctx.y, {
      font: fontBold,
      size: 10,
      color: COLORS.white,
    });
    ctx.y -= 18;
  }

  if (quote.tax_cents > 0) {
    text(ctx, "Tax", margin, ctx.y, { size: 9, color: COLORS.gray });
    const taxStr = dollars(quote.tax_cents);
    const taxWidth = font.widthOfTextAtSize(taxStr, 10);
    text(ctx, taxStr, rightEdge - taxWidth, ctx.y, { size: 10, color: COLORS.lightGray });
    ctx.y -= 18;
  }

  drawLine(p1, margin, ctx.y + 8, rightEdge, COLORS.white);

  text(ctx, "Total", margin, ctx.y, { font: fontBold, size: 11, color: COLORS.white });
  const totalStr = dollars(quote.total_cents);
  const totalWidth = fontBold.widthOfTextAtSize(totalStr, 13);
  text(ctx, totalStr, rightEdge - totalWidth, ctx.y - 1, {
    font: fontBold,
    size: 13,
    color: COLORS.cyan,
  });
  ctx.y -= 26;

  // Payment Schedule Card
  ctx.y -= 8;
  drawRect(p1, margin - 10, ctx.y - 60, contentWidth + 20, 68, COLORS.cardBg);
  ctx.y -= 2;
  sectionLabel(ctx, "PAYMENT SCHEDULE");

  text(ctx, "50% Deposit (due at signing)", margin, ctx.y, { size: 9, color: COLORS.lightGray });
  const depStr = dollars(quote.deposit_due_cents);
  const depWidth = fontBold.widthOfTextAtSize(depStr, 10);
  text(ctx, depStr, rightEdge - depWidth, ctx.y, {
    font: fontBold,
    size: 10,
    color: COLORS.emerald,
  });
  ctx.y -= 16;

  text(ctx, "Remaining Balance (72 hours before event)", margin, ctx.y, {
    size: 9,
    color: COLORS.lightGray,
  });
  const balStr = dollars(quote.balance_cents);
  const balWidth = font.widthOfTextAtSize(balStr, 10);
  text(ctx, balStr, rightEdge - balWidth, ctx.y, { size: 10, color: COLORS.white });
  ctx.y -= 24;

  // Planner + Customer
  ctx.y -= 8;
  const infoHeight =
    90 + (quote.notes ? Math.min((quote.notes.split("\n").length + 1) * 12, 80) + 20 : 0);
  drawRect(p1, margin - 10, ctx.y - infoHeight, contentWidth / 2, infoHeight + 8, COLORS.cardBg);
  drawRect(
    p1,
    margin + contentWidth / 2 + 6,
    ctx.y - infoHeight,
    contentWidth / 2,
    infoHeight + 8,
    COLORS.cardBg,
  );
  ctx.y -= 2;

  // Planner column
  text(ctx, "EVENT PLANNER", margin, ctx.y, { font: fontBold, size: 8, color: COLORS.cyan });
  ctx.y -= 14;
  text(ctx, `${quote.planner_first || ""} ${quote.planner_last || ""}`.trim(), margin, ctx.y, {
    font: fontBold,
    size: 10,
    color: COLORS.white,
  });
  ctx.y -= 14;
  if (quote.planner_email) {
    text(ctx, quote.planner_email, margin, ctx.y, { size: 8, color: COLORS.gray });
    ctx.y -= 12;
  }
  if (quote.planner_phone) {
    text(ctx, quote.planner_phone, margin, ctx.y, { size: 8, color: COLORS.gray });
    ctx.y -= 12;
  }

  // Customer column (same y positions)
  const custX = margin + contentWidth / 2 + 16;
  let custY = ctx.y + (quote.planner_phone ? 12 : 0) + (quote.planner_email ? 12 : 0) + 14 + 14 + 2;
  text(ctx, "CUSTOMER", custX, custY, { font: fontBold, size: 8, color: COLORS.cyan });
  custY -= 14;
  text(ctx, `${quote.guest_first_name} ${quote.guest_last_name}`, custX, custY, {
    font: fontBold,
    size: 10,
    color: COLORS.white,
  });
  custY -= 14;
  text(ctx, quote.guest_email, custX, custY, { size: 8, color: COLORS.gray });
  custY -= 12;
  if (quote.guest_phone) {
    text(ctx, quote.guest_phone, custX, custY, { size: 8, color: COLORS.gray });
  }

  // Planner notes
  if (quote.notes) {
    ctx.y -= 12;
    text(ctx, "PLANNER NOTES", margin, ctx.y, { font: fontBold, size: 8, color: COLORS.cyan });
    ctx.y -= 14;
    const noteLines = quote.notes.split("\n").slice(0, 6);
    for (const line of noteLines) {
      if (ctx.y < 60) break;
      text(ctx, line.slice(0, 90), margin, ctx.y, { size: 8, color: COLORS.lightGray });
      ctx.y -= 12;
    }
  }

  // Footer seal
  if (quote.document_seal) {
    drawRect(p1, 0, 0, 612, 28, COLORS.cardBg);
    drawRect(p1, 0, 28, 612, 1, COLORS.cyan);
    text(ctx, `Document Seal: ${quote.document_seal.slice(0, 48)}...`, margin, 10, {
      size: 7,
      color: COLORS.cyan,
    });
  }

  // ── Page 2: Signature + Agreements ────────────────────────

  ctx = newPage(doc, ctx);

  // Header
  drawRect(ctx.page, 0, 742, 612, 50, COLORS.cardBg);
  drawRect(ctx.page, 0, 742, 612, 2, COLORS.cyan);
  text(ctx, "SIGNATURE & AGREEMENTS", margin, 764, {
    font: fontBold,
    size: 20,
    color: COLORS.white,
  });
  ctx.y = 710;

  // Agreements card
  const agreements = [
    "I agree to make a 50% deposit via credit card after completing this document.",
    "I understand the remaining balance will be automatically charged 72 hours prior.",
    "I understand that waivers are required for all participants.",
    "I have read and understand the event information.",
    "I have read and agree to the cancellation policy.",
  ];

  drawRect(
    ctx.page,
    margin - 10,
    ctx.y - (agreements.length * 18 + 24),
    contentWidth + 20,
    agreements.length * 18 + 28,
    COLORS.cardBg,
  );
  sectionLabel(ctx, "AGREEMENTS");
  for (const t of agreements) {
    text(ctx, "✓", margin, ctx.y, { font: fontBold, size: 10, color: COLORS.emerald });
    text(ctx, t, margin + 16, ctx.y, { size: 9, color: COLORS.lightGray });
    ctx.y -= 18;
  }

  ctx.y -= 16;

  // Tax exempt
  drawRect(ctx.page, margin - 10, ctx.y - 30, contentWidth + 20, 38, COLORS.cardBg);
  sectionLabel(ctx, "TAX EXEMPT");
  text(ctx, "Status: Declared at signing", margin, ctx.y, {
    size: 9,
    color: COLORS.lightGray,
  });
  ctx.y -= 32;

  // Signature card
  ctx.y -= 8;
  const sigCardH = 100;
  drawRect(ctx.page, margin - 10, ctx.y - sigCardH, contentWidth + 20, sigCardH + 8, COLORS.cardBg);
  ctx.y -= 2;
  sectionLabel(ctx, "SIGNATURE");

  text(ctx, `Method: ${quote.signature_type === "draw" ? "Drawn" : "Typed"}`, margin, ctx.y, {
    size: 8,
    color: COLORS.gray,
  });
  ctx.y -= 18;

  if (quote.signature_type === "typed" && quote.signature_data) {
    text(ctx, quote.signature_data, margin, ctx.y, {
      font: fontBold,
      size: 22,
      color: COLORS.cyan,
    });
    ctx.y -= 30;
  } else if (quote.signature_type === "draw") {
    text(ctx, "[Drawn signature on file]", margin, ctx.y, { size: 10, color: COLORS.cyan });
    ctx.y -= 20;
  }

  text(ctx, `Signed: ${quote.contract_signed_at || "—"}`, margin, ctx.y, {
    size: 8,
    color: COLORS.gray,
  });
  ctx.y -= 12;
  if (quote.signer_ip) {
    text(ctx, `IP: ${quote.signer_ip}`, margin, ctx.y, { size: 7, color: COLORS.gray });
    ctx.y -= 10;
  }
  if (quote.signer_ua) {
    text(ctx, `UA: ${quote.signer_ua.slice(0, 80)}`, margin, ctx.y, {
      size: 6,
      color: COLORS.gray,
    });
    ctx.y -= 10;
  }

  // Document seal card
  if (quote.document_seal) {
    ctx.y -= 16;
    drawRect(ctx.page, margin - 10, ctx.y - 36, contentWidth + 20, 44, COLORS.cardBg);
    ctx.y -= 2;
    sectionLabel(ctx, "DOCUMENT SEAL (SHA-256)");
    text(ctx, quote.document_seal, margin, ctx.y, { size: 7, color: COLORS.cyan });
    ctx.y -= 20;
  }

  // ESIGN compliance
  ctx.y -= 12;
  text(
    ctx,
    "This document was electronically signed in compliance with the ESIGN Act (15 U.S.C. §7001) and UETA.",
    margin,
    ctx.y,
    { size: 7, color: COLORS.gray },
  );
  ctx.y -= 10;
  text(
    ctx,
    "The signer's IP address, user agent, and timestamp were captured for verification purposes.",
    margin,
    ctx.y,
    { size: 7, color: COLORS.gray },
  );

  // Footer seal
  if (quote.document_seal) {
    drawRect(ctx.page, 0, 0, 612, 28, COLORS.cardBg);
    drawRect(ctx.page, 0, 28, 612, 1, COLORS.cyan);
    text(ctx, `Document Seal: ${quote.document_seal.slice(0, 48)}...`, margin, 10, {
      size: 7,
      color: COLORS.cyan,
    });
  }

  // ── Page 3: Audit Trail ───────────────────────────────────

  if (auditLog.length > 0) {
    ctx = newPage(doc, ctx);

    drawRect(ctx.page, 0, 742, 612, 50, COLORS.cardBg);
    drawRect(ctx.page, 0, 742, 612, 2, COLORS.cyan);
    text(ctx, "AUDIT TRAIL", margin, 764, { font: fontBold, size: 20, color: COLORS.white });
    ctx.y = 710;

    sectionLabel(ctx, "CHRONOLOGICAL EVENT LOG");

    // Header row
    text(ctx, "TIMESTAMP", margin, ctx.y, { font: fontBold, size: 7, color: COLORS.gray });
    text(ctx, "EVENT", margin + 160, ctx.y, { font: fontBold, size: 7, color: COLORS.gray });
    text(ctx, "ACTOR", margin + 320, ctx.y, { font: fontBold, size: 7, color: COLORS.gray });
    text(ctx, "IP", margin + 440, ctx.y, { font: fontBold, size: 7, color: COLORS.gray });
    ctx.y -= 14;
    drawLine(ctx.page, margin, ctx.y + 6, rightEdge, COLORS.white);

    for (const entry of auditLog) {
      if (ctx.y < 60) {
        ctx = newPage(doc, ctx);
        drawRect(ctx.page, 0, 742, 612, 50, COLORS.cardBg);
        drawRect(ctx.page, 0, 742, 612, 2, COLORS.cyan);
        text(ctx, "AUDIT TRAIL (continued)", margin, 764, {
          font: fontBold,
          size: 20,
          color: COLORS.white,
        });
        ctx.y = 710;
      }

      const ts = new Date(entry.created_at).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      text(ctx, ts, margin, ctx.y, { size: 8, color: COLORS.lightGray });
      text(ctx, entry.event, margin + 160, ctx.y, { font: fontBold, size: 8, color: COLORS.white });
      if (entry.actor_email) {
        text(ctx, entry.actor_email, margin + 320, ctx.y, { size: 7, color: COLORS.gray });
      }
      if (entry.actor_ip) {
        text(ctx, entry.actor_ip, margin + 440, ctx.y, { size: 7, color: COLORS.gray });
      }
      ctx.y -= 14;
    }

    // Footer seal
    if (quote.document_seal) {
      drawRect(ctx.page, 0, 0, 612, 28, COLORS.cardBg);
      drawRect(ctx.page, 0, 28, 612, 1, COLORS.cyan);
      text(ctx, `Document Seal: ${quote.document_seal.slice(0, 48)}...`, margin, 10, {
        size: 7,
        color: COLORS.cyan,
      });
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
