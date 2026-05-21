/**
 * BMI adapter — typed wrapper around BMI Leisure's public API.
 *
 * Wraps the existing `/api/bmi?endpoint=<name>` server proxy route (v1) so
 * v2 doesn't fork BMI plumbing. The adapter normalizes:
 *   - raw-ID precision (uses @ft/db.stringifyWithRawIds for any payload
 *     that carries personId / orderId / billLineId — BMI IDs are 17 digits
 *     and JSON.stringify silently corrupts them).
 *   - mock-mode (returns deterministic fixtures when LOCAL_BMI_MOCK=1, so a
 *     fresh clone can run the wizard without BMI credentials).
 *   - response parsing (extracts raw orderId / orderItemId from response
 *     text via regex, NOT JSON.parse, to preserve precision on the way
 *     back too).
 *
 * The adapter intentionally does NOT do product-catalog logic (tier
 * filtering, schedule resolution, race-tier registry). That lives in the
 * service layer (commit 7: features/booking/service/race-products.ts).
 *
 * Square-attribute resolution (the BMI Item ID custom attribute on Square
 * catalog items + v1 PRODUCT_ATTRACTION_MAP fallback) also lives in the
 * service layer — see commit 7 `data/square-catalog.ts`. The BMI adapter
 * just takes a BMI productId and trusts it.
 */
import { stringifyWithRawIds } from "@ft/db";
import { isMockMode } from "./mock-mode";
import {
  fixtureAvailability,
  fixtureBookResponse,
  fixtureOrderOverview,
  fixturePersonId,
  type MockBookSession,
} from "./__fixtures__/bmi";

// ─────────────────────────── shared BMI types ────────────────────────────
// Mirror of the slice we touch in v1's lib/attractions-data + app/book/race/data.
// Kept narrow on purpose — the adapter exposes only what the service layer
// needs, not BMI's full surface.

export interface BmiPrice {
  amount: number;
  kind: number; // 0 = price, 1 = return
  shortName: string;
  depositKind: number; // 0 = money, 1 = point, 2 = credit
}

export interface BmiBlock {
  name: string;
  capacity: number;
  freeSpots: number;
  resourceId: number;
  prices: BmiPrice[];
  start: string;
  stop: string;
  bookingMode?: number;
  showSessionTimes?: boolean;
}

export interface BmiProposalBlock {
  productLineIds: number[];
  block: BmiBlock;
}

export interface BmiProposal {
  blocks: BmiProposalBlock[];
  productLineId: number | null;
}

export interface BmiAvailabilityResponse {
  proposals: BmiProposal[];
}

export interface BmiBookResult {
  /**
   * Raw orderId extracted from response text via regex — preserves precision
   * for the 17-digit BMI IDs that JSON.parse would corrupt.
   */
  rawOrderId: string;
  /** Raw orderItemId (bill line). Same precision rules as orderId. */
  billLineId: string | null;
  /** Parsed JSON result (without the raw IDs — caller uses rawOrderId/billLineId). */
  result: {
    success: boolean;
    errorMessage: string | null;
    schedules?: Array<{ start: string; name: string; quantity: number; resourceId: number }>;
    prices?: BmiPrice[];
    parentBillLineId?: number;
    projectId?: number;
  };
}

export interface BmiOrderOverview {
  rawOrderId: string;
  reservationNumber: string | null;
  reservationCode: string | null;
  lines: Array<{
    productId: string;
    name: string;
    quantity: number;
    amount: number;
    track?: string | null;
    start?: string;
    stop?: string;
  }>;
}

export interface CreatePersonArgs {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** BMI client key override (default: derive from brand + center). */
  clientKey?: string;
}

export interface GetAvailabilityArgs {
  /** YYYY-MM-DD */
  date: string;
  /** BMI productId (digit string). */
  productId: string;
  /** BMI pageId (digit string). Required by BMI for `/availability` POST. */
  pageId: string;
  /** Per-pack: number of seats / racers requested. Defaults to 1. */
  quantity?: number;
  clientKey?: string;
}

export interface BookHeatArgs {
  productId: string;
  quantity: number;
  proposal: BmiProposal;
  /** When set, chains this heat to the same BMI bill. */
  orderId?: string | null;
  /** When set, attributes the booking to a known BMI person. */
  personId?: string | null;
  clientKey?: string;
}

export interface RemoveBookingLineArgs {
  orderId: string;
  billLineId: string;
  clientKey?: string;
}

export interface ConfirmPaymentArgs {
  orderId: string;
  clientKey?: string;
}

export interface GetOrderOverviewArgs {
  orderId: string;
  clientKey?: string;
}

// ─────────────────────────── adapter surface ────────────────────────────

export interface BmiAdapter {
  /** Look up dayplanner availability for a (date, productId) pair. */
  getAvailability(args: GetAvailabilityArgs): Promise<BmiAvailabilityResponse>;

