/**
 * CSV export of exactly what the board is showing.
 *
 * ONE QUERY PATH. The route builds the export from the same adapter `list()` the
 * screen uses, so the file can never disagree with the table above it. The only
 * differences are that the export ignores the cursor and carries the columns the
 * table drops for width (voucher codes, Square ids, the full contact set).
 *
 * MONEY IS PLAIN DECIMAL, NO CURRENCY SIGN. `36.21` is a number to a spreadsheet;
 * `$36.21` is text, and a column of text does not sum. Ops reconcile these
 * against Square by summing them.
 *
 * DATES BOTH WAYS. `Sold (ET)` is what a human reads and matches the board;
 * `Sold (ISO)` is what sorts correctly and survives a re-import. Excel mangles
 * one or the other depending on locale, so ship both and let the reader pick.
 */

import type { RefundState, WebSaleRow } from "../types";

/**
 * RFC 4180 quoting. A field is quoted when it contains a comma, a quote, a
 * newline, or leading/trailing whitespace a reader would silently eat; embedded
 * quotes double.
 *
 * The leading `'` on values starting with `=`, `+`, `-` or `@` is deliberate:
 * without it a buyer whose name begins with `=` becomes a live formula when the
 * file is opened. Guest-supplied strings land in this file, so treat every one of
 * them as hostile.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  if (raw === "") return "";
  const injectionRisk = /^[=+\-@\t\r]/.test(raw);
  const body = injectionRisk ? `'${raw}` : raw;
  const mustQuote = /[",\r\n]/.test(body) || body !== body.trim();
  return mustQuote ? `"${body.replace(/"/g, '""')}"` : body;
}

export function csvRow(cells: Array<string | number | null | undefined>): string {
  return cells.map(csvCell).join(",");
}

const dollars = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);

function easternTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { timeZone: "America/New_York" });
}

function refundLabel(refund: RefundState): string {
  switch (refund.kind) {
    case "none":
      return "";
    case "voided":
      return "voided";
    default:
      return refund.destination ? `${refund.kind} → ${refund.destination}` : refund.kind;
  }
}

function refundedCents(refund: RefundState): number | null {
  return refund.kind === "partial" || refund.kind === "full" ? refund.refundedCents : null;
}

/** Column order. Exported so a test can pin it against what the table renders. */
export const CSV_COLUMNS = [
  "Sold (ET)",
  "Sold (ISO)",
  "Source",
  "Product",
  "Detail",
  "Qty",
  "Paid",
  "Subtotal",
  "Tax",
  "Status",
  "Needs attention",
  "Refund",
  "Refunded",
  "Buyer",
  "Buyer email",
  "Buyer phone",
  "Recipient",
  "Recipient email",
  "Recipient phone",
  "Venue",
  "Attribution",
  "Square order",
  "Square payments",
  "Reference",
] as const;

export function toCsv(rows: WebSaleRow[]): string {
  const lines = [csvRow([...CSV_COLUMNS])];
  for (const r of rows) {
    lines.push(
      csvRow([
        easternTimestamp(r.soldAt),
        r.soldAt,
        r.source,
        r.product.label,
        r.product.sublabel,
        r.product.qty,
        dollars(r.money.paidCents),
        dollars(r.money.subtotalCents),
        dollars(r.money.taxCents),
        r.status.label,
        r.status.problem,
        refundLabel(r.refund),
        dollars(refundedCents(r.refund)),
        r.buyer.name,
        r.buyer.email,
        r.buyer.phone,
        r.buyer.recipientName,
        r.buyer.recipientEmail,
        r.buyer.recipientPhone,
        r.venue.label,
        r.attribution.label,
        r.square.orderId,
        r.square.paymentIds.join(" "),
        // The searchable handles — voucher codes for a deal pack, txn ids for a
        // reload. This is the column ops paste back into the board's search box.
        r.searchTerms.join(" "),
      ]),
    );
  }
  // Trailing newline: POSIX tools and Excel both prefer a terminated last line.
  return lines.join("\r\n") + "\r\n";
}

/** `web-sales-2026-07-05_2026-08-03.csv` */
export function csvFilename(from: string, to: string): string {
  return `web-sales-${from}_${to}.csv`;
}
