import { PDFDocument, rgb, StandardFonts, PDFPage, PDFFont, PDFImage } from "pdf-lib";
import type { GroupFunctionQuote, AuditLogEntry } from "@/lib/group-function-db";

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

const C = {
  white: rgb(1, 1, 1),
  black: rgb(0, 0, 0),
  navy: rgb(0.09, 0.12, 0.27),
  navyDark: rgb(0.06, 0.08, 0.18),
  textPrimary: rgb(0.13, 0.13, 0.13),
  textSecondary: rgb(0.4, 0.42, 0.45),
  textMuted: rgb(0.55, 0.58, 0.62),
  tableHeaderBg: rgb(0.09, 0.12, 0.27),
  tableAltRow: rgb(0.95, 0.96, 0.97),
  borderLight: rgb(0.82, 0.84, 0.87),
  accentBlue: rgb(0.14, 0.45, 0.8),
  emerald: rgb(0.13, 0.72, 0.53),
  red: rgb(0.85, 0.18, 0.18),
  amber: rgb(0.92, 0.58, 0.04),
  coverOverlay: rgb(0.04, 0.06, 0.15),
};

const PAGE_W = 612;
const PAGE_H = 792;
const M = 48;
const CW = PAGE_W - M * 2;
const RE = M + CW;
const FOOTER_H = 36;

const HEADPINZ_LOGO_URL =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logos/headpinz-logo-9aUwk9v1Z8LcHZP5chi50PnSbDWpSg.png";
const FASTTRAX_LOGO_URL =
  "https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png";
const HERO_IMAGE_URL =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/group-events-bowling-bg.png";

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  f: PDFFont;
  fb: PDFFont;
  fi: PDFFont;
  y: number;
}

// ── Text helpers ─────────────────────────────────────────────

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
    color: opts?.color ?? C.textPrimary,
  });
}

function tRight(
  ctx: Ctx,
  s: string,
  y: number,
  opts?: { font?: PDFFont; sz?: number; color?: ReturnType<typeof rgb> },
) {
  const fnt = opts?.font ?? ctx.f;
  const sz = opts?.sz ?? 10;
  const w = fnt.widthOfTextAtSize(s, sz);
  t(ctx, s, RE - w, y, opts);
}

function tCenter(
  ctx: Ctx,
  s: string,
  y: number,
  opts?: { font?: PDFFont; sz?: number; color?: ReturnType<typeof rgb> },
) {
  const fnt = opts?.font ?? ctx.f;
  const sz = opts?.sz ?? 10;
  const w = fnt.widthOfTextAtSize(s, sz);
  t(ctx, s, (PAGE_W - w) / 2, y, opts);
}

function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, fontSize) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

// ── Layout helpers ───────────────────────────────────────────

function newPage(ctx: Ctx): Ctx {
  const page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  return { ...ctx, page, y: PAGE_H - M };
}

function needsNewPage(ctx: Ctx, requiredHeight: number): boolean {
  return ctx.y - requiredHeight < FOOTER_H + M;
}

function ensureSpace(ctx: Ctx, h: number): Ctx {
  if (needsNewPage(ctx, h)) {
    pageFooter(ctx);
    return newPage(ctx);
  }
  return ctx;
}

function sectionHeader(ctx: Ctx, title: string) {
  ctx = ensureSpace(ctx, 40);
  ctx.page.drawRectangle({
    x: M,
    y: ctx.y - 28,
    width: CW,
    height: 28,
    color: C.navy,
  });
  t(ctx, title, M + 12, ctx.y - 20, { font: ctx.fb, sz: 12, color: C.white });
  ctx.y -= 38;
}

function infoBox(ctx: Ctx, label: string, value: string, width?: number) {
  const w = width || CW;
  const boxH = 42;
  ctx.page.drawRectangle({
    x: M,
    y: ctx.y - boxH,
    width: w,
    height: boxH,
    borderColor: C.borderLight,
    borderWidth: 1,
    color: C.white,
  });
  t(ctx, label, M + 10, ctx.y - 14, { font: ctx.fb, sz: 8, color: C.textMuted });
  t(ctx, value, M + 10, ctx.y - 30, { font: ctx.fb, sz: 11, color: C.textPrimary });
  ctx.y -= boxH + 6;
}

