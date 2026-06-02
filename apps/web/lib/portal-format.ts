import { type GroupFunctionQuote, parseGiftCardGans } from "@/lib/group-function-db";

const FULLY_PAID_STATUSES = new Set(["balance_charged", "completed"]);

function isFullyPaid(q: GroupFunctionQuote): boolean {
  if (FULLY_PAID_STATUSES.has(q.status)) return true;
  if (q.status === "deposit_paid" && q.balance_cents <= 0) return true;
  return false;
}

function venueFromCenter(code: string): string {
  return code || "unknown";
}

interface PaymentEntry {
  type: "deposit" | "balance" | "legacy";
  amountCents: number;
  method: string;
  squarePaymentId: string | null;
  squareOrderId?: string | null;
  paidAt: string | null;
}

function buildPayments(q: GroupFunctionQuote): PaymentEntry[] {
  const payments: PaymentEntry[] = [];
  if (q.deposit_paid_at && q.square_deposit_payment_id) {
    const isLegacy = q.square_deposit_payment_id.startsWith("legacy-comp-");
    if (!isLegacy) {
      payments.push({
        type: "deposit",
        amountCents: q.deposit_due_cents,
        method: "card",
        squarePaymentId: q.square_deposit_payment_id,
        squareOrderId: q.square_deposit_order_id,
        paidAt: q.deposit_paid_at,
      });
    }
  }
  if (q.balance_paid_at && q.square_balance_payment_id) {
    payments.push({
      type: "balance",
      amountCents: q.total_cents - q.deposit_due_cents,
      method: q.balance_payment_method || "card",
      squarePaymentId: q.square_balance_payment_id,
      squareOrderId: q.square_balance_order_id,
      paidAt: q.balance_paid_at,
    });
  }
  return payments;
}

interface PriorPaymentEntry {
  amountCents: number;
  source: string;
  paidAt: string | null;
}

function buildPriorPayments(q: GroupFunctionQuote): PriorPaymentEntry[] {
  const raw = (q.prior_payments ?? []) as Array<{ amount: number; paid?: string }>;
  return raw
    .filter((p) => p.amount > 0)
    .map((p) => ({
      amountCents: Math.round(p.amount * 100),
      source: "bmi_legacy",
      paidAt: p.paid || null,
    }));
}

export function formatPaymentSummary(q: GroupFunctionQuote) {
  return {
    bmiCode: q.bmi_reservation_id,
    venue: venueFromCenter(q.center_code),
    status: q.status,
    isFullyPaid: isFullyPaid(q),
    totalCents: q.total_cents,
    depositPaidCents: q.deposit_paid_at ? q.deposit_due_cents : 0,
    balanceRemainingCents: q.balance_cents,
    payments: buildPayments(q),
    priorPayments: buildPriorPayments(q),
    giftCardGans: parseGiftCardGans(q.square_gift_card_gan),
    savedCardOnFile: Boolean(q.saved_card_id),
  };
}

export function formatPaymentDetail(q: GroupFunctionQuote) {
  return {
    ...formatPaymentSummary(q),
    depositDueCents: q.deposit_due_cents,
    balancePaymentLinkUrl: q.balance_payment_link_url || null,
    depositAttempts: q.deposit_attempts,
    depositLastError: q.deposit_last_error || null,
    balanceChargeAttempts: q.balance_charge_attempts,
    balanceLastError: q.balance_last_error || null,
  };
}

function categorizeLineItem(item: { name: string; tax?: number }): string {
  const n = item.name.toLowerCase();
  if (n.includes("service charge")) return "service_charge";
  if (n.includes("tax exempt")) return "tax_exempt";
  return "revenue";
}

export function formatDocumentSummary(q: GroupFunctionQuote) {
  const serviceChargeCents = ((q.line_items ?? []) as Array<{ name: string; total: number }>)
    .filter((i) => i.name.toLowerCase().includes("service charge"))
    .reduce((sum, i) => sum + Math.round(i.total * 100), 0);

  return {
    id: q.contract_short_id,
    bmiCode: q.bmi_reservation_id,
    venue: venueFromCenter(q.center_code),
    status: q.status,
    contractStatus: q.contract_status || null,
    plannerEmail: q.planner_email || null,
    plannerName: q.planner_first ? `${q.planner_first} ${q.planner_last || ""}`.trim() : null,
    guestEmail: q.guest_email,
    guestName: `${q.guest_first_name} ${q.guest_last_name}`,
    recipientLink: q.contract_short_id
      ? `${q.base_url || "https://headpinz.com"}/contract/${q.contract_short_id}`
      : null,
    eventName: q.event_name || null,
    eventDate: q.event_date,
    totalCents: q.total_cents,
    serviceChargeCents,
    taxCents: q.tax_cents,
    isTaxExempt: q.is_tax_exempt,
    dateCreated: q.created_at,
    dateSent: q.contract_sent_at || null,
    dateSigned: q.contract_signed_at || null,
    dateModified: q.updated_at,
    hasPdf: Boolean(q.signed_pdf_url),
  };
}

export function formatDocumentDetail(q: GroupFunctionQuote) {
  const lineItems = (
    (q.line_items ?? []) as Array<{
      name: string;
      price: number;
      tax: number;
      qty: number;
      total: number;
      plu?: string;
    }>
  ).map((item) => ({
    name: item.name,
    category: categorizeLineItem(item),
    unitPriceCents: Math.round(item.price * 100),
    qty: item.qty,
    totalCents: Math.round(item.total * 100),
    plu: item.plu || null,
  }));

  const serviceChargeCents = lineItems
    .filter((i) => i.category === "service_charge")
    .reduce((sum, i) => sum + i.totalCents, 0);

  const summary = formatDocumentSummary(q);

  return {
    ...summary,
    approvalRequired: q.approval_required,
    guestPhone: q.guest_phone || null,
    eventNumber: q.event_number || null,
    eventDateDisplay: q.event_date_display || null,
    guestCount: q.guest_count || null,
    notes: q.notes || null,
    lineItems,
    serviceChargeCents,
    eligibleCents: q.total_cents - serviceChargeCents,
    priorPayments: buildPriorPayments(q),
    isFullyPaid: isFullyPaid(q),
    depositDueCents: q.deposit_due_cents,
    depositPaidCents: q.deposit_paid_at ? q.deposit_due_cents : 0,
    balanceRemainingCents: q.balance_cents,
    dateCompleted: q.dayof_paid_at || null,
    hasPdf: Boolean(q.signed_pdf_url),
    pdfUrl: q.signed_pdf_url || null,
  };
}
