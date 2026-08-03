import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * reconcileDayofOrder must follow a group event that MOVES between centers.
 *
 * FastTrax and HeadPinz Fort Myers share one BMI client, so a move keeps the same
 * project, the same contract and the same deposit — but a Square order's location
 * is immutable, so the day-of order created at the old venue has to be rebuilt at
 * the new one or the event's whole day-of revenue rings up where it no longer is.
 * The total is often unchanged by the move, which is exactly the case the old
 * total-equality no-op swallowed.
 *
 * Also locks the cancel-at-the-right-location rule: the superseded order must be
 * cancelled at ITS OWN location, not the quote's freshly-updated one.
 */

const updateGfQuoteDetails = vi.fn(async () => {});
const appendAuditLog = vi.fn(async () => {});

vi.mock("@/lib/group-function-db", () => ({
  updateGfQuoteDetails: (...args: unknown[]) => updateGfQuoteDetails(...(args as [])),
  appendAuditLog: (...args: unknown[]) => appendAuditLog(...(args as [])),
}));

import { reconcileDayofOrder } from "./group-function-dayof";
import type { GroupFunctionQuote } from "@/lib/group-function-db";

const FT = "LAB52GY480CJF";
const HPFM = "TXBSQN0FEKQ11";
const OLD_ORDER = "OLDORDER1";
const NEW_ORDER = "NEWORDER1";

function quote(overrides: Partial<GroupFunctionQuote> = {}): GroupFunctionQuote {
  return {
    id: 346,
    event_number: "H3194",
    bmi_reservation_id: "56000667",
    center_code: "fort-myers",
    square_location_id: HPFM,
    square_dayof_order_id: OLD_ORDER,
    total_cents: 214635,
    tax_cents: 13100,
    line_items: [{ name: "VIP Room", price: 2146.35, tax: 0.065, qty: 1, total: 2146.35, plu: "" }],
    ...overrides,
  } as unknown as GroupFunctionQuote;
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}
let calls: Call[];

/** Existing order lives at `existingLocation`; a rebuild rings up `rebuiltTotal`. */
function mockSquare(opts: {
  existingLocation: string;
  existingTotal: number;
  rebuiltTotal: number;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, method, body });

      if (method === "POST" && url.endsWith("/orders")) {
        return {
          ok: true,
          json: async () => ({
            order: { id: NEW_ORDER, total_money: { amount: opts.rebuiltTotal } },
          }),
        } as unknown as Response;
      }
      if (method === "GET" && url.includes(`/orders/${OLD_ORDER}`)) {
        return {
          ok: true,
          json: async () => ({
            order: {
              id: OLD_ORDER,
              state: "OPEN",
              version: 3,
              location_id: opts.existingLocation,
              total_money: { amount: opts.existingTotal },
            },
          }),
        } as unknown as Response;
      }
      if (method === "GET" && url.includes(`/orders/${NEW_ORDER}`)) {
        return {
          ok: true,
          json: async () => ({
            order: { id: NEW_ORDER, state: "OPEN", version: 1, location_id: HPFM },
          }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  calls = [];
  updateGfQuoteDetails.mockClear();
  appendAuditLog.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("reconcileDayofOrder — center moves", () => {
  it("rebuilds at the new location when the event moved, even with an unchanged total", async () => {
    mockSquare({ existingLocation: FT, existingTotal: 214635, rebuiltTotal: 214635 });

    const res = await reconcileDayofOrder(quote(), "key1");

    expect(res.action).toBe("rebuilt");
    expect(res).toMatchObject({ relocatedFrom: FT, newOrderId: NEW_ORDER });
    // The replacement order is created at the center the event moved TO.
    const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/orders"));
    expect((created!.body.order as { location_id: string }).location_id).toBe(HPFM);
    expect(updateGfQuoteDetails).toHaveBeenCalledWith(346, { square_dayof_order_id: NEW_ORDER });
  });

  it("cancels the superseded order at its OWN location, not the quote's new one", async () => {
    mockSquare({ existingLocation: FT, existingTotal: 214635, rebuiltTotal: 214635 });

    await reconcileDayofOrder(quote(), "key2");

    const cancel = calls.find((c) => c.method === "PUT" && c.url.includes(OLD_ORDER));
    expect(cancel).toBeDefined();
    const order = cancel!.body.order as { location_id: string; state: string };
    expect(order.state).toBe("CANCELED");
    // FT, not HPFM — a Square order PUT must carry that order's own location.
    expect(order.location_id).toBe(FT);
  });

  it("still no-ops when the location matches and the total is within tolerance", async () => {
    mockSquare({ existingLocation: HPFM, existingTotal: 214620, rebuiltTotal: 214635 });

    const res = await reconcileDayofOrder(quote(), "key3");

    expect(res.action).toBe("noop");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(updateGfQuoteDetails).not.toHaveBeenCalled();
  });

  it("keeps the total guard on a move: never repoints to a wrong amount", async () => {
    // Moved venue AND the rebuild disagrees with the contract total → the contract
    // total is the suspect value, so leave the pointer alone.
    mockSquare({ existingLocation: FT, existingTotal: 214635, rebuiltTotal: 180000 });

    const res = await reconcileDayofOrder(quote(), "key4");

    expect(res.action).toBe("skipped_mismatch");
    expect(updateGfQuoteDetails).not.toHaveBeenCalled();
    // The throwaway order is cancelled so no orphan sits open at the new center.
    expect(calls.some((c) => c.method === "PUT" && c.url.includes(NEW_ORDER))).toBe(true);
  });
});