function checkbox(ctx: Ctx, x: number, y: number, checked: boolean) {
  const size = 12;
  ctx.page.drawRectangle({
    x,
    y: y - size + 2,
    width: size,
    height: size,
    borderColor: checked ? C.emerald : C.borderLight,
    borderWidth: 1.5,
    color: checked ? C.emerald : C.white,
  });
  if (checked) {
    // Draw checkmark as two lines (standard fonts can't encode ✓)
    const bx = x + 2.5;
    const by = y - size + 4;
    ctx.page.drawLine({
      start: { x: bx, y: by + 4 },
      end: { x: bx + 3, y: by + 1 },
      thickness: 2,
      color: C.white,
    });
    ctx.page.drawLine({
      start: { x: bx + 3, y: by + 1 },
      end: { x: bx + 8, y: by + 8 },
      thickness: 2,
      color: C.white,
    });
  }
}

function bulletPoint(ctx: Ctx, title: string, body: string, indent: number = 0) {
  const bulletX = M + indent;
  const textX = bulletX + 10;
  const maxW = CW - indent - 10;

  ctx.page.drawCircle({
    x: bulletX + 3,
    y: ctx.y - 3,
    size: 2.5,
    color: C.navy,
  });

  if (title) {
    t(ctx, title, textX, ctx.y - 7, { font: ctx.fb, sz: 8.5, color: C.textPrimary });
    ctx.y -= 14;
    const lines = wrapText(body, ctx.f, 8, maxW);
    for (const line of lines) {
      ctx = ensureSpace(ctx, 12);
      t(ctx, line, textX, ctx.y - 7, { sz: 8, color: C.textSecondary });
      ctx.y -= 12;
    }
  } else {
    const lines = wrapText(body, ctx.f, 8.5, maxW);
    for (const line of lines) {
      ctx = ensureSpace(ctx, 12);
      t(ctx, line, textX, ctx.y - 7, { sz: 8.5, color: C.textSecondary });
      ctx.y -= 12;
    }
  }
  ctx.y -= 4;
}

function pageFooter(ctx: Ctx, pageNum?: number, totalPages?: number) {
  ctx.page.drawLine({
    start: { x: M, y: FOOTER_H },
    end: { x: RE, y: FOOTER_H },
    thickness: 0.5,
    color: C.borderLight,
  });
  if (pageNum && totalPages) {
    const pg = `Page ${pageNum} of ${totalPages}`;
    const pgW = ctx.f.widthOfTextAtSize(pg, 7);
    t(ctx, pg, RE - pgW, FOOTER_H - 14, { sz: 7, color: C.textMuted });
  }
  t(ctx, "FastTrax Entertainment / HeadPinz", M, FOOTER_H - 14, { sz: 7, color: C.textMuted });
}

// ── Image fetching ───────────────────────────────────────────

async function fetchImage(url: string, timeoutMs: number = 5000): Promise<Uint8Array | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function embedImage(doc: PDFDocument, bytes: Uint8Array | null): Promise<PDFImage | null> {
  if (!bytes) return null;
  try {
    return await doc.embedPng(bytes);
  } catch {
    try {
      return await doc.embedJpg(bytes);
    } catch {
      return null;
    }
  }
}

