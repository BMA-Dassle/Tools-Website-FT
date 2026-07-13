/**
 * Print-report HTML generators — ported faithfully from the portal's
 * ReservationDetailPage.tsx inline `generateEventDetailHtml` /
 * `generateAttendeesHtml` (same document CSS, tables, sections, banners and
 * esc() escaping), minus the Staff Assignments block (owner decision).
 *
 * The only new content: a "Contract: Signed" line in the overview grid when
 * the website-native contract has a signed PDF.
 *
 * Pure module — no React, safe to import from server or client code.
 */
import { fmtCurrency, fmtEventDateTime, fmtEventTime, personDisplayName } from "./format";
import { isInternalPayMethod, isServiceChargeProduct } from "./logic";
import type { Product, ReservationDetail, WebsitePaymentInfo } from "./types";

/** Safely convert any value to a renderable string (portal `safe`). */
export function safe(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.value === "string") return obj.value;
    return "";
  }
  return String(val);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Portal heuristic: fully paid via a PandaDoc-recorded payment — balance is
 * settled AND at least one payment method name mentions "pandadoc". Kept as
 * the print-banner fallback exactly where the portal used it.
 */
export function isFullyPaidViaPandaDoc(detail: ReservationDetail): boolean {
  if (detail.balance == null || detail.balance > 0) return false;
  if (!Array.isArray(detail.payments) || detail.payments.length === 0) return false;
  return detail.payments.some((p) =>
    (safe(p.payMethodName) || "").toLowerCase().includes("pandadoc"),
  );
}

export function isFullyPaidViaWebsite(wp: WebsitePaymentInfo | null): boolean {
  return wp?.isFullyPaid === true;
}

export function isDepositPaidViaWebsite(wp: WebsitePaymentInfo | null): boolean {
  return wp != null && wp.status === "deposit_paid" && !wp.isFullyPaid;
}

