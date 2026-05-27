/**
 * PandaDoc API helper for group function contracts.
 *
 * Handles document creation from template, sending, signing session
 * generation, and webhook HMAC-SHA256 verification.
 *
 * PandaDoc API base: https://api.pandadoc.com/public/v1
 * Rate limit: respect 1 request per 15 seconds for document creation.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { GroupFunctionQuote } from "@/lib/group-function-db";
import {
  type HermesQueueItem,
  isTaxExempt,
  selectTemplate,
  PANDADOC_TEMPLATE_IDS,
} from "@/lib/hermes-client";

const PANDADOC_BASE = "https://api.pandadoc.com/public/v1";

// ── Per-workspace API keys ──────────────────────────────────────────

const API_KEYS: Record<string, string> = {
  "fort-myers": process.env.PANDA_FTMYERS || "",
  fasttrax: process.env.PANDA_FT || "",
  naples: process.env.PANDA_NAPLES || "",
};

const WEBHOOK_KEYS: Record<string, string> = {
  "fort-myers": process.env.PANDADOC_WEBHOOK_SHARED_KEY_HPFM || "",
  fasttrax: process.env.PANDADOC_WEBHOOK_SHARED_KEY_FT || "",
  naples: process.env.PANDADOC_WEBHOOK_SHARED_KEY_NAPLES || "",
};

function authHeaders(centerCode: string) {
  const key = API_KEYS[centerCode];
  if (!key) throw new Error(`No PandaDoc API key for center: ${centerCode}`);
  return {
    Authorization: `API-Key ${key}`,
    "Content-Type": "application/json",
  };
}

// ── Document creation ───────────────────────────────────────────────

export interface CreateDocumentResult {
  documentId: string;
  status: string;
}

export function buildDocumentBody(item: HermesQueueItem) {
  const template = selectTemplate(item);
  const templateId = PANDADOC_TEMPLATE_IDS[template];
  const taxExempt = isTaxExempt(item.products);

  const productRows = item.products.map((p) => ({
    options: {},
    data: {
      Name: p.overrideName || p.name,
      Price: p.price,
      Qty: p.qty,
      FakeSubtotal: { value: 100 * p.qty, type: "percent" },
      Discount: { value: 100 * p.qty, type: "percent" },
    },
  }));

  if (!taxExempt && item.tax > 0) {
    productRows.push({
      options: {},
      data: {
        Name: "Tax",
        Price: item.tax,
        Qty: 1,
        FakeSubtotal: { value: 100, type: "percent" },
        Discount: { value: 100, type: "percent" },
      },
    });
  }

  const pricingTables: Record<string, unknown>[] = [
    {
      name: "Pricing Table 1",
      data_merge: true,
      options: {},
      sections: [{ default: true, rows: productRows }],
    },
  ];

  if (item.payments.length > 0) {
    const depositRows = item.payments.map((pmt) => {
      const d = new Date(pmt.paid);
      const label = `Paid Deposit ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
      return {
        options: {},
        data: {
          Name: label,
          Price: pmt.amount,
          Qty: 1,
          FakeSubtotal: { value: 100, type: "percent" },
        },
      };
    });
    pricingTables.push({
      name: "Pricing Table 2",
      data_merge: true,
      options: {},
      sections: [{ default: true, rows: depositRows }],
    });
  }

  const recipients: Record<string, unknown>[] = [
    {
      email: item.customer.email,
      first_name: item.customer.first,
      last_name: item.customer.last,
      phone: item.customer.phone,
      role: "Customer",
    },
    {
      email: item.planner.email,
      first_name: item.planner.first,
      last_name: item.planner.last,
      phone: item.planner.phone,
      role: "Planner",
    },
  ];

  if (template === "postpay") {
    recipients.push({
      email: "yicela@headpinz.com",
      first_name: "Yicela",
      last_name: "Almeida",
      role: "AccountsPayable",
    });
  }

  return {
    template,
    templateId,
    body: {
      name: `Event Quote - ${item.event.number} -  ${item.event.name}`,
      template_uuid: templateId,
      recipients,
      tokens: [
        { name: "EventCenter", value: item.centerName },
        { name: "EventDate", value: item.event.date },
        { name: "EventName", value: item.event.name },
        { name: "EventNotes", value: item.event.notes || "" },
        { name: "EventDeposit", value: String(item.depositDue) },
        { name: "EventTotal", value: String(item.totalBill) },
      ],
      metadata: {
        reservationID: item.reservationId,
        eventTotal: item.totalBill,
      },
      pricing_tables: pricingTables,
    },
  };
}

export async function createDocument(
  centerCode: string,
  body: Record<string, unknown>,
): Promise<CreateDocumentResult> {
  const res = await fetch(`${PANDADOC_BASE}/documents`, {
    method: "POST",
    headers: authHeaders(centerCode),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`PandaDoc create failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { documentId: data.id, status: data.status };
}

// ── Wait for draft ──────────────────────────────────────────────────

export async function waitForDraft(
  centerCode: string,
  documentId: string,
  maxWaitMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${PANDADOC_BASE}/documents/${documentId}`, {
      headers: authHeaders(centerCode),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.status === "document.draft") return;
      if (data.status === "document.error") {
        throw new Error(`PandaDoc document errored: ${documentId}`);
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`PandaDoc document ${documentId} did not reach draft within ${maxWaitMs}ms`);
}

// ── Send document ───────────────────────────────────────────────────

export async function sendDocument(
  centerCode: string,
  documentId: string,
  plannerEmail: string,
): Promise<void> {
  const res = await fetch(`${PANDADOC_BASE}/documents/${documentId}/send`, {
    method: "POST",
    headers: authHeaders(centerCode),
    body: JSON.stringify({
      silent: false,
      sender: { email: plannerEmail },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`PandaDoc send failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
}

// ── Signing session ─────────────────────────────────────────────────

export interface SigningSession {
  id: string;
  expires_at: string;
}

export async function createSigningSession(
  centerCode: string,
  documentId: string,
  recipientEmail: string,
): Promise<SigningSession> {
  const res = await fetch(`${PANDADOC_BASE}/documents/${documentId}/session`, {
    method: "POST",
    headers: authHeaders(centerCode),
    body: JSON.stringify({ recipient: recipientEmail }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`PandaDoc session failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { id: data.id, expires_at: data.expires_at };
}

// ── Search existing documents ───────────────────────────────────────

export async function searchDocumentsByReservation(
  centerCode: string,
  reservationId: string,
): Promise<Array<{ id: string; name: string; status: string }>> {
  const params = new URLSearchParams({
    metadata_reservationID: reservationId,
  });
  const res = await fetch(`${PANDADOC_BASE}/documents?${params}`, {
    headers: authHeaders(centerCode),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results ?? []).map((d: { id: string; name: string; status: string }) => ({
    id: d.id,
    name: d.name,
    status: d.status,
  }));
}

// ── Cancel/void existing documents ──────────────────────────────────

export async function cancelDocument(centerCode: string, documentId: string): Promise<boolean> {
  const res = await fetch(`${PANDADOC_BASE}/documents/${documentId}/status`, {
    method: "PATCH",
    headers: authHeaders(centerCode),
    body: JSON.stringify({ status: "document.voided" }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

// ── Webhook HMAC verification ───────────────────────────────────────

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHex: string,
): { valid: boolean; centerCode: string | null } {
  for (const [center, key] of Object.entries(WEBHOOK_KEYS)) {
    if (!key) continue;
    const expected = createHmac("sha256", key).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(signatureHex, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) {
      return { valid: true, centerCode: center };
    }
  }
  return { valid: false, centerCode: null };
}

// ── Helpers ─────────────────────────────────────────────────────────

export function pandaDocEmbedUrl(sessionId: string): string {
  return `https://app.pandadoc.com/s/${sessionId}`;
}

/**
 * Build PandaDoc document body from an already-persisted quote row.
 * Used when retrying / manually creating from the admin endpoint.
 */
