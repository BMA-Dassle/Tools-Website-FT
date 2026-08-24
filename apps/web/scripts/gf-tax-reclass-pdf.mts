/**
 * Build the June–July 2026 sales-tax reclassification worksheet as a PDF (pdf-lib, the same
 * library the contract PDFs use — no new dependency, no headless browser).
 *
 * Neutral framing on purpose: this document goes to an accountant, so it states the
 * adjustment and the amounts and does not narrate the defect or its history.
 *
 *   npx tsx scripts/gf-tax-reclass-pdf.mts <in.json> <out.pdf>
 *
 * Input JSON comes from _gf-junjul-export.mts. NO network, NO DB.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

interface Row {
  month: string;
  date: string;
  center: string;
  county: string;
  rate: string;
  name: string;
  bmi: string;
  evt: string;
  orderId: string | null;
  taxCents: number;
  totalCents: number;
}

const [, , inPath, outPath] = process.argv;
const { reclass } = JSON.parse(readFileSync(inPath, "utf8")) as { reclass: Row[] };

const usd = (c: number) =>
  `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (n: number[]) => n.reduce((a, b) => a + b, 0);
const MONTH_LABEL: Record<string, string> = { "2026-06": "June 2026", "2026-07": "July 2026" };
const MONTHS = ["2026-06", "2026-07"];
const CENTERS_BY_COUNTY: Record<string, string[]> = {
  Lee: ["HeadPinz Fort Myers", "FastTrax Fort Myers"],
  Collier: ["HeadPinz Naples"],
};
const COUNTIES = ["Lee", "Collier"];

// ── Page geometry: landscape Letter, so the Square order id fits on one line ──
const W = 792;
const H = 612;
const M = 42;
const CW = W - M * 2;
const INK = rgb(0.11, 0.13, 0.16);
const SOFT = rgb(0.36, 0.4, 0.45);
const FAINT = rgb(0.55, 0.59, 0.64);
const RULE = rgb(0.84, 0.86, 0.89);
const RULE_SOFT = rgb(0.93, 0.94, 0.95);
const ACCENT = rgb(0.055, 0.43, 0.41);
const BAND = rgb(0.965, 0.973, 0.976);

const COLS = [
  { key: "date", label: "Event date", x: 0, w: 62 },
  { key: "name", label: "Event", x: 66, w: 236 },
  { key: "bmi", label: "BMI res.", x: 306, w: 76 },
  { key: "evt", label: "Event #", x: 386, w: 50 },
  { key: "ord", label: "Square order", x: 440, w: 182 },
  { key: "amt", label: "Move to tax", x: 626, w: 82 },
] as const;

const doc = await PDFDocument.create();
const reg = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const mono = await doc.embedFont(StandardFonts.Courier);
const monoB = await doc.embedFont(StandardFonts.CourierBold);

/** Trim to fit a column, with an ellipsis when it must be cut. */
function fit(text: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
const rightX = (text: string, font: PDFFont, size: number, colX: number, colW: number) =>
  M + colX + colW - font.widthOfTextAtSize(text, size);

const pages: PDFPage[] = [];
// Definite assignment: newPage() below is always called before any draw, but TS cannot see
// that through the helper functions.
let page!: PDFPage;
let y = 0;

function newPage(): void {
  page = doc.addPage([W, H]);
  pages.push(page);
  y = H - M;
}

function ensure(space: number): void {
  if (y - space < M + 26) {
    newPage();
    return;
  }
}

function tableHeader(): void {
  page.drawRectangle({ x: M, y: y - 16, width: CW, height: 16, color: BAND });
  for (const c of COLS) {
    const t = c.label;
    const x = c.key === "amt" ? rightX(t, bold, 7.5, c.x, c.w) : M + c.x;
    page.drawText(t, { x, y: y - 11.5, size: 7.5, font: bold, color: FAINT });
  }
  y -= 16;
  page.drawLine({
    start: { x: M, y },
    end: { x: M + CW, y },
    thickness: 0.8,
    color: RULE,
  });
  y -= 2;
}

// ══ Cover / summary page ══════════════════════════════════════════════
newPage();

const grand = sum(reclass.map((r) => r.taxCents));

page.drawText("SALES TAX RECLASSIFICATION", {
  x: M,
  y: y - 12,
  size: 9,
  font: bold,
  color: ACCENT,
});
y -= 34;
page.drawText("Group Events — June and July 2026", { x: M, y, size: 23, font: bold, color: INK });
y -= 30;

const lede = [
  "Sales tax collected on the group events listed in this document was recorded in Square's service-charge",
  "field rather than the sales-tax field. Guests were charged and paid the correct amount in every case, and",
  "no order total changes. The adjustment moves the tax into the correct account.",
];
for (const l of lede) {
  page.drawText(l, { x: M, y, size: 10, font: reg, color: SOFT });
  y -= 14;
}
y -= 14;

// Headline figure
page.drawRectangle({ x: M, y: y - 54, width: CW, height: 54, color: BAND });
page.drawText(usd(grand), { x: M + 16, y: y - 36, size: 26, font: monoB, color: INK });
page.drawText(
  `to move from Service Charges to Sales Tax  ·  ${reclass.length} events  ·  three centers`,
  { x: M + 16 + monoB.widthOfTextAtSize(usd(grand), 26) + 16, y: y - 30, size: 9.5, font: reg, color: SOFT },
);
page.drawText(
  "For each event: reduce Service Charges and increase Sales Tax by the amount shown. Gross sales unchanged.",
  { x: M + 16, y: y - 47, size: 8.5, font: reg, color: FAINT },
);
y -= 54 + 26;

// Totals table
page.drawText("Totals by month and county", { x: M, y, size: 13, font: bold, color: INK });
y -= 8;
page.drawLine({ start: { x: M, y }, end: { x: M + CW, y }, thickness: 1, color: INK });
y -= 18;

page.drawText(
  "Lee County (6.5%) covers HeadPinz Fort Myers and FastTrax Fort Myers. Collier County (6.0%) covers HeadPinz Naples.",
  { x: M, y, size: 8.5, font: reg, color: FAINT },
);
y -= 20;

const SUM_COLS = [
  { label: "", x: 0, w: 250 },
  { label: "Events", x: 260, w: 60 },
  { label: "June 2026", x: 340, w: 110 },
  { label: "July 2026", x: 470, w: 110 },
  { label: "Combined", x: 600, w: 108 },
];
page.drawRectangle({ x: M, y: y - 16, width: CW, height: 16, color: BAND });
for (const c of SUM_COLS) {
  if (!c.label) continue;
  page.drawText(c.label, {
    x: rightX(c.label, bold, 7.5, c.x, c.w),
    y: y - 11.5,
    size: 7.5,
    font: bold,
    color: FAINT,
  });
}
y -= 16;
page.drawLine({ start: { x: M, y }, end: { x: M + CW, y }, thickness: 0.8, color: RULE });
y -= 4;

const cellFor = (month: string | null, pred: (r: Row) => boolean) =>
  sum(reclass.filter((r) => (month ? r.month === month : true) && pred(r)).map((r) => r.taxCents));
const countFor = (pred: (r: Row) => boolean) => reclass.filter(pred).length;

function summaryRow(
  label: string,
  pred: (r: Row) => boolean,
  opts: { strong?: boolean; indent?: number } = {},
): void {
  const f = opts.strong ? bold : reg;
  const mf = opts.strong ? monoB : mono;
  const size = opts.strong ? 9.5 : 9;
  y -= 15;
  page.drawText(label, {
    x: M + (opts.indent ?? 0),
    y,
    size,
    font: f,
    color: opts.strong ? INK : SOFT,
  });
  const cells: Array<[string, { x: number; w: number }]> = [
    [String(countFor(pred)), SUM_COLS[1]],
    [usd(cellFor("2026-06", pred)), SUM_COLS[2]],
    [usd(cellFor("2026-07", pred)), SUM_COLS[3]],
    [usd(cellFor(null, pred)), SUM_COLS[4]],
  ];
  for (const [t, c] of cells)
    page.drawText(t, { x: rightX(t, mf, size, c.x, c.w), y, size, font: mf, color: INK });
  y -= 5;
  page.drawLine({ start: { x: M, y }, end: { x: M + CW, y }, thickness: 0.5, color: RULE_SOFT });
}

for (const county of COUNTIES) {
  const rate = county === "Lee" ? "6.5%" : "6.0%";
  summaryRow(`${county} County — ${rate}`, (r) => r.county === county, { strong: true });
  for (const center of CENTERS_BY_COUNTY[county])
    summaryRow(center, (r) => r.center === center, { indent: 14 });
}
y -= 6;
summaryRow("TOTAL", () => true, { strong: true });

// ══ Detail pages ══════════════════════════════════════════════════════
for (const month of MONTHS) {
  const monthRows = reclass.filter((r) => r.month === month);
  newPage();
  page.drawText(MONTH_LABEL[month].toUpperCase(), { x: M, y: y - 12, size: 9, font: bold, color: ACCENT });
  y -= 30;
  page.drawText(`${MONTH_LABEL[month]} — events to reclassify`, {
    x: M,
    y,
    size: 16,
    font: bold,
    color: INK,
  });
  const mt = usd(sum(monthRows.map((r) => r.taxCents)));
  page.drawText(mt, { x: rightX(mt, monoB, 16, 0, CW), y, size: 16, font: monoB, color: INK });
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: M + CW, y }, thickness: 1, color: INK });
  y -= 22;

  for (const county of COUNTIES) {
    for (const center of CENTERS_BY_COUNTY[county]) {
      const rows = monthRows.filter((r) => r.center === center);
      if (!rows.length) continue;
      ensure(70);

      // Center band
      page.drawRectangle({ x: M, y: y - 18, width: CW, height: 18, color: BAND });
      page.drawText(center, { x: M + 8, y: y - 12.5, size: 10, font: bold, color: INK });
      page.drawText(`${county} County · ${rows[0].rate} · ${rows.length} events`, {
        x: M + 8 + bold.widthOfTextAtSize(center, 10) + 12,
        y: y - 12,
        size: 8,
        font: reg,
        color: FAINT,
      });
      const ct = usd(sum(rows.map((r) => r.taxCents)));
      page.drawText(ct, { x: rightX(ct, monoB, 10, 0, CW - 8), y: y - 12.5, size: 10, font: monoB, color: INK });
      y -= 18;
      tableHeader();

      for (const r of rows) {
        if (y - 14 < M + 26) {
          newPage();
          page.drawText(`${MONTH_LABEL[month]} — ${center} (continued)`, {
            x: M,
            y: y - 11,
            size: 9,
            font: bold,
            color: SOFT,
          });
          y -= 26;
          tableHeader();
        }
        y -= 13.5;
        const cells: Array<[string, (typeof COLS)[number], PDFFont, number]> = [
          [r.date, COLS[0], mono, 8],
          [fit(r.name, reg, 8.5, COLS[1].w), COLS[1], reg, 8.5],
          [r.bmi, COLS[2], mono, 8],
          [r.evt, COLS[3], mono, 8],
          [r.orderId ?? "—", COLS[4], mono, 7],
          [usd(r.taxCents), COLS[5], mono, 8.5],
        ];
        for (const [t, c, f, s] of cells) {
          const x = c.key === "amt" ? rightX(t, f, s, c.x, c.w) : M + c.x;
          page.drawText(t, { x, y, size: s, font: f, color: c.key === "ord" ? FAINT : INK });
        }
        y -= 4;
        page.drawLine({
          start: { x: M, y },
          end: { x: M + CW, y },
          thickness: 0.4,
          color: RULE_SOFT,
        });
      }
      y -= 16;
    }
  }
}

