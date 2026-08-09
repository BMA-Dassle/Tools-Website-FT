/**
 * The group-function attach defect (live 2026-08-08/09) and its fix.
 *
 * `projectId − 1` was never a property of BMI — it is a coincidence of our own
 * booking flow, where the bill and project are minted consecutively. Group
 * functions are Office-created and their bills live in another series, so the
 * arithmetic named nothing and 0/36 group-function signers attached while
 * 177/177 online-booking signers did.
 *
 * These tests pin the behaviour that matters: the proven path is untouched, the
 * broken one now ASKS instead of assuming, and nothing is ever guessed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above every const in this file, so the doubles have to be
// created inside vi.hoisted or the factory closes over a TDZ binding.
const { getPublicBookingToken, fetchProjectRawIds } = vi.hoisted(() => ({
  getPublicBookingToken: vi.fn(async () => "tok"),
  fetchProjectRawIds: vi.fn(),
}));

vi.mock("@/lib/bmi-office-actions", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPublicBookingToken,
  fetchProjectRawIds,
}));

import { resolveAttachOrderId } from "./attach-order-id";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchProjectRawIds.mockReset();
  getPublicBookingToken.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** The real overview shape: a 200 carrying an `orderId`. */
const ORDER_OK = (orderId: string) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ orderId, orderReference: "x", total: { amount: 1 } }),
});
/** What the API actually returns for an id that is not an order. */
const ORDER_MISSING = {
  ok: false,
  status: 400,
  text: async () => JSON.stringify({ success: false, errorMessage: "Order not found" }),
};

/** Route each /order/{id}/overview call by the id in the URL. */
function routeOrders(resolvable: Set<string>) {
  fetchMock.mockImplementation(async (url: string) => {
    const id = /\/order\/(\d+)\/overview/.exec(String(url))?.[1] ?? "";
    return resolvable.has(id) ? ORDER_OK(id) : ORDER_MISSING;
  });
}

describe("resolveAttachOrderId — the online-booking path is unchanged", () => {
  it("returns projectId−1 when that id really is an order, without reading Office", async () => {
    // The 177 reservations that work today must keep the byte-identical id.
    routeOrders(new Set(["63000000007086415"]));

    const got = await resolveAttachOrderId({
      clientKey: "headpinzftmyers",
      projectId: "63000000007086416",
    });

    expect(got).toEqual({ orderId: "63000000007086415", source: "arithmetic" });
    // The whole point of trying arithmetic first: no Office round-trip on the hot path.
    expect(fetchProjectRawIds).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never puts a 17-digit id through Number()", async () => {
    routeOrders(new Set(["63000000006754861"]));
    const got = await resolveAttachOrderId({
      clientKey: "headpinzftmyers",
      projectId: "63000000006754862",
    });
    expect(got?.orderId).toBe("63000000006754861");
    expect(got?.orderId).not.toContain("e"); // no exponent notation
    expect(got?.orderId).toHaveLength(17); // no precision-loss truncation
  });
});

describe("resolveAttachOrderId — the group-function path (the bug)", () => {
  it("falls back to the project's Office bill when projectId−1 is not an order", async () => {
    // H3194, verbatim: 56000667 → 56000666 resolves to nothing; the contract
    // bill 63000000006600094 is the real order.
    routeOrders(new Set(["63000000006600094"]));
    fetchProjectRawIds.mockResolvedValue({
      bills: [{ id: "63000000006600094", created: "2026-07-29T15:36:57" }],
    });

    const got = await resolveAttachOrderId({
      clientKey: "headpinzftmyers",
      projectId: "56000667",
    });

    expect(got).toEqual({ orderId: "63000000006600094", source: "office-bill" });
  });

  it("prefers the OLDEST bill — the contract bill, not a day-of POS bill", async () => {
    // By the time H3194's racing ran it held 16 bills, 15 of them opened at the
    // counter that evening. The contract bill is the one that names the booking.
    routeOrders(new Set(["63000000006600094", "58142358", "58136063"]));
    fetchProjectRawIds.mockResolvedValue({
      bills: [
        { id: "58142358", created: "2026-08-08T17:44:10" },
        { id: "63000000006600094", created: "2026-07-29T15:36:57" },
        { id: "58136063", created: "2026-08-08T16:02:00" },
      ],
    });

    const got = await resolveAttachOrderId({ clientKey: "headpinzftmyers", projectId: "56000667" });

    expect(got?.orderId).toBe("63000000006600094");
  });

  it("skips a bill that does not resolve and keeps looking", async () => {
    routeOrders(new Set(["63000000000837878"]));
    fetchProjectRawIds.mockResolvedValue({
      bills: [
        { id: "8521740", created: "2026-01-01T00:00:00" }, // stale/void, not an order
        { id: "63000000000837878", created: "2026-02-01T00:00:00" },
      ],
    });

    const got = await resolveAttachOrderId({ clientKey: "headpinznaples", projectId: "8521747" });

    expect(got).toEqual({ orderId: "63000000000837878", source: "office-bill" });
  });
});

describe("resolveAttachOrderId — refuses rather than guessing", () => {
  it("returns null when nothing resolves, instead of returning projectId−1 anyway", async () => {
    // The old code handed BMI an unverified id. A wrong order id attaches a guest
    // to somebody else's reservation — strictly worse than not attaching.
    routeOrders(new Set());
    fetchProjectRawIds.mockResolvedValue({ bills: [{ id: "999", created: "2026-01-01" }] });

    expect(
      await resolveAttachOrderId({ clientKey: "headpinzftmyers", projectId: "56000667" }),
    ).toBeNull();
  });

  it("returns null when the project cannot be read at all", async () => {
    // An unreadable project is not an empty one. Office had a ~6h auth outage on
    // 2026-08-03; that must not become a wrong-id attach.
    routeOrders(new Set());
    fetchProjectRawIds.mockResolvedValue(null);

    expect(
      await resolveAttachOrderId({ clientKey: "headpinzftmyers", projectId: "56000667" }),
    ).toBeNull();
  });

  it("treats a 200 that is not an order as a non-match", async () => {
    // This API answers refusals with 200 elsewhere (registerProjectPerson does),
    // so a 2xx alone is never taken as proof.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: false, errorMessage: "nope" }),
    });
    fetchProjectRawIds.mockResolvedValue({ bills: [] });

    expect(
      await resolveAttachOrderId({ clientKey: "headpinzftmyers", projectId: "56000667" }),
    ).toBeNull();
  });

  it("returns null for a non-numeric project id without calling anything", async () => {
    expect(
      await resolveAttachOrderId({ clientKey: "headpinzftmyers", projectId: "H3194" }),
    ).toBeNull();
    expect(getPublicBookingToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a network error on the probe without claiming a match", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    fetchProjectRawIds.mockResolvedValue({
      bills: [{ id: "63000000006600094", created: "2026-07-29" }],
    });

    expect(
      await resolveAttachOrderId({ clientKey: "headpinzftmyers", projectId: "56000667" }),
    ).toBeNull();
  });

  it("caps how many bills it probes and says so out loud", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    routeOrders(new Set()); // nothing resolves — force it through every probe
    fetchProjectRawIds.mockResolvedValue({
      bills: Array.from({ length: 12 }, (_, i) => ({
        id: `5810000${i}`,
        created: `2026-08-08T1${i}:00:00`,
      })),
    });

    await resolveAttachOrderId({ clientKey: "headpinzftmyers", projectId: "56000667" });

    // 1 arithmetic probe + at most 5 bill probes — a cost ceiling, never silent.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/12 bills.*oldest 5/);
  });
});
