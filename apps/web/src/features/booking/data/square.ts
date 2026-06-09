/**
 * Square adapter — reference pattern for vendor adapters in this feature.
 *
 * Demonstrates the stub-mode toggle: when `LOCAL_SQUARE_MOCK=1` (and not in
 * production), the adapter returns fixture data from `__fixtures__/square.ts`
 * instead of hitting the real Square API. This lets a fresh clone run the
 * booking wizard end-to-end without any Square sandbox setup.
 *
 * Real impl in PR-B1 is intentionally a TODO that throws — wiring the real
 * Square HTTP calls happens in PR-B2 (Race v2) where the first cart actually
 * needs to be created. The stub path is wired now so the route shells can
 * already round-trip an order id.
 *
 * Other vendor adapters (bmi, conq, pandora, kbf) will follow this same
 * shape — see ./mock-mode.ts for the toggle helper.
 */
import { isMockMode } from "./mock-mode";
import { buildSquareOrder } from "./__fixtures__/square";

/** Internal projection of a Square Order — vendor-shape-scrubbed. */
export interface SquareOrder {
  id: string;
  state: "DRAFT" | "OPEN" | "COMPLETED" | "CANCELED";
  totalCents: number;
  metadata: Record<string, string>;
  lineItems: Array<{
    name: string;
    quantity: number;
    basePriceCents: number;
    catalogObjectId?: string;
  }>;
}

export interface SquareAdapter {
  /** Lazy-create a DRAFT Square Order at session start (after activity +
   * location chosen). Returns the order id; subsequent edits PUT line items. */
  createOrder(metadata: Record<string, string>): Promise<SquareOrder>;
  /** Fetch the current state of an order — confirmation pages call this. */
  getOrder(orderId: string): Promise<SquareOrder>;
  /** Cancel an abandoned DRAFT order (cleanup cron + explicit user back-out). */
  cancelOrder(orderId: string, reason?: string): Promise<void>;
}

/* ─────────────────────── real impl (PR-B2 wires this) ────────────────────── */

const realSquareAdapter: SquareAdapter = {
  async createOrder(_metadata) {
    throw new Error("square.createOrder() real impl lands in PR-B2");
  },
  async getOrder(_orderId) {
    throw new Error("square.getOrder() real impl lands in PR-B2");
  },
  async cancelOrder(_orderId, _reason) {
    throw new Error("square.cancelOrder() real impl lands in PR-B2");
  },
};

/* ─────────────────────────── mock impl (in-memory) ───────────────────────── */

const mockOrders = new Map<string, SquareOrder>();

const mockSquareAdapter: SquareAdapter = {
  async createOrder(metadata) {
    const order = buildSquareOrder(metadata);
    mockOrders.set(order.id, order);
    return order;
  },
  async getOrder(orderId) {
    const order = mockOrders.get(orderId);
    if (!order) throw new Error(`mock square: order ${orderId} not found`);
    return order;
  },
  async cancelOrder(orderId) {
    const order = mockOrders.get(orderId);
    if (order) mockOrders.set(orderId, { ...order, state: "CANCELED" });
  },
};

/* ────────────────────────────── dispatch ─────────────────────────────────── */

/**
 * Adapter export — picks real vs mock at module-load time. If you flip
 * LOCAL_SQUARE_MOCK after the dev server is running, restart the server.
 */
export const squareAdapter: SquareAdapter = isMockMode("square")
  ? mockSquareAdapter
  : realSquareAdapter;