export function buildDocumentBodyFromQuote(quote: GroupFunctionQuote) {
  const lineItems = quote.line_items as Array<{
    name: string;
    price: number;
    tax: number;
    qty: number;
    total: number;
    plu: string;
  }>;
  const payments = quote.prior_payments as Array<{
    paid: string;
    amount: number;
  }>;
  const taxExempt = lineItems.some((p) => p.name === "GF Tax Exempt");

  const productRows = lineItems.map((p) => ({
    options: {},
    data: {
      Name: p.name,
      Price: p.price,
      Qty: p.qty,
      FakeSubtotal: { value: 100 * p.qty, type: "percent" },
      Discount: { value: 100 * p.qty, type: "percent" },
    },
  }));

  if (!taxExempt && quote.tax_cents > 0) {
    productRows.push({
      options: {},
      data: {
        Name: "Tax",
        Price: quote.tax_cents / 100,
        Qty: 1,
        FakeSubtotal: { value: 100, type: "percent" },
        Discount: { value: 100, type: "percent" },
      },
    });
  }

  const pricingTables: Record<string, unknown>[] = [
    {
      name: "Pricing Table 1",
      data_merge: true,
      options: {},
      sections: [{ default: true, rows: productRows }],
    },
  ];

  if (payments.length > 0) {
    const depositRows = payments.map((pmt) => {
      const d = new Date(pmt.paid);
      const label = `Paid Deposit ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
      return {
        options: {},
        data: {
          Name: label,
          Price: pmt.amount,
          Qty: 1,
          FakeSubtotal: { value: 100, type: "percent" },
        },
      };
    });
    pricingTables.push({
      name: "Pricing Table 2",
      data_merge: true,
      options: {},
      sections: [{ default: true, rows: depositRows }],
    });
  }

  const templateId = quote.pandadoc_template_id || PANDADOC_TEMPLATE_IDS.deposit;
  const template = (quote.pandadoc_template as "deposit" | "postpay" | "nopayment") || "deposit";

  const recipients: Record<string, unknown>[] = [
    {
      email: quote.guest_email,
      first_name: quote.guest_first_name,
      last_name: quote.guest_last_name,
      phone: quote.guest_phone || "",
      role: "Customer",
    },
    {
      email: quote.planner_email || "",
      first_name: quote.planner_first || "",
      last_name: quote.planner_last || "",
      phone: quote.planner_phone || "",
      role: "Planner",
    },
  ];

  if (template === "postpay") {
    recipients.push({
      email: "yicela@headpinz.com",
      first_name: "Yicela",
      last_name: "Almeida",
      role: "AccountsPayable",
    });
  }

  return {
    template,
    templateId,
    body: {
      name: `Event Quote - ${quote.event_number || ""} -  ${quote.event_name || ""}`,
      template_uuid: templateId,
      recipients,
      tokens: [
        { name: "EventCenter", value: quote.center_name },
        { name: "EventDate", value: quote.event_date_display || "" },
        { name: "EventName", value: quote.event_name || "" },
        { name: "EventNotes", value: quote.notes || "" },
        { name: "EventDeposit", value: String(quote.deposit_due_cents / 100) },
        { name: "EventTotal", value: String(quote.total_cents / 100) },
      ],
      metadata: {
        reservationID: quote.bmi_reservation_id,
        eventTotal: quote.total_cents / 100,
      },
      pricing_tables: pricingTables,
    },
  };
}
