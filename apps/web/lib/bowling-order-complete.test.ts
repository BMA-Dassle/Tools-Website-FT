import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * completeReservationOrder combo behavior. Combo bowling legs pay at lane-open
 * like regular bowling but were skipped ("combo (own settle flow)") waiting on
 * a settle flow that never existed — 45 paid legs sat OPEN until the portal's
 * 2026-07-08 manual sweep. Paid combo `open` legs must now complete; an unpaid
 * combo leg (no-show, balance due) must stay OPEN for the manual no-show flow;
 * combo race legs stay with race-dayof-pay.
 */

const markDayofOrderCompleted = vi.fn();

vi.mock("@/lib/bowling-db", () => ({
  getCheckedInOrdersToComplete: vi.fn(async () => []),
  markDayofOrderCompleted: (...args: unknown[]) => markDayofOrderCompleted(...args),
}));

import { completeReservationOrder } from "./bowling-order-complete";
import type { BowlingReservation } from "@/lib/bowling-db";

function comboLeg(overrides: Record<string, unknown> = {}): BowlingReservation {
  return {
    id: 5856,
    productKind: "open",
    comboSpecialId: "race-bowl",
    squareDayofOrderId: "ORDER123",
    guestName: "Sarah Dor",
    ...overrides,
  } as unknown as BowlingReservation;
}

/** Square order-endpoint stub: GETs return `order`; PUTs return ok. */
function stubSquare(order: Record<string, unknown>) {
  const calls: { method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return {
        ok: true,
        json: async () => ({ order: method === "GET" ? order : { ...order, state: "COMPLETED" } }),
      } as Response;
    }),
  );
  return calls;
}

beforeEach(() => markDayofOrderCompleted.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("completeReservationOrder — combo bowling legs", () => {
  it("completes a PAID combo open leg ($0 due) and stamps the row", async () => {
    const calls = stubSquare({
      id: "ORDER123",
      state: "OPEN",
      version: 3,
      location_id: "LOC1",
      total_money: { amount: 6605 },
      net_amount_due_money: { amount: 0 },
      fulfillments: [],
    });
    const res = await completeReservationOrder(comboLeg());
    expect(res.kind).toBe("completed");
    expect(markDayofOrderCompleted).toHaveBeenCalledWith(5856);
    const put = calls.find((c) => c.method === "PUT");
    expect(put, "order was PUT to COMPLETED").toBeTruthy();
    expect((put!.body as { order: { state: string } }).order.state).toBe("COMPLETED");
  });

  it("leaves an UNPAID combo leg (no-show, balance due) OPEN and unstamped", async () => {
    const calls = stubSquare({
      id: "ORDER123",
      state: "OPEN",
      version: 1,
      location_id: "LOC1",
      total_money: { amount: 6605 },
      net_amount_due_money: { amount: 6605 },
      fulfillments: [],
    });
    const res = await completeReservationOrder(comboLeg());
    expect(res.kind).toBe("skipped");
    expect("note" in res && res.note).toContain("balance due");
    expect(markDayofOrderCompleted).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("still skips combo race legs (race-dayof-pay owns them)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await completeReservationOrder(comboLeg({ productKind: "race" }));
    expect(res.kind).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
