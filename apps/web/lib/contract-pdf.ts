import { PDFDocument, rgb, StandardFonts, PDFPage, PDFFont } from "pdf-lib";
import type { GroupFunctionQuote, AuditLogEntry } from "@/lib/group-function-db";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const C = {
  bg: rgb(0.04, 0.06, 0.12),
  card: rgb(0.03, 0.07, 0.16),
  cyan: rgb(0.13, 0.83, 0.91),
  white: rgb(1, 1, 1),
  gray: rgb(0.55, 0.6, 0.68),
  lightGray: rgb(0.75, 0.8, 0.85),
  emerald: rgb(0.13, 0.83, 0.53),
  stripe: rgb(0.05, 0.09, 0.2),
  red: rgb(0.9, 0.22, 0.21),
  amber: rgb(0.96, 0.62, 0.04),
};

const PAGE_W = 612;
const PAGE_H = 792;
const M = 48;
const CW = PAGE_W - M * 2;
const RE = M + CW;
const CARD_PAD = 14;
const CARD_X = M - CARD_PAD;
const CARD_W = CW + CARD_PAD * 2;

interface Ctx {
  page: PDFPage;
  f: PDFFont;
  fb: PDFFont;
  fi: PDFFont;
  y: number;
}

function addBgPage(doc: PDFDocument, ctx: Ctx): Ctx {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: C.bg });
  return { ...ctx, page, y: PAGE_H - 50 };
}

function card(ctx: Ctx, h: number) {
  ctx.page.drawRectangle({
    x: CARD_X,
    y: ctx.y - h,
    width: CARD_W,
    height: h,
    color: C.card,
    borderColor: rgb(1, 1, 1),
    borderWidth: 0,
    opacity: 1,
  });
}

function stripe(ctx: Ctx, h: number) {
  ctx.page.drawRectangle({ x: CARD_X, y: ctx.y - h, width: CARD_W, height: h, color: C.stripe });
}

function sep(ctx: Ctx) {
  ctx.page.drawLine({
    start: { x: M, y: ctx.y },
    end: { x: RE, y: ctx.y },
    thickness: 0.5,
    color: C.white,
    opacity: 0.08,
  });
}

function t(
  ctx: Ctx,
  s: string,
  x: number,
  y: number,
  opts?: { font?: PDFFont; sz?: number; color?: ReturnType<typeof rgb> },
) {
  ctx.page.drawText(s, {
    x,
    y,
    font: opts?.font ?? ctx.f,
    size: opts?.sz ?? 10,
    color: opts?.color ?? C.white,
  });
}

function tRight(ctx: Ctx, s: string, y: number, opts?: { font?: PDFFont; sz?: number; color?: ReturnType<typeof rgb> }) {
  const fnt = opts?.font ?? ctx.f;
  const sz = opts?.sz ?? 10;
  const w = fnt.widthOfTextAtSize(s, sz);
  t(ctx, s, RE - w, y, opts);
}

function label(ctx: Ctx, s: string) {
  t(ctx, s, M, ctx.y, { font: ctx.fb, sz: 8.5, color: C.cyan });
  ctx.y -= 18;
}

function pageHeader(ctx: Ctx, title: string, subtitle?: string) {
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 50, width: PAGE_W, height: 50, color: C.card });
  // Accent line
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 50, width: PAGE_W, height: 2, color: C.cyan });
  // Red/white/cyan gradient stripe at very top
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 2, width: PAGE_W / 3, height: 2, color: C.red });
  ctx.page.drawRectangle({ x: PAGE_W / 3, y: PAGE_H - 2, width: PAGE_W / 3, height: 2, color: rgb(1, 1, 1) });
  ctx.page.drawRectangle({ x: (PAGE_W * 2) / 3, y: PAGE_H - 2, width: PAGE_W / 3, height: 2, color: C.cyan });

  t(ctx, title, M, PAGE_H - 30, { font: ctx.fb, sz: 18, color: C.white });
  if (subtitle) {
    t(ctx, subtitle, M, PAGE_H - 44, { sz: 9, color: C.cyan });
  }
  ctx.y = PAGE_H - 66;
}

function pageFooter(ctx: Ctx, seal: string | null, pageNum: number, totalPages: number) {
  ctx.page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 32, color: C.card });
  ctx.page.drawRectangle({ x: 0, y: 32, width: PAGE_W, height: 1, color: C.cyan, opacity: 0.3 });
  if (seal) {
    t(ctx, `Seal: ${seal.slice(0, 40)}...`, M, 12, { sz: 6.5, color: C.cyan });
  }
  const pg = `Page ${pageNum} of ${totalPages}`;
  const pgW = ctx.f.widthOfTextAtSize(pg, 7);
  t(ctx, pg, RE - pgW, 12, { sz: 7, color: C.gray });
}

