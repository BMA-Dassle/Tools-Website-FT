/**
 * Hermes BMI API client.
 *
 * Hermes (bma-bmi-hermes.azurewebsites.net) is a Node.js bridge that
 * polls BMI's Firebird databases and queues PandaDoc-ready event quotes.
 * We consume its queue, create PandaDoc contracts ourselves, then call
 * /complete to acknowledge processing.
 *
 * Endpoints:
 *   GET  /queue/pandadoc                — pending quotes, fully enriched
 *   POST /queue/pandadoc/complete       — mark item processed
 *   GET  /products/:center              — full product catalog with PLU codes
 *   GET  /products/:center/:reservationId — reservation products with PLU codes
 */

const HERMES_BASE = process.env.HERMES_BASE_URL || "https://bma-bmi-hermes.azurewebsites.net";

// ── Types ───────────────────────────────────────────────────────────

export interface HermesQueueItem {
  queueId: number;
  logId: number;
  center: string;
  centerName: string;
  subject: string;
  reservationId: string;
  event: {
    name: string;
    date: string;
    dateRaw: string;
    notes: string;
    number: string;
  };
  customer: {
    email: string;
    first: string;
    last: string;
    phone: string;
  };
  planner: {
    email: string;
    first: string;
    last: string;
    phone: string;
  };
  products: HermesProduct[];
  payments: HermesPayment[];
  tax: number;
  totalBill: number;
  depositDue: number;
  error?: string;
}

export interface HermesProduct {
  name: string;
  overrideName: string | null;
  price: number;
  tax: number;
  qty: number;
  total: number;
  plu: string;
}

export interface HermesPayment {
  paid: string;
  amount: number;
}

// ── Center mapping ──────────────────────────────────────────────────

export interface CenterInfo {
  centerCode: string;
  squareLocationId: string;
  brand: "headpinz" | "fasttrax";
  baseUrl: string;
  ganPrefix: string;
}

export const HERMES_CENTER_MAP: Record<string, CenterInfo> = {
  "10.48.0.14": {
    centerCode: "fort-myers",
    squareLocationId: "TXBSQN0FEKQ11",
    brand: "headpinz",
    baseUrl: "https://headpinz.com",
    ganPrefix: "HPFM",
  },
  "10.48.0.14_FT": {
    centerCode: "fasttrax",
    squareLocationId: "LAB52GY480CJF",
    brand: "fasttrax",
    baseUrl: "https://fasttraxent.com",
    ganPrefix: "GRPF",
  },
  "10.40.0.43": {
    centerCode: "naples",
    squareLocationId: "PPTR5G2N0QXF7",
    brand: "headpinz",
    baseUrl: "https://headpinz.com",
    ganPrefix: "HPN",
  },
};

export function resolveCenter(hermesCenter: string) {
  return HERMES_CENTER_MAP[hermesCenter] ?? null;
}

// ── API calls ───────────────────────────────────────────────────────

export async function fetchHermesEnrichedEvents(): Promise<HermesQueueItem[]> {
  const res = await fetch(`${HERMES_BASE}/queue/pandadoc`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Hermes enriched events failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchHermesReservation(
  center: string,
  reservationId: string,
): Promise<HermesQueueItem | null> {
  const res = await fetch(`${HERMES_BASE}/reservation/${center}/${reservationId}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function completePandaDocQueue(params: {
  center: string;
  queueId: number;
  logId: number;
  message?: string;
}): Promise<void> {
  const body = {
    center: params.center,
    queueId: params.queueId,
    logId: params.logId,
    message:
      params.message ??
      `Completed ${new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })}`,
  };
  const res = await fetch(`${HERMES_BASE}/queue/pandadoc/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hermes /queue/pandadoc/complete failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function fetchReservationProducts(
  center: string,
  reservationId: string,
): Promise<HermesProduct[]> {
  const res = await fetch(`${HERMES_BASE}/products/${center}/${reservationId}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Hermes /products/${center}/${reservationId} failed: ${res.status}`);
  }
  return res.json();
}

// ── Template selection (mirrors Hermes logic) ───────────────────────

export type PandaDocTemplate = "deposit" | "postpay" | "nopayment";

export const PANDADOC_TEMPLATE_IDS: Record<PandaDocTemplate, string> = {
  deposit: "ZLFSeVQAaUVwVapcm3BEv8",
  postpay: "ps8LCsGgSEkXSFJvrGmKUd",
  nopayment: "ZLFSeVQAaUVwVapcm3BEv8",
};

export function selectTemplate(item: HermesQueueItem): PandaDocTemplate {
  const hasPostPaid = item.products.some((p) => p.name === "GF Post Paid Account");
  if (hasPostPaid) return "postpay";

  const billChangeAmount = item.depositDue * 2;
  if (billChangeAmount < item.totalBill * 0.15 || billChangeAmount < 100) {
    return "nopayment";
  }

  return "deposit";
}

// ── Special product detection ───────────────────────────────────────

export function isTaxExempt(products: HermesProduct[]): boolean {
  return products.some((p) => p.name === "GF Tax Exempt");
}