  /**
   * Book one race heat / attraction slot against BMI. Pass `orderId` to
   * chain heats on a single bill (multi-heat / 3-pack day-of products).
   * Returns rawOrderId + billLineId from response text — both preserve
   * precision via regex extraction.
   */
  bookHeat(args: BookHeatArgs): Promise<BmiBookResult>;

  /**
   * Remove a single bill line WITHOUT cancelling the whole order. Used
   * when the customer changes their mind on one heat in a multi-heat
   * booking, or when a vendor confirmation fails mid-flow.
   */
  removeBookingLine(args: RemoveBookingLineArgs): Promise<{ success: boolean }>;

  /**
   * Finalize the BMI bill after payment captures. Returns reservation
   * number / code that the confirmation page renders + emails / SMS uses.
   */
  confirmPayment(args: ConfirmPaymentArgs): Promise<BmiOrderOverview>;

  /**
   * Fetch the order/bill summary — used by the confirmation page to
   * render heat schedules + line breakdown.
   */
  getOrderOverview(args: GetOrderOverviewArgs): Promise<BmiOrderOverview>;

  /**
   * Create a BMI person record (lazy — only when the customer doesn't
   * already have one). Returns the raw personId as a digit string for
   * downstream use with stringifyWithRawIds.
   */
  createPerson(args: CreatePersonArgs): Promise<{ rawPersonId: string }>;
}

// ───────────────────────────── real impl ────────────────────────────────
// Calls the v1 `/api/bmi?endpoint=<name>` proxy route so we don't fork
// BMI plumbing. All requests that carry BMI IDs are serialized via
// stringifyWithRawIds — never JSON.stringify directly.

const BMI_ENDPOINT = "/api/bmi";