export async function generateContractPdf(
  quote: GroupFunctionQuote,
  auditLog: AuditLogEntry[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const fi = await doc.embedFont(StandardFonts.HelveticaOblique);

  const lineItems = (quote.line_items || []) as Array<{
    name: string;
    price: number;
    qty: number;
    total: number;
  }>;
  const seal = quote.document_seal || null;
  const totalPages = 2 + (auditLog.length > 0 ? 1 : 0);

  let ctx: Ctx = { page: null!, f, fb, fi, y: 0 };

  // ═══════════════════════════════════════════════════════════
  // PAGE 1 — Contract Summary
  // ═══════════════════════════════════════════════════════════

  ctx = addBgPage(doc, ctx);
  pageHeader(ctx, "EVENT CONTRACT", quote.center_name.toUpperCase());

  // ── Event Details ──
  const detailRows: [string, string][] = [
    ["Event", quote.event_name || ""],
    ["Date & Time", quote.event_date_display || ""],
    ["Location", quote.center_name],
    ["Guest Count", String(quote.guest_count || "—")],
  ];
  const detailH = 18 + detailRows.length * 18 + 8;
  card(ctx, detailH);
  ctx.y -= 4;
  label(ctx, "EVENT DETAILS");
  for (const [lbl, val] of detailRows) {
    t(ctx, lbl, M, ctx.y, { sz: 9, color: C.gray });
    t(ctx, val, M + 120, ctx.y, { font: fb, sz: 10, color: C.white });
    ctx.y -= 18;
  }
  ctx.y -= 8;

  // ── Pricing Table ──
  const pricingRows = lineItems.length + (quote.tax_cents > 0 ? 1 : 0);
  const tableRowH = 20;
  const pricingH = 18 + pricingRows * tableRowH + 30;
  card(ctx, pricingH);
  ctx.y -= 4;
  label(ctx, "PRICING");

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    if (i % 2 === 1) stripe(ctx, tableRowH);
    t(ctx, item.name, M + 4, ctx.y - 6, { sz: 9, color: C.lightGray });
    t(ctx, `x${item.qty}`, M + 320, ctx.y - 6, { sz: 9, color: C.gray });
    tRight(ctx, dollars(Math.round(item.total * 100)), ctx.y - 6, { font: fb, sz: 10, color: C.white });
    ctx.y -= tableRowH;
  }
  if (quote.tax_cents > 0) {
    if (lineItems.length % 2 === 1) stripe(ctx, tableRowH);
    t(ctx, "Tax", M + 4, ctx.y - 6, { sz: 9, color: C.gray });
    tRight(ctx, dollars(quote.tax_cents), ctx.y - 6, { sz: 10, color: C.lightGray });
    ctx.y -= tableRowH;
  }

  // Total row
  sep(ctx);
  ctx.y -= 4;
  t(ctx, "Total", M + 4, ctx.y - 6, { font: fb, sz: 12, color: C.white });
  tRight(ctx, dollars(quote.total_cents), ctx.y - 6, { font: fb, sz: 14, color: C.cyan });
  ctx.y -= 22;

  // ── Payment Schedule ──
  ctx.y -= 6;
  card(ctx, 66);
  ctx.y -= 4;
  label(ctx, "PAYMENT SCHEDULE");

  t(ctx, "50% Deposit — Due at Signing", M, ctx.y, { sz: 9, color: C.lightGray });
  tRight(ctx, dollars(quote.deposit_due_cents), ctx.y, { font: fb, sz: 11, color: C.emerald });
  ctx.y -= 18;
  t(ctx, "Remaining Balance — 72 Hours Before Event", M, ctx.y, { sz: 9, color: C.lightGray });
  tRight(ctx, dollars(quote.balance_cents), ctx.y, { font: fb, sz: 11, color: C.white });
  ctx.y -= 22;

  // ── Planner & Customer (side by side) ──
  ctx.y -= 6;
  const colW = (CW - 16) / 2;
  const col2X = M + colW + 16;
  const contactH = 76;
  // Left card
  ctx.page.drawRectangle({ x: CARD_X, y: ctx.y - contactH, width: colW + CARD_PAD + 8, height: contactH, color: C.card });
  // Right card
  ctx.page.drawRectangle({ x: col2X - 8, y: ctx.y - contactH, width: colW + CARD_PAD + 8, height: contactH, color: C.card });

  let ly = ctx.y - 4;
  t(ctx, "EVENT PLANNER", M, ly, { font: fb, sz: 8.5, color: C.cyan });
  ly -= 16;
  t(ctx, `${quote.planner_first || ""} ${quote.planner_last || ""}`.trim() || "—", M, ly, { font: fb, sz: 10, color: C.white });
  ly -= 14;
  if (quote.planner_email) { t(ctx, quote.planner_email, M, ly, { sz: 8, color: C.gray }); ly -= 12; }
  if (quote.planner_phone) { t(ctx, quote.planner_phone, M, ly, { sz: 8, color: C.gray }); }

  let ry = ctx.y - 4;
  t(ctx, "CUSTOMER", col2X, ry, { font: fb, sz: 8.5, color: C.cyan });
  ry -= 16;
  t(ctx, `${quote.guest_first_name} ${quote.guest_last_name}`, col2X, ry, { font: fb, sz: 10, color: C.white });
  ry -= 14;
  t(ctx, quote.guest_email, col2X, ry, { sz: 8, color: C.gray });
  ry -= 12;
  if (quote.guest_phone) { t(ctx, quote.guest_phone, col2X, ry, { sz: 8, color: C.gray }); }

  ctx.y -= contactH + 6;

  // ── Planner Notes ──
  if (quote.notes) {
    const noteLines = quote.notes.split("\n").filter(Boolean).slice(0, 8);
    const notesH = 18 + noteLines.length * 13 + 6;
    card(ctx, notesH);
    ctx.y -= 4;
    label(ctx, "PLANNER NOTES");
    for (const line of noteLines) {
      if (ctx.y < 50) break;
      t(ctx, line.slice(0, 95), M, ctx.y, { sz: 8.5, color: C.lightGray });
      ctx.y -= 13;
    }
    ctx.y -= 6;
  }

  // ── Cancellation Policy Summary ──
  if (ctx.y > 140) {
    const policyH = 70;
    card(ctx, policyH);
    ctx.y -= 4;
    label(ctx, "CANCELLATION POLICY HIGHLIGHTS");
    const policies = [
      ["7+ days notice:", "Deposit applied toward rescheduling (must meet or exceed original value)"],
      ["Within 7 days:", "Non-refundable; 50% deposit credit may be available"],
      ["Guest changes:", "3+ business days notice; count may increase but not decrease >15%"],
    ];
    for (const [head, body] of policies) {
      t(ctx, head, M, ctx.y, { font: fb, sz: 8, color: C.amber });
      t(ctx, body, M + 90, ctx.y, { sz: 8, color: C.lightGray });
      ctx.y -= 14;
    }
  }

  pageFooter(ctx, seal, 1, totalPages);

  // ═══════════════════════════════════════════════════════════
  // PAGE 2 — Signature & Agreements
  // ═══════════════════════════════════════════════════════════

  ctx = addBgPage(doc, ctx);
  pageHeader(ctx, "SIGNATURE & AGREEMENTS", quote.center_name.toUpperCase());

  // ── Agreements ──
  const agreeItems = [
    "I agree to make a 50% deposit via credit card after completing this document.",
    "I understand the remaining balance will be automatically charged 72 hours prior to the event.",
    "I understand that waivers are required for all participants in waiver-required activities.",
    "I have read and understand the event information and helpful tips provided.",
    "I have read and agree to the cancellation policy.",
  ];

  const agreeH = 18 + agreeItems.length * 20 + 6;
  card(ctx, agreeH);
  ctx.y -= 4;
  label(ctx, "AGREEMENTS");
  for (const txt of agreeItems) {
    t(ctx, "✓", M, ctx.y, { font: fb, sz: 11, color: C.emerald });
    t(ctx, txt, M + 18, ctx.y, { sz: 9, color: C.lightGray });
    ctx.y -= 20;
  }
  ctx.y -= 10;

  // ── Tax Exempt ──
  card(ctx, 40);
  ctx.y -= 4;
  label(ctx, "TAX EXEMPT");
  t(ctx, "Status declared at signing — see audit log for details", M, ctx.y, { sz: 9, color: C.lightGray });
  ctx.y -= 22;

  // ── Signature ──
  ctx.y -= 6;
  const sigH = quote.signature_type === "typed" && quote.signature_data ? 110 : 90;
  card(ctx, sigH);
  ctx.y -= 4;
  label(ctx, "ELECTRONIC SIGNATURE");

  if (quote.signature_type === "typed" && quote.signature_data) {
    // Draw signature in a styled box
    ctx.page.drawRectangle({
      x: M,
      y: ctx.y - 32,
      width: CW,
      height: 36,
      color: C.stripe,
    });
    t(ctx, quote.signature_data, M + 12, ctx.y - 22, { font: fi, sz: 24, color: C.cyan });
    ctx.y -= 44;
  } else if (quote.signature_type === "draw") {
    ctx.page.drawRectangle({ x: M, y: ctx.y - 32, width: CW, height: 36, color: C.stripe });
    t(ctx, "[Drawn signature on file]", M + 12, ctx.y - 22, { font: fi, sz: 12, color: C.cyan });
    ctx.y -= 44;
  }

  t(ctx, `Signed: ${quote.contract_signed_at ? new Date(quote.contract_signed_at).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—"}`, M, ctx.y, { sz: 8, color: C.gray });
  ctx.y -= 12;
  if (quote.signer_ip) {
    t(ctx, `IP Address: ${quote.signer_ip}`, M, ctx.y, { sz: 8, color: C.gray });
    ctx.y -= 12;
  }
  if (quote.signer_ua) {
    t(ctx, `Browser: ${quote.signer_ua.slice(0, 85)}`, M, ctx.y, { sz: 6.5, color: C.gray });
    ctx.y -= 10;
  }
  ctx.y -= 6;

  // ── Document Seal ──
  if (seal) {
    card(ctx, 48);
    ctx.y -= 4;
    label(ctx, "DOCUMENT INTEGRITY SEAL (SHA-256)");
    t(ctx, seal, M, ctx.y, { sz: 7.5, color: C.cyan });
    ctx.y -= 24;
  }

  // ── ESIGN Compliance ──
  ctx.y -= 10;
  t(ctx, "This document was electronically signed in compliance with the ESIGN Act (15 U.S.C. §7001) and the", M, ctx.y, { sz: 7, color: C.gray });
  ctx.y -= 10;
  t(ctx, "Uniform Electronic Transactions Act (UETA). The signer's identity, IP address, user agent, and", M, ctx.y, { sz: 7, color: C.gray });
  ctx.y -= 10;
  t(ctx, "timestamp were captured and recorded for verification and non-repudiation purposes.", M, ctx.y, { sz: 7, color: C.gray });

  pageFooter(ctx, seal, 2, totalPages);

  // ═══════════════════════════════════════════════════════════
  // PAGE 3 — Audit Trail (if entries exist)
  // ═══════════════════════════════════════════════════════════

  if (auditLog.length > 0) {
    ctx = addBgPage(doc, ctx);
    pageHeader(ctx, "AUDIT TRAIL", "CHRONOLOGICAL EVENT LOG");

    // Table header
    const cols = [M, M + 150, M + 310, M + 430];
    const headers = ["TIMESTAMP", "EVENT", "ACTOR", "IP ADDRESS"];
    ctx.page.drawRectangle({ x: CARD_X, y: ctx.y - 18, width: CARD_W, height: 18, color: C.card });
    for (let i = 0; i < headers.length; i++) {
      t(ctx, headers[i], cols[i], ctx.y - 12, { font: fb, sz: 7, color: C.cyan });
    }
    ctx.y -= 22;

    for (let i = 0; i < auditLog.length; i++) {
      if (ctx.y < 60) {
        pageFooter(ctx, seal, 3, totalPages);
        ctx = addBgPage(doc, ctx);
        pageHeader(ctx, "AUDIT TRAIL", "CONTINUED");
        ctx.page.drawRectangle({ x: CARD_X, y: ctx.y - 18, width: CARD_W, height: 18, color: C.card });
        for (let j = 0; j < headers.length; j++) {
          t(ctx, headers[j], cols[j], ctx.y - 12, { font: fb, sz: 7, color: C.cyan });
        }
        ctx.y -= 22;
      }

      if (i % 2 === 0) {
        ctx.page.drawRectangle({ x: CARD_X, y: ctx.y - 14, width: CARD_W, height: 16, color: C.stripe });
      }

      const entry = auditLog[i];
      const ts = new Date(entry.created_at).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      t(ctx, ts, cols[0], ctx.y - 10, { sz: 8, color: C.lightGray });
      t(ctx, entry.event, cols[1], ctx.y - 10, { font: fb, sz: 8, color: C.white });
      if (entry.actor_email) {
        t(ctx, entry.actor_email.slice(0, 28), cols[2], ctx.y - 10, { sz: 7, color: C.gray });
      }
      if (entry.actor_ip) {
        t(ctx, entry.actor_ip, cols[3], ctx.y - 10, { sz: 7, color: C.gray });
      }
      ctx.y -= 16;
    }

    pageFooter(ctx, seal, 3, totalPages);
  }

  // Metadata
  doc.setTitle(`Event Contract — ${quote.event_name || ""}`);
  doc.setSubject(`Contract for ${quote.guest_first_name} ${quote.guest_last_name} at ${quote.center_name}`);
  doc.setCreator("FastTrax Entertainment / HeadPinz");
  doc.setProducer("FastTrax Contract System");
  if (seal) {
    doc.setKeywords([`seal:${seal}`]);
  }

  return doc.save();
}