// ══ Method page ═══════════════════════════════════════════════════════
newPage();
page.drawText("NOTES", { x: M, y: y - 12, size: 9, font: bold, color: ACCENT });
y -= 32;
page.drawText("How these figures were derived", { x: M, y, size: 16, font: bold, color: INK });
y -= 10;
page.drawLine({ start: { x: M, y }, end: { x: M + CW, y }, thickness: 1, color: INK });
y -= 24;

const notes: string[] = [
  "Events are grouped by event date, the date the sale is recognised. If group revenue is recognised at deposit or",
  "balance charge instead, individual events may fall in a different month; the combined total does not change.",
  "",
  "The amount to move is the sales tax on the signed contract — the same figure that was written into the Square",
  "order's service-charge field. It equals 6.5% (Lee County) or 6.0% (Collier County) of the taxable subtotal plus",
  "the event service charge.",
  "",
  "Cancelled events are excluded, as no sale took place. Tax-exempt events are excluded.",
  "",
  "Each order total was verified against its signed contract to the cent. No guest was over- or under-charged, and",
  "no amount collected changes as a result of this adjustment.",
  "",
  "The Square order id shown for each event is the day-of order the tax was recorded against, and can be searched",
  "directly in the Square dashboard to view the entry.",
  "",
  "Square orders for events dated after 17 August 2026 already record sales tax in the correct field, so no",
  "adjustment is required for them.",
];
for (const n of notes) {
  if (!n) {
    y -= 8;
    continue;
  }
  page.drawText(n, { x: M, y, size: 9.5, font: reg, color: SOFT });
  y -= 14;
}

// ── Footers ──
const stamp = "Prepared from FastTrax / HeadPinz group-event contract records";
pages.forEach((p, i) => {
  p.drawLine({
    start: { x: M, y: M + 14 },
    end: { x: W - M, y: M + 14 },
    thickness: 0.5,
    color: RULE,
  });
  p.drawText(stamp, { x: M, y: M + 3, size: 7.5, font: reg, color: FAINT });
  const pn = `Page ${i + 1} of ${pages.length}`;
  p.drawText(pn, {
    x: W - M - reg.widthOfTextAtSize(pn, 7.5),
    y: M + 3,
    size: 7.5,
    font: reg,
    color: FAINT,
  });
});

doc.setTitle("Sales Tax Reclassification — Group Events, June–July 2026");
doc.setSubject("Reclassification of collected sales tax recorded as service charges");
doc.setCreator("FastTrax Tools");

writeFileSync(outPath, await doc.save());
console.log(
  `wrote ${outPath} — ${pages.length} pages, ${reclass.length} events, ${usd(grand)}`,
);