/** Extract a raw numeric field from a response body by regex. */
function extractRawField(text: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*(\\d+)`);
  const m = text.match(re);
  return m ? m[1] : null;
}

async function callBmi(
  endpoint: string,
  body: string,
  extraParams: Record<string, string> | undefined,
  clientKey: string | undefined,
): Promise<Response> {
  const qs = new URLSearchParams({
    endpoint,
    ...(extraParams ?? {}),
    ...(clientKey ? { clientKey } : {}),
  });
  return fetch(`${BMI_ENDPOINT}?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const realBmiAdapter: BmiAdapter = {
  async getAvailability({ date, productId, pageId, quantity = 1, clientKey }) {
    // BMI `/availability` POST takes PascalCase body + date as URL query.
    // Returns ALL heats for the day in one response (verified 2026-04-27
    // against SMS-Timing dayplanner — see v1 HeatPicker.tsx comment).
    const payload = {
      ProductId: Number(productId),
      PageId: Number(pageId),
      Quantity: quantity,
      OrderId: null,
      PersonId: null,
      DynamicLines: [],
    };
    const res = await callBmi("availability", JSON.stringify(payload), { date }, clientKey);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`BMI availability ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as BmiAvailabilityResponse;
  },

  async bookHeat({ productId, quantity, proposal, orderId, personId, clientKey }) {
    // Build the payload WITHOUT the raw-ID fields so JSON.stringify is safe
    // on the remainder, then string-inject orderId / personId at the
    // adapter boundary via stringifyWithRawIds.
    const payload: Record<string, unknown> = {
      productId: String(productId),
      quantity,
      resourceId: Number(proposal.blocks[0]?.block.resourceId) || -1,
      proposal: {
        blocks: proposal.blocks.map((pb) => ({
          productLineIds: pb.productLineIds || [],
          block: {
            ...pb.block,
            resourceId: Number(pb.block.resourceId) || -1,
          },
        })),
        productLineId: proposal.productLineId ?? null,
      },
    };

    const rawIds: Record<string, string> = {};
    if (orderId) rawIds.orderId = orderId;
    if (personId) rawIds.personId = personId;

    const body = stringifyWithRawIds(payload, { rawIds });
    const res = await callBmi("booking/book", body, undefined, clientKey);
    const text = await res.text();

    let parsed: BmiBookResult["result"];
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error("[bmi.bookHeat] non-JSON response:", res.status, text.substring(0, 200));
      throw new Error(`BMI booking returned ${res.status}: ${text.substring(0, 100)}`);
    }

    if (parsed.success === false) {
      console.error("[bmi.bookHeat] API error:", parsed.errorMessage);
      throw new Error(parsed.errorMessage || "BMI booking failed");
    }

    const rawOrderId = extractRawField(text, "orderId");
    if (!rawOrderId) {
      console.error("[bmi.bookHeat] no orderId in response:", text.substring(0, 200));
      throw new Error("BMI booking returned no orderId");
    }

    return {
      rawOrderId,
      billLineId: extractRawField(text, "orderItemId"),
      result: parsed,
    };
  },

  async removeBookingLine({ orderId, billLineId, clientKey }) {
    const body = stringifyWithRawIds({}, { rawIds: { orderId, orderItemId: billLineId } });
    const res = await callBmi("booking/removeItem", body, undefined, clientKey);
    if (!res.ok) {
      return { success: false };
    }
    const data = await res.json();
    return { success: data?.success !== false };
  },

  async confirmPayment({ orderId, clientKey }) {
    const body = stringifyWithRawIds({}, { rawIds: { orderId } });
    const res = await callBmi("payment/confirm", body, undefined, clientKey);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`BMI payment/confirm ${res.status}: ${text.substring(0, 100)}`);
    }
    const data = JSON.parse(text);
    return {
      rawOrderId: extractRawField(text, "orderId") ?? orderId,
      reservationNumber: data.reservationNumber ?? null,
      reservationCode: data.reservationCode ?? null,
      lines: data.lines ?? [],
    };
  },

  async getOrderOverview({ orderId, clientKey }) {
    // Overview is a GET in v1; the proxy expects query params.
    const qs = new URLSearchParams({
      endpoint: `order/${orderId}/overview`,
      ...(clientKey ? { clientKey } : {}),
    });
    const res = await fetch(`${BMI_ENDPOINT}?${qs.toString()}`);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`BMI order overview ${res.status}: ${text.substring(0, 100)}`);
    }
    const data = JSON.parse(text);
    return {
      rawOrderId: extractRawField(text, "orderId") ?? orderId,
      reservationNumber: data.reservationNumber ?? null,
      reservationCode: data.reservationCode ?? null,
      lines: data.lines ?? [],
    };
  },

  async createPerson({ firstName, lastName, email, phone, clientKey }) {
    const payload = { firstName, lastName, email, phone };
    const res = await callBmi("person/create", JSON.stringify(payload), undefined, clientKey);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`BMI person/create ${res.status}: ${text.substring(0, 100)}`);
    }
    const rawPersonId = extractRawField(text, "personId") ?? extractRawField(text, "id");
    if (!rawPersonId) {
      throw new Error("BMI person/create returned no personId");
    }
    return { rawPersonId };
  },
};

// ───────────────────────────── mock impl ────────────────────────────────
// In-memory deterministic fixtures so a fresh clone with LOCAL_BMI_MOCK=1
// runs the whole wizard without BMI credentials. Mock IDs are 17 digits
// prefixed with '9' so they're clearly fake but still in the right shape.

const mockSessions = new Map<string, MockBookSession>();

function getOrCreateMockSession(orderId: string | null | undefined): MockBookSession {
  if (orderId && mockSessions.has(orderId)) return mockSessions.get(orderId)!;
  const session: MockBookSession = {
    orderId: orderId ?? newMockId(),
    lines: [],
    reservationNumber: null,
    reservationCode: null,
  };
  mockSessions.set(session.orderId, session);
  return session;
}

function newMockId(): string {
  // 17-digit pseudo-ID starting with '9' to never collide with real BMI IDs.
  return `9${Date.now().toString().slice(-13)}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
}

const mockBmiAdapter: BmiAdapter = {
  async getAvailability(args) {
    return fixtureAvailability(args);
  },

  async bookHeat({ productId, quantity, orderId, proposal }) {
    const session = getOrCreateMockSession(orderId ?? null);
    const billLineId = newMockId();
    const block = proposal.blocks[0]?.block;
    session.lines.push({
      productId,
      billLineId,
      quantity,
      start: block?.start ?? null,
      stop: block?.stop ?? null,
      resourceId: block?.resourceId ?? null,
    });
    return fixtureBookResponse({
      rawOrderId: session.orderId,
      billLineId,
      productId,
      quantity,
      block,
    });
  },

  async removeBookingLine({ orderId, billLineId }) {
    const session = mockSessions.get(orderId);
    if (!session) return { success: false };
    const before = session.lines.length;
    session.lines = session.lines.filter((l) => l.billLineId !== billLineId);
    return { success: session.lines.length < before };
  },

  async confirmPayment({ orderId }) {
    const session = getOrCreateMockSession(orderId);
    session.reservationNumber = `MOCK-${orderId.slice(-6)}`;
    session.reservationCode = `R${orderId.slice(-4)}`;
    return fixtureOrderOverview(session);
  },

  async getOrderOverview({ orderId }) {
    const session = getOrCreateMockSession(orderId);
    return fixtureOrderOverview(session);
  },

  async createPerson() {
    return { rawPersonId: fixturePersonId() };
  },
};

// ──────────────────────────── dispatch ──────────────────────────────────

/**
 * Adapter export — picks real vs mock at module-load. Flip LOCAL_BMI_MOCK
 * and restart the dev server to switch. Production is always real.
 */
export const bmiAdapter: BmiAdapter = isMockMode("bmi") ? mockBmiAdapter : realBmiAdapter;

/** Test-only export of the real impl (so unit tests can exercise it with
 * a fetch mock without flipping env vars). */
export const __testReal: BmiAdapter = realBmiAdapter;
/** Test-only export of the mock impl (so tests can exercise it directly). */
export const __testMock: BmiAdapter = mockBmiAdapter;
/** Test-only mock-session reset between tests. */
export function __testMockReset(): void {
  mockSessions.clear();
}