// ── Main PDF generation ──────────────────────────────────────

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

  // Fetch images in parallel
  const [hpLogoBytes, ftLogoBytes, heroBytes] = await Promise.all([
    fetchImage(HEADPINZ_LOGO_URL),
    fetchImage(FASTTRAX_LOGO_URL),
    fetchImage(HERO_IMAGE_URL),
  ]);
  const hpLogo = await embedImage(doc, hpLogoBytes);
  const ftLogo = await embedImage(doc, ftLogoBytes);
  const heroImg = await embedImage(doc, heroBytes);

  let ctx: Ctx = { doc, page: null!, f, fb, fi, y: 0 };

  // ═══════════════════════════════════════════════════════════
  // PAGE 1 — Cover Page (matches contract page aesthetic)
  // ═══════════════════════════════════════════════════════════

  ctx = newPage(ctx);
  const coverPage = ctx.page;
  const coverBg = rgb(0.04, 0.09, 0.16); // #0a1628 — same as contract page

  // Solid dark navy background
  coverPage.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: coverBg });

  // Hero image covering full page, scaled to cover (crop to fill)
  if (heroImg) {
    const imgAspect = heroImg.width / heroImg.height;
    const pageAspect = PAGE_W / PAGE_H;
    let drawW: number, drawH: number, drawX: number, drawY: number;
    if (imgAspect > pageAspect) {
      // Image is wider — fit height, crop sides
      drawH = PAGE_H;
      drawW = PAGE_H * imgAspect;
      drawX = -(drawW - PAGE_W) / 2;
      drawY = 0;
    } else {
      // Image is taller — fit width, crop top/bottom
      drawW = PAGE_W;
      drawH = PAGE_W / imgAspect;
      drawX = 0;
      drawY = -(drawH - PAGE_H) / 2;
    }
    coverPage.drawImage(heroImg, {
      x: drawX,
      y: drawY,
      width: drawW,
      height: drawH,
      opacity: 0.5,
    });
    // Even overlay so bokeh shows across entire page
    coverPage.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_W,
      height: PAGE_H,
      color: coverBg,
      opacity: 0.55,
    });
  }

  // Accent stripe at very top (red → white → cyan, like the contract page)
  coverPage.drawRectangle({
    x: 0,
    y: PAGE_H - 3,
    width: PAGE_W / 3,
    height: 3,
    color: rgb(0.9, 0.22, 0.21),
  });
  coverPage.drawRectangle({
    x: PAGE_W / 3,
    y: PAGE_H - 3,
    width: PAGE_W / 3,
    height: 3,
    color: C.white,
    opacity: 0.6,
  });
  coverPage.drawRectangle({
    x: (PAGE_W * 2) / 3,
    y: PAGE_H - 3,
    width: PAGE_W / 3,
    height: 3,
    color: rgb(0, 0.89, 0.9),
  });

  // Logos — centered, generously sized
  let logoY = PAGE_H - 100;
  if (hpLogo && ftLogo) {
    const hpW = 140;
    const hpH = (hpLogo.height / hpLogo.width) * hpW;
    const ftW = 140;
    const ftH = (ftLogo.height / ftLogo.width) * ftW;
    const gap = 50;
    const totalW = hpW + gap + ftW;
    const startX = (PAGE_W - totalW) / 2;
    coverPage.drawImage(hpLogo, { x: startX, y: logoY - hpH, width: hpW, height: hpH });
    coverPage.drawImage(ftLogo, { x: startX + hpW + gap, y: logoY - ftH, width: ftW, height: ftH });
    logoY -= Math.max(hpH, ftH) + 30;
  } else if (hpLogo) {
    const w = 200;
    const h = (hpLogo.height / hpLogo.width) * w;
    coverPage.drawImage(hpLogo, { x: (PAGE_W - w) / 2, y: logoY - h, width: w, height: h });
    logoY -= h + 30;
  } else if (ftLogo) {
    const w = 200;
    const h = (ftLogo.height / ftLogo.width) * w;
    coverPage.drawImage(ftLogo, { x: (PAGE_W - w) / 2, y: logoY - h, width: w, height: h });
    logoY -= h + 30;
  }

  // Cyan accent line
  coverPage.drawRectangle({
    x: (PAGE_W - 60) / 2,
    y: logoY - 10,
    width: 60,
    height: 2,
    color: rgb(0, 0.89, 0.9),
  });

  // "EVENT CONTRACT" label
  const labelText = "EVENT CONTRACT";
  const labelW = fb.widthOfTextAtSize(labelText, 11);
  coverPage.drawText(labelText, {
    x: (PAGE_W - labelW) / 2,
    y: logoY - 40,
    font: fb,
    size: 11,
    color: rgb(0, 0.89, 0.9),
  });

  // Event name — large, centered
  const eventName = quote.event_name || "Event Contract";
  const nameLines = wrapText(eventName, fb, 32, PAGE_W - 120);
  let nameY = logoY - 80;
  for (const line of nameLines) {
    tCenter(ctx, line, nameY, { font: fb, sz: 32, color: C.white });
    nameY -= 42;
  }

  // Event date
  if (quote.event_date_display) {
    tCenter(ctx, quote.event_date_display, nameY - 6, { sz: 14, color: rgb(0.75, 0.8, 0.85) });
    nameY -= 28;
  }

  // Center name
  tCenter(ctx, quote.center_name, nameY - 6, { font: fb, sz: 16, color: C.white });

  // Bottom section — website + accent line
  const brandDomain = quote.brand === "headpinz" ? "headpinz.com" : "fasttraxent.com";
  coverPage.drawRectangle({
    x: (PAGE_W - 60) / 2,
    y: 70,
    width: 60,
    height: 2,
    color: rgb(0, 0.89, 0.9),
    opacity: 0.5,
  });
  tCenter(ctx, brandDomain, 48, { sz: 10, color: rgb(0.55, 0.6, 0.68) });

  // ═══════════════════════════════════════════════════════════
  // PAGE 2 — Event Quote
  // ═══════════════════════════════════════════════════════════

  ctx = newPage(ctx);
  sectionHeader(ctx, "Event Quote");

  // Two-column: Planner vs Customer
  const colW = (CW - 20) / 2;
  const col2X = M + colW + 20;
  const contactH = 74;

  // Left — Event Planner
  ctx.page.drawRectangle({
    x: M,
    y: ctx.y - contactH,
    width: colW,
    height: contactH,
    borderColor: C.borderLight,
    borderWidth: 1,
    color: C.white,
  });
  let ly = ctx.y - 14;
  t(ctx, "EVENT PLANNER", M + 10, ly, { font: ctx.fb, sz: 8, color: C.textMuted });
  ly -= 16;
  t(ctx, `${quote.planner_first || ""} ${quote.planner_last || ""}`.trim() || "—", M + 10, ly, {
    font: fb,
    sz: 10,
    color: C.textPrimary,
  });
  ly -= 14;
  if (quote.planner_email) {
    t(ctx, quote.planner_email, M + 10, ly, { sz: 8, color: C.textSecondary });
    ly -= 12;
  }
  if (quote.planner_phone) {
    t(ctx, quote.planner_phone, M + 10, ly, { sz: 8, color: C.textSecondary });
  }

  // Right — Customer
  ctx.page.drawRectangle({
    x: col2X,
    y: ctx.y - contactH,
    width: colW,
    height: contactH,
    borderColor: C.borderLight,
    borderWidth: 1,
    color: C.white,
  });
  let ry = ctx.y - 14;
  t(ctx, "CUSTOMER", col2X + 10, ry, { font: ctx.fb, sz: 8, color: C.textMuted });
  ry -= 16;
  t(ctx, `${quote.guest_first_name} ${quote.guest_last_name}`, col2X + 10, ry, {
    font: fb,
    sz: 10,
    color: C.textPrimary,
  });
  ry -= 14;
  t(ctx, quote.guest_email, col2X + 10, ry, { sz: 8, color: C.textSecondary });
  ry -= 12;
  if (quote.guest_phone) {
    t(ctx, quote.guest_phone, col2X + 10, ry, { sz: 8, color: C.textSecondary });
  }

  ctx.y -= contactH + 16;

  // Pricing table
  const tableCols = { name: M + 8, price: M + 300, qty: M + 390, subtotal: RE - 8 };
  const rowH = 22;

  // Header row
  ctx.page.drawRectangle({
    x: M,
    y: ctx.y - rowH,
    width: CW,
    height: rowH,
    color: C.tableHeaderBg,
  });
  t(ctx, "NAME", tableCols.name, ctx.y - 15, { font: fb, sz: 8, color: C.white });
  t(ctx, "PRICE", tableCols.price, ctx.y - 15, { font: fb, sz: 8, color: C.white });
  t(ctx, "QTY", tableCols.qty, ctx.y - 15, { font: fb, sz: 8, color: C.white });
  const stLabel = "SUBTOTAL";
  const stLabelW = fb.widthOfTextAtSize(stLabel, 8);
  t(ctx, stLabel, tableCols.subtotal - stLabelW, ctx.y - 15, { font: fb, sz: 8, color: C.white });
  ctx.y -= rowH;

  // Line items
  for (let i = 0; i < lineItems.length; i++) {
    ctx = ensureSpace(ctx, rowH);
    const item = lineItems[i];
    if (i % 2 === 0) {
      ctx.page.drawRectangle({
        x: M,
        y: ctx.y - rowH,
        width: CW,
        height: rowH,
        color: C.tableAltRow,
      });
    }
    t(ctx, item.name, tableCols.name, ctx.y - 15, { sz: 9, color: C.textPrimary });
    t(ctx, dollars(Math.round(item.price * 100)), tableCols.price, ctx.y - 15, {
      sz: 9,
      color: C.textSecondary,
    });
    t(ctx, String(item.qty), tableCols.qty, ctx.y - 15, { sz: 9, color: C.textSecondary });
    const subStr = dollars(Math.round(item.total * 100));
    const subW = f.widthOfTextAtSize(subStr, 9);
    t(ctx, subStr, tableCols.subtotal - subW, ctx.y - 15, {
      font: fb,
      sz: 9,
      color: C.textPrimary,
    });
    ctx.y -= rowH;
  }

  // Table border bottom
  ctx.page.drawLine({
    start: { x: M, y: ctx.y },
    end: { x: RE, y: ctx.y },
    thickness: 0.5,
    color: C.borderLight,
  });
  ctx.y -= 6;

  // Summary rows (right-aligned)
  const summaryX = M + 320;
  const summaryValX = RE - 8;

  // Subtotal (pre-tax)
  const subtotalCents = quote.total_cents - quote.tax_cents;
  t(ctx, "Subtotal", summaryX, ctx.y - 12, { sz: 9, color: C.textSecondary });
  const subtotalStr = dollars(subtotalCents);
  const subtotalW = f.widthOfTextAtSize(subtotalStr, 9);
  t(ctx, subtotalStr, summaryValX - subtotalW, ctx.y - 12, { sz: 9, color: C.textPrimary });
  ctx.y -= 18;

  if (quote.tax_cents > 0) {
    t(ctx, "Tax", summaryX, ctx.y - 12, { sz: 9, color: C.textSecondary });
    const taxStr = dollars(quote.tax_cents);
    const taxW = f.widthOfTextAtSize(taxStr, 9);
    t(ctx, taxStr, summaryValX - taxW, ctx.y - 12, { sz: 9, color: C.textPrimary });
    ctx.y -= 18;
  }

  // Total
  ctx.page.drawLine({
    start: { x: summaryX, y: ctx.y },
    end: { x: RE, y: ctx.y },
    thickness: 1,
    color: C.navy,
  });
  ctx.y -= 4;
  t(ctx, "Total", summaryX, ctx.y - 14, { font: fb, sz: 12, color: C.navy });
  const totalStr = dollars(quote.total_cents);
  const totalW = fb.widthOfTextAtSize(totalStr, 14);
  t(ctx, totalStr, summaryValX - totalW, ctx.y - 14, { font: fb, sz: 14, color: C.navy });
  ctx.y -= 28;

  // Deposit / Balance summary
  ctx.page.drawLine({
    start: { x: M, y: ctx.y },
    end: { x: RE, y: ctx.y },
    thickness: 0.5,
    color: C.borderLight,
  });
  ctx.y -= 6;

  t(ctx, "50% Deposit — Due at Signing", M + 8, ctx.y - 12, { sz: 9, color: C.textSecondary });
  const depStr = dollars(quote.deposit_due_cents);
  const depW = fb.widthOfTextAtSize(depStr, 11);
  t(ctx, depStr, summaryValX - depW, ctx.y - 12, { font: fb, sz: 11, color: C.emerald });
  ctx.y -= 20;

  t(ctx, "Remaining Balance — 72 Hours Before Event", M + 8, ctx.y - 12, {
    sz: 9,
    color: C.textSecondary,
  });
  const balStr = dollars(quote.balance_cents);
  const balW = fb.widthOfTextAtSize(balStr, 11);
  t(ctx, balStr, summaryValX - balW, ctx.y - 12, { font: fb, sz: 11, color: C.textPrimary });
  ctx.y -= 20;

  pageFooter(ctx);

  // ═══════════════════════════════════════════════════════════
  // PAGE 3 — Additional Event Details
  // ═══════════════════════════════════════════════════════════

  ctx = newPage(ctx);
  sectionHeader(ctx, "Additional Event Details");

  // Location & Time
  infoBox(ctx, "LOCATION & TIME", `${quote.center_name}  |  ${quote.event_date_display || ""}`);

  // Deposit Due
  infoBox(ctx, "DEPOSIT DUE", `${dollars(quote.deposit_due_cents)} — Due at contract signing`);

  // Planner Notes
  if (quote.notes) {
    ctx.y -= 4;
    t(ctx, "PLANNER NOTES", M, ctx.y, { font: fb, sz: 9, color: C.textMuted });
    ctx.y -= 14;
    const noteLines = wrapText(quote.notes, f, 9, CW - 10);
    for (const line of noteLines) {
      ctx = ensureSpace(ctx, 14);
      t(ctx, line, M + 4, ctx.y - 7, { sz: 9, color: C.textSecondary });
      ctx.y -= 14;
    }
    ctx.y -= 8;
  }

  // ── Helpful Tips ──
  ctx.y -= 6;
  t(ctx, "HELPFUL TIPS", M, ctx.y, { font: fb, sz: 9, color: C.navy });
  ctx.y -= 16;

  const tips: [string, string][] = [
    [
      "Outside Food & Beverage",
      "No outside food or beverages are permitted. All food and drinks must be purchased on-site.",
    ],
    [
      "Buffet Service",
      "Buffets are available for groups of 15 or more guests and include a dedicated event host.",
    ],
    [
      "Electronic Waivers",
      "All participants in waiver-required activities (go-karts, gel blaster, etc.) must complete an electronic waiver before participating. A link will be provided prior to your event.",
    ],
    [
      "Adding Food & Beverage",
      "Additional food and beverage items can be added to your event at any time by contacting your event planner.",
    ],
    [
      "Rewards Program",
      "All guests will automatically be enrolled in our rewards program and will receive exclusive offers and discounts.",
    ],
    [
      "Payment & Gift Cards",
      "Your deposit is converted into a digital gift card that is redeemed on the day of your event. The remaining balance is automatically charged 72 hours before your event.",
    ],
    [
      "Service Charge",
      "A 20% service charge is applied to all group event packages. This is included in your quoted price.",
    ],
  ];

  for (const [title, body] of tips) {
    ctx = ensureSpace(ctx, 40);
    bulletPoint(ctx, title, body);
  }

  pageFooter(ctx);

  // ═══════════════════════════════════════════════════════════
  // PAGE 4 — Cancellation Policy + Agreements + Signature
  // ═══════════════════════════════════════════════════════════

  ctx = newPage(ctx);
  sectionHeader(ctx, "Cancellation Policy");

  const policies: [string, string][] = [
    [
      "7+ Days Notice",
      "If you cancel 7 or more days before your event, your deposit will be applied as a credit toward rescheduling. The rescheduled event must meet or exceed the value of the original event.",
    ],
    [
      "Within 7 Days",
      "Cancellations within 7 days of the event are non-refundable. A 50% deposit credit may be available at the discretion of management for rescheduling.",
    ],
    [
      "Guest Participants",
      "Guest count changes require a minimum of 3 business days notice. The guest count may increase but may not decrease by more than 15% of the original count.",
    ],
    [
      "Additional Details",
      "The remaining balance is automatically charged to the card on file 72 hours before the event. No changes to the event can be made within 72 hours of the event date.",
    ],
  ];

  for (const [title, body] of policies) {
    ctx = ensureSpace(ctx, 44);
    bulletPoint(ctx, title, body);
  }

  // ── Let's Make it Official ──
  ctx.y -= 10;
  ctx = ensureSpace(ctx, 200);
  sectionHeader(ctx, "Let's Make it Official");

  const agreeItems = [
    "I agree to make a 50% deposit via credit card after completing this document.",
    "I understand the remaining balance will be automatically charged 72 hours prior to the event.",
    "I understand that waivers are required for all participants in waiver-required activities.",
    "I have read and understand the event information and helpful tips provided.",
    "I have read and agree to the cancellation policy.",
  ];

  for (const txt of agreeItems) {
    ctx = ensureSpace(ctx, 20);
    checkbox(ctx, M, ctx.y, true);
    const lines = wrapText(txt, f, 9, CW - 24);
    for (let li = 0; li < lines.length; li++) {
      t(ctx, lines[li], M + 20, ctx.y - 8, { sz: 9, color: C.textPrimary });
      ctx.y -= 14;
    }
    ctx.y -= 4;
  }

  // Tax Exempt
  ctx.y -= 6;
  ctx = ensureSpace(ctx, 24);
  t(ctx, "TAX EXEMPT:", M, ctx.y, { font: fb, sz: 9, color: C.textMuted });
  const taxStatus = quote.is_tax_exempt ? "Yes — Tax exemption document on file" : "No";
  t(ctx, taxStatus, M + 85, ctx.y, { sz: 9, color: C.textPrimary });
  ctx.y -= 24;

  // ── Signature ──
  ctx = ensureSpace(ctx, 100);
  ctx.page.drawLine({
    start: { x: M, y: ctx.y },
    end: { x: RE, y: ctx.y },
    thickness: 0.5,
    color: C.borderLight,
  });
  ctx.y -= 8;
  t(ctx, "ELECTRONIC SIGNATURE", M, ctx.y, { font: fb, sz: 9, color: C.navy });
  ctx.y -= 20;

  let sigImage: PDFImage | null = null;
  if (
    quote.signature_type === "draw" &&
    quote.signature_data?.startsWith("data:image/png;base64,")
  ) {
    try {
      const b64 = quote.signature_data.split(",")[1];
      sigImage = await doc.embedPng(Buffer.from(b64, "base64"));
    } catch {
      /* fall back to text */
    }
  }

  if (quote.signature_type === "typed" && quote.signature_data) {
    ctx.page.drawRectangle({
      x: M,
      y: ctx.y - 36,
      width: CW,
      height: 40,
      borderColor: C.borderLight,
      borderWidth: 1,
      color: C.white,
    });
    t(ctx, quote.signature_data, M + 14, ctx.y - 24, { font: fi, sz: 22, color: C.navy });
    ctx.y -= 50;
  } else if (sigImage) {
    const imgW = Math.min(sigImage.width, CW - 24);
    const imgH = (sigImage.height / sigImage.width) * imgW;
    const boxH = Math.min(imgH + 16, 80);
    ctx.page.drawRectangle({
      x: M,
      y: ctx.y - boxH,
      width: CW,
      height: boxH,
      borderColor: C.borderLight,
      borderWidth: 1,
      color: C.white,
    });
    ctx.page.drawImage(sigImage, {
      x: M + 12,
      y: ctx.y - boxH + 8,
      width: imgW - 24,
      height: boxH - 16,
    });
    ctx.y -= boxH + 8;
  } else if (quote.signature_type === "draw") {
    ctx.page.drawRectangle({
      x: M,
      y: ctx.y - 36,
      width: CW,
      height: 40,
      borderColor: C.borderLight,
      borderWidth: 1,
      color: C.white,
    });
    t(ctx, "[Drawn signature on file]", M + 14, ctx.y - 24, {
      font: fi,
      sz: 12,
      color: C.textMuted,
    });
    ctx.y -= 50;
  }

  // Signature metadata
  t(
    ctx,
    `Signed: ${quote.contract_signed_at ? new Date(quote.contract_signed_at).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—"}`,
    M,
    ctx.y,
    { sz: 8, color: C.textSecondary },
  );
  if (quote.signer_ip) {
    const ipStr = `IP: ${quote.signer_ip}`;
    const ipW = f.widthOfTextAtSize(ipStr, 8);
    t(ctx, ipStr, RE - ipW, ctx.y, { sz: 8, color: C.textSecondary });
  }
  ctx.y -= 14;

  t(ctx, `${quote.guest_first_name} ${quote.guest_last_name}`, M, ctx.y, {
    font: fb,
    sz: 9,
    color: C.textPrimary,
  });
  ctx.y -= 12;
  t(ctx, quote.guest_email, M, ctx.y, { sz: 8, color: C.textSecondary });

  pageFooter(ctx);

  // ═══════════════════════════════════════════════════════════
  // PAGE 5 — Certificate of Signature
  // ═══════════════════════════════════════════════════════════

  ctx = newPage(ctx);

  // Centered title
  ctx.y -= 20;
  tCenter(ctx, "Certificate of Signature", ctx.y, { font: fb, sz: 22, color: C.navy });
  ctx.y -= 40;

  ctx.page.drawLine({
    start: { x: M + 80, y: ctx.y },
    end: { x: RE - 80, y: ctx.y },
    thickness: 1.5,
    color: C.navy,
  });
  ctx.y -= 30;

  // Document title
  t(ctx, "DOCUMENT", M, ctx.y, { font: fb, sz: 8, color: C.textMuted });
  ctx.y -= 14;
  t(ctx, `Event Contract — ${quote.event_name || ""}`, M, ctx.y, {
    font: fb,
    sz: 12,
    color: C.textPrimary,
  });
  ctx.y -= 28;

  // Signer info
  t(ctx, "SIGNER", M, ctx.y, { font: fb, sz: 8, color: C.textMuted });
  ctx.y -= 14;
  t(ctx, `${quote.guest_first_name} ${quote.guest_last_name}`, M, ctx.y, {
    font: fb,
    sz: 11,
    color: C.textPrimary,
  });
  ctx.y -= 14;
  t(ctx, quote.guest_email, M, ctx.y, { sz: 9, color: C.textSecondary });
  ctx.y -= 30;

  // Timestamps
  ctx.page.drawLine({
    start: { x: M, y: ctx.y },
    end: { x: RE, y: ctx.y },
    thickness: 0.5,
    color: C.borderLight,
  });
  ctx.y -= 20;

  const fmtTS = (iso: string | null | undefined, label: string) => {
    if (!iso) return;
    const dt = new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
    t(ctx, label, M, ctx.y, { font: fb, sz: 8, color: C.textMuted });
    t(ctx, dt, M + 120, ctx.y, { sz: 9, color: C.textPrimary });
    ctx.y -= 18;
  };

  fmtTS(quote.contract_sent_at, "Contract Sent");
  if (quote.otp_verified_at) {
    fmtTS(quote.otp_verified_at, "Identity Verified");
  }
  fmtTS(quote.contract_signed_at, "Contract Signed");
  ctx.y -= 10;

  // IP Address
  if (quote.signer_ip) {
    t(ctx, "IP ADDRESS", M, ctx.y, { font: fb, sz: 8, color: C.textMuted });
    t(ctx, quote.signer_ip, M + 120, ctx.y, { sz: 9, color: C.textPrimary });
    ctx.y -= 18;
  }

  // User Agent
  if (quote.signer_ua) {
    t(ctx, "BROWSER", M, ctx.y, { font: fb, sz: 8, color: C.textMuted });
    const uaLines = wrapText(quote.signer_ua, f, 7.5, CW - 120);
    for (const line of uaLines.slice(0, 2)) {
      t(ctx, line, M + 120, ctx.y, { sz: 7.5, color: C.textSecondary });
      ctx.y -= 12;
    }
    ctx.y -= 6;
  }

  // Document Seal
  if (seal) {
    ctx.y -= 10;
    ctx.page.drawLine({
      start: { x: M, y: ctx.y },
      end: { x: RE, y: ctx.y },
      thickness: 0.5,
      color: C.borderLight,
    });
    ctx.y -= 20;
    t(ctx, "DOCUMENT INTEGRITY SEAL (SHA-256)", M, ctx.y, { font: fb, sz: 8, color: C.textMuted });
    ctx.y -= 16;
    t(ctx, seal, M, ctx.y, { sz: 7.5, color: C.navy });
    ctx.y -= 24;
  }

  // ESIGN Compliance
  ctx.y -= 10;
  ctx.page.drawLine({
    start: { x: M, y: ctx.y },
    end: { x: RE, y: ctx.y },
    thickness: 0.5,
    color: C.borderLight,
  });
  ctx.y -= 16;

  const esignText =
    "This document was electronically signed in compliance with the ESIGN Act " +
    "(15 U.S.C. §7001) and the Uniform Electronic Transactions Act (UETA). " +
    "The signer's identity, IP address, user agent, and timestamp were captured " +
    "and recorded for verification and non-repudiation purposes.";
  const esignLines = wrapText(esignText, f, 7.5, CW);
  for (const line of esignLines) {
    t(ctx, line, M, ctx.y, { sz: 7.5, color: C.textMuted });
    ctx.y -= 11;
  }

  pageFooter(ctx);

  // ── Metadata ───────────────────────────────────────────────

  doc.setTitle(`Event Contract — ${quote.event_name || ""}`);
  doc.setSubject(
    `Contract for ${quote.guest_first_name} ${quote.guest_last_name} at ${quote.center_name}`,
  );
  doc.setCreator("FastTrax Entertainment / HeadPinz");
  doc.setProducer("FastTrax Contract System");
  if (seal) {
    doc.setKeywords([`seal:${seal}`]);
  }

  return doc.save();
}
