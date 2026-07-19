/**
 * Abandon-path reliability (7/19 kiosk incident): start-over / idle-timeout
 * must actually kill the pre-payment BMI bill, or the contact-bearing
 * Pending-Online reservation keeps blocking its heats (~20 min) — the stacked
 * "(0/1)" holds staff saw in the dayPlanner. These tests pin the contract:
 * response-checked, retried, tenant-correct (clientKey), keepalive, and
 * verified against the bill overview.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cancelRaceOrder } from "./race";
import { abandonBooking } from "./checkout";
import { emptySession, newItem } from "../state/types";
import type { BookingSession, BowlingItem } from "../state/types";

type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function res(body: unknown, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<MockResponse>>();

function session(patch: Partial<BookingSession> = {}): BookingSession {
  return { ...emptySession({ entryBrand: "fasttrax" }), ...patch };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run an abandon-path promise while flushing the retry-backoff sleeps. */
async function withTimers<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("cancelRaceOrder", () => {
  it("confirms on the first success — DELETE with keepalive, no clientKey by default", async () => {
    fetchMock.mockResolvedValueOnce(res({ success: true }));
    expect(await cancelRaceOrder("123")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("endpoint=bill%2F123%2Fcancel");
    expect(url).not.toContain("clientKey");
    expect(init?.method).toBe("DELETE");
    expect(init?.keepalive).toBe(true);
  });

  it("targets the given tenant via clientKey", async () => {
    fetchMock.mockResolvedValueOnce(res({ success: true }));
    await cancelRaceOrder("123", "headpinznaples");
    expect(fetchMock.mock.calls[0][0]).toContain("clientKey=headpinznaples");
  });

  it("retries when BMI answers success:false, then confirms", async () => {
    fetchMock
      .mockResolvedValueOnce(res({ success: false }))
      .mockResolvedValueOnce(res({ success: true }));
    expect(await withTimers(cancelRaceOrder("123"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure, then confirms", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(res({ success: true }));
    expect(await withTimers(cancelRaceOrder("123"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 attempts and reports false — never throws", async () => {
    fetchMock.mockResolvedValue(res({ success: false }, 500));
    expect(await withTimers(cancelRaceOrder("123"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("abandonBooking", () => {
  /** Route the mock by URL: bill cancel, bill overview, QAMF hold delete. */
  function route(handlers: {
    cancel?: () => MockResponse;
    overview?: () => MockResponse;
    qamf?: () => MockResponse;
  }) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("cancel")) return (handlers.cancel ?? (() => res({ success: true })))();
      if (url.includes("overview")) return (handlers.overview ?? (() => res({ lines: [] })))();
      if (url.includes("/api/bowling/v2/reserve/hold/"))
        return (handlers.qamf ?? (() => res({ success: true })))();
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  const cancelCalls = () => fetchMock.mock.calls.filter(([u]) => u.includes("cancel"));

  it("no bill and no holds → true without any vendor call", async () => {
    expect(await abandonBooking(session())).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the bill on its own tenant (default center → headpinzftmyers) and verifies via overview", async () => {
    route({});
    expect(await withTimers(abandonBooking(session({ bmiBillId: "12345678901234567" })))).toBe(
      true,
    );
    expect(cancelCalls()).toHaveLength(1);
    expect(cancelCalls()[0][0]).toContain("clientKey=headpinzftmyers");
    expect(cancelCalls()[0][0]).toContain("endpoint=bill%2F12345678901234567%2Fcancel");
    const overview = fetchMock.mock.calls.find(([u]) => u.includes("overview"));
    expect(overview?.[0]).toContain("billId=12345678901234567");
  });

  it("a Naples bill cancels on the Naples tenant", async () => {
    route({});
    await withTimers(abandonBooking(session({ bmiBillId: "99", center: "naples" })));
    expect(cancelCalls()[0][0]).toContain("clientKey=headpinznaples");
  });

  it("re-cancels when the overview still shows live lines", async () => {
    route({
      overview: () =>
        res({
          lines: [{ name: "Race Heat", kind: 1, totalPrice: [{ depositKind: 0, amount: 25 }] }],
        }),
    });
    expect(await withTimers(abandonBooking(session({ bmiBillId: "99" })))).toBe(true);
    expect(cancelCalls()).toHaveLength(2);
  });

  it("reports false when the cancel never confirms", async () => {
    route({ cancel: () => res({ success: false }) });
    expect(await withTimers(abandonBooking(session({ bmiBillId: "99" })))).toBe(false);
  });

  it("releases a QAMF bowling hold with keepalive", async () => {
    route({});
    const bowling = {
      ...(newItem("bowling") as BowlingItem),
      qamfReservationId: "q-1",
      qamfCenterId: 7,
    };
    await withTimers(abandonBooking(session({ items: [bowling] })));
    const qamf = fetchMock.mock.calls.find(([u]) => u.includes("/api/bowling/v2/reserve/hold/q-1"));
    expect(qamf).toBeTruthy();
    expect(qamf?.[1]?.method).toBe("DELETE");
    expect(qamf?.[1]?.keepalive).toBe(true);
  });
});