export function generateEventDetailHtml(
  detail: ReservationDetail,
  opts: { foodOutTime: string | null; websitePayment: WebsitePaymentInfo | null },
): string {
  const title = safe(detail.name) || "Event Details";

  let body = "";

  // Fully Paid banner
  if (isFullyPaidViaWebsite(opts.websitePayment) || isFullyPaidViaPandaDoc(detail)) {
    body += `<div class="paid-banner">&#9989; FULLY PAID — All charges on this event have been paid</div>`;
  } else if (isDepositPaidViaWebsite(opts.websitePayment)) {
    body += `<div class="deposit-banner">&#128176; DEPOSIT PAID</div>`;
  }

  // Food Out Time — prominent callout at top
  if (opts.foodOutTime) {
    body += `<div class="food-out-banner">&#127869; Food Out: ${esc(opts.foodOutTime)}</div>`;
  }

  // Contact Person
  if (detail.contactPerson) {
    body += `<h2>Contact Person</h2>`;
    body += `<div style="margin-bottom:8px;"><strong>${esc(
      personDisplayName(detail.contactPerson) || "Unknown",
    )}</strong></div>`;
    if (Array.isArray(detail.contactPerson.addresses)) {
      for (const addr of detail.contactPerson.addresses) {
        const email = safe(addr.email);
        const mobile = safe(addr.mobile);
        const phone = safe(addr.phone);
        const city = safe(addr.city);
        if (email) body += `<div>Email: ${esc(email)}</div>`;
        if (mobile) body += `<div>Mobile: ${esc(mobile)}</div>`;
        if (phone) body += `<div>Phone: ${esc(phone)}</div>`;
        if (city) body += `<div>City: ${esc(city)}</div>`;
      }
    }
  }

  // Overview
  body += `<h2>Overview</h2><div class="overview-grid">`;
  if (detail.when) {
    body += `<span class="grid-label">When:</span><span class="grid-value">${esc(fmtEventDateTime(String(detail.when)))}</span>`;
  }
  if (detail.persons != null) {
    const regCount = Array.isArray(detail.persons_list) ? detail.persons_list.length : 0;
    const personVal =
      regCount > 0 ? `${regCount} / ${detail.persons} registered` : String(detail.persons);
    body += `<span class="grid-label">Persons:</span><span class="grid-value">${esc(personVal)}</span>`;
  }
  if (safe(detail.responsible)) {
    body += `<span class="grid-label">Responsible:</span><span class="grid-value">${esc(safe(detail.responsible))}</span>`;
  }
  if (detail.kind) {
    body += `<span class="grid-label">Type:</span><span class="grid-value">${esc(safe(detail.kind))}</span>`;
  }
  if (detail.validUntil) {
    body += `<span class="grid-label">Valid Until:</span><span class="grid-value">${esc(fmtEventDateTime(String(detail.validUntil)))}</span>`;
  }
  if (detail.creationDate) {
    body += `<span class="grid-label">Created:</span><span class="grid-value">${esc(fmtEventDateTime(String(detail.creationDate)))}</span>`;
  }
  if (detail.balance != null) {
    if (isFullyPaidViaWebsite(opts.websitePayment) || isFullyPaidViaPandaDoc(detail)) {
      body += `<span class="grid-label">Balance:</span><span class="grid-value" style="color:#059669;font-weight:700;">&#9989; PAID</span>`;
    } else if (isDepositPaidViaWebsite(opts.websitePayment)) {
      body += `<span class="grid-label">Balance:</span><span class="grid-value" style="color:#059669;font-weight:600;">&#128176; Deposit Paid</span>`;
    } else {
      body += `<span class="grid-label">Balance:</span><span class="grid-value">${esc(fmtCurrency(detail.balance))}</span>`;
    }
  }
  // Website-native addition: signed contract indicator.
  if (detail.contract?.signedPdfUrl) {
    body += `<span class="grid-label">Contract:</span><span class="grid-value">Signed</span>`;
  }
  body += `</div>`;

  // Schedules
  if (Array.isArray(detail.schedules) && detail.schedules.length > 0) {
    body += `<h2>Schedules</h2><table><thead><tr><th>Start</th><th>Stop</th><th>Resource</th><th>Products</th><th class="r">Persons</th></tr></thead><tbody>`;
    for (const s of detail.schedules) {
      body += `<tr><td>${esc(fmtEventTime(safe(s.start)))}</td><td>${esc(fmtEventTime(safe(s.stop)))}</td><td>${esc(safe(s.resourceName))}</td><td>${esc(safe(s.productLines))}</td><td class="r">${esc(safe(s.persons))}</td></tr>`;
    }
    body += `</tbody></table>`;
  }

  // Products
  if (Array.isArray(detail.products) && detail.products.length > 0) {
    const regular = detail.products.filter((p) => !isServiceChargeProduct(safe(p.productName)));
    const service = detail.products.filter((p) => isServiceChargeProduct(safe(p.productName)));

    const renderProductCell = (p: Product) => {
      const original = safe(p.productName) || `Product ${safe(p.productId)}`;
      const override = safe(p.nameOverride);
      if (override) {
        return `${esc(original)}<div style="font-size:11px;color:#666;">Override: ${esc(override)}</div>`;
      }
      return esc(original);
    };
    if (regular.length > 0) {
      body += `<h2>Products</h2><table><thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Total</th></tr></thead><tbody>`;
      for (const p of regular) {
        body += `<tr><td>${renderProductCell(p)}</td><td class="r">${esc(safe(p.quantity))}</td><td class="r">${esc(fmtCurrency(p.totalPrice || 0))}</td></tr>`;
      }
      body += `</tbody></table>`;
    }
    if (service.length > 0) {
      body += `<h2>Service Charges &amp; Gratuity</h2><table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Total</th></tr></thead><tbody>`;
      for (const p of service) {
        body += `<tr><td>${renderProductCell(p)}</td><td class="r">${esc(safe(p.quantity))}</td><td class="r">${esc(fmtCurrency(p.totalPrice || 0))}</td></tr>`;
      }
      body += `</tbody></table>`;
    }
  }

  // Payments (filtered — hide BMI internal methods)
  if (Array.isArray(detail.payments) && detail.payments.length > 0) {
    const visiblePays = detail.payments.filter(
      (pay) => !isInternalPayMethod(safe(pay.payMethodName)),
    );
    if (visiblePays.length > 0) {
      body += `<h2>Payments</h2><table><thead><tr><th>Method</th><th class="r">Amount</th></tr></thead><tbody>`;
      for (const pay of visiblePays) {
        body += `<tr><td>${esc(safe(pay.payMethodName) || `Method ${safe(pay.payMethodId)}`)}</td><td class="r">${esc(fmtCurrency(pay.amount || 0))}</td></tr>`;
      }
      body += `</tbody></table>`;
    }
  }

  // Notes / Memos (private notes included)
  if (Array.isArray(detail.logs) && detail.logs.length > 0) {
    body += `<h2>Notes / Memos</h2>`;
    for (const log of detail.logs) {
      const memo = safe(log.memo);
      if (!memo) continue;
      body += `<div class="note-block">`;
      body += `<div class="note-text">${esc(memo)}</div>`;
      const meta: string[] = [];
      if (safe(log.updated)) meta.push(esc(fmtEventDateTime(safe(log.updated))));
      if (safe(log.updatedBy)) meta.push(`by ${esc(safe(log.updatedBy))}`);
      if (log.isPublic === false) meta.push("<em>(private)</em>");
      if (meta.length > 0) body += `<div class="note-meta">${meta.join(" &middot; ")}</div>`;
      body += `</div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; padding: 20px; }
    .r { text-align: right; }

    .report-header { text-align: center; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 2px solid #333; }
    .report-header h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
    .report-header .subtitle { font-size: 13px; color: #555; }
    .report-header .meta { font-size: 11px; color: #888; margin-top: 4px; }

    h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #4a5568; margin: 20px 0 6px; padding: 6px 8px; background: #edf2f7; border-left: 3px solid #4a5568; }

    .overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; padding: 8px; }
    .grid-label { color: #666; font-size: 11px; }
    .grid-value { font-weight: 600; font-size: 12px; }

    .paid-banner { background: #d1fae5; border: 2px solid #10b981; border-radius: 8px; padding: 12px 16px; font-size: 16px; font-weight: 700; color: #065f46; text-align: center; margin-bottom: 16px; }
    .deposit-banner { background: #d1fae5; border: 2px solid #34d399; border-radius: 8px; padding: 12px 16px; font-size: 16px; font-weight: 700; color: #065f46; text-align: center; margin-bottom: 16px; }
    .food-out-banner { background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 12px 16px; font-size: 16px; font-weight: 700; color: #92400e; text-align: center; margin-bottom: 16px; }

    table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 11px; }
    th { background: #f7fafc; border-bottom: 2px solid #e2e8f0; padding: 5px 8px; text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #4a5568; }
    td { padding: 5px 8px; border-bottom: 1px solid #edf2f7; }

    .note-block { background: #f7fafc; border-left: 3px solid #cbd5e0; padding: 8px 12px; margin: 6px 0; border-radius: 0 4px 4px 0; }
    .note-text { white-space: pre-wrap; font-size: 11px; color: #1a1a1a; }
    .note-meta { font-size: 10px; color: #999; margin-top: 4px; }

    @media print { body { padding: 0; } .no-print { display: none !important; } }
    @page { margin: 0.5in; }
  </style>
</head>
<body>
  <div class="no-print" style="text-align:center;margin-bottom:16px;">
    <button onclick="window.print()" style="padding:10px 24px;font-size:14px;font-weight:600;background:#4a5568;color:#fff;border:none;border-radius:6px;cursor:pointer;">
      Print / Save as PDF
    </button>
  </div>

  <div class="report-header">
    <h1>${esc(title)}</h1>
    <div class="subtitle">#${esc(safe(detail.number) || safe(detail.id))}${detail.state ? ` &mdash; ${esc(safe(detail.state))}` : ""}</div>
    <div class="meta">${detail.when ? esc(fmtEventDateTime(String(detail.when))) : ""}</div>
  </div>

  ${body}
</body>
</html>`;
}

export function generateAttendeesHtml(detail: ReservationDetail): string {
  const title = safe(detail.name) || "Event";
  const persons = Array.isArray(detail.persons_list) ? detail.persons_list : [];

  let rows = "";
  if (persons.length === 0) {
    rows =
      '<tr><td colspan="3" style="color:#999;font-style:italic;padding:12px 8px;">No registered attendees</td></tr>';
  } else {
    for (let i = 0; i < persons.length; i++) {
      const p = persons[i];
      const email = safe(p.addresses?.[0]?.email);
      rows += `<tr><td class="num">${i + 1}</td><td>${esc(personDisplayName(p) || "Unknown")}</td><td class="email">${email ? esc(email) : ""}</td></tr>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Attendees – ${esc(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; padding: 20px; }

    .report-header { text-align: center; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 2px solid #333; }
    .report-header h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
    .report-header .subtitle { font-size: 13px; color: #555; }
    .report-header .meta { font-size: 11px; color: #888; margin-top: 4px; }

    h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #4a5568; margin: 0 0 8px; padding: 6px 8px; background: #edf2f7; border-left: 3px solid #4a5568; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #f7fafc; border-bottom: 2px solid #e2e8f0; padding: 6px 8px; text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #4a5568; }
    td { padding: 6px 8px; border-bottom: 1px solid #edf2f7; }
    .num { width: 40px; text-align: right; color: #999; }
    .email { color: #555; font-size: 11px; }

    @media print { body { padding: 0; } .no-print { display: none !important; } }
    @page { margin: 0.5in; }
  </style>
</head>
<body>
  <div class="no-print" style="text-align:center;margin-bottom:16px;">
    <button onclick="window.print()" style="padding:10px 24px;font-size:14px;font-weight:600;background:#4a5568;color:#fff;border:none;border-radius:6px;cursor:pointer;">
      Print / Save as PDF
    </button>
  </div>

  <div class="report-header">
    <h1>${esc(title)}</h1>
    <div class="subtitle">${detail.when ? esc(fmtEventDateTime(String(detail.when))) : ""}${detail.state ? ` &mdash; ${esc(safe(detail.state))}` : ""}</div>
    <div class="meta">Registered: ${persons.length}${detail.persons ? ` / ${detail.persons}` : ""}</div>
  </div>

  <h2>Registered Attendees (${persons.length})</h2>
  <table>
    <thead><tr><th style="width:40px">#</th><th>Name</th><th>Email</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}
