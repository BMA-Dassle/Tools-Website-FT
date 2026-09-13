import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Background work, captured so the test decides when it runs. */
const scheduled: Array<() => Promise<unknown>> = [];
vi.mock("~/features/signage/after-response.server", () => ({
  afterResponse: (work: () => Promise<unknown>) => {
    scheduled.push(work);
  },
}));

import { __resetPortalRosterCache, fetchPortalTrackOpsNow } from "./portal-roster";

function portalJson(names: string[]) {
  return {
    data: {
      positions: [
        {
          group: "track_ops",
          slot: "Track Ops",
          holders: names.map((n, i) => ({
            userId: 100 + i,
            firstName: n,
            presence: "in",
            hasPunchedToday: true,
          })),
        },
      ],
    },
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

async function flush() {
  const work = scheduled.splice(0);
  for (const w of work) await w();
}

describe("fetchPortalTrackOpsNow", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    __resetPortalRosterCache();
    scheduled.length = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T23:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cold: awaits the portal, then serves the answer without asking again", async () => {
    fetchMock.mockResolvedValueOnce(ok(portalJson(["Ana"])));
    expect((await fetchPortalTrackOpsNow("2026-09-12"))?.map((h) => h.firstName)).toEqual(["Ana"]);
    expect((await fetchPortalTrackOpsNow("2026-09-12"))?.map((h) => h.firstName)).toEqual(["Ana"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stale: hands back the last roster at once and refreshes behind the response", async () => {
    fetchMock.mockResolvedValueOnce(ok(portalJson(["Ana"])));
    await fetchPortalTrackOpsNow("2026-09-12");
    vi.advanceTimersByTime(31_000);

    fetchMock.mockResolvedValueOnce(ok(portalJson(["Ana", "Bo"])));
    const stale = await fetchPortalTrackOpsNow("2026-09-12");
    expect(stale?.map((h) => h.firstName)).toEqual(["Ana"]);
    // No second network call has happened on the caller's clock…
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    // …it runs after the response, and the next poll sees the new roster.
    await flush();
    expect((await fetchPortalTrackOpsNow("2026-09-12"))?.map((h) => h.firstName)).toEqual([
      "Ana",
      "Bo",
    ]);
  });

  it("a portal outage keeps the last-good roster on the boards for its window", async () => {
    fetchMock.mockResolvedValueOnce(ok(portalJson(["Ana"])));
    await fetchPortalTrackOpsNow("2026-09-12");
    vi.advanceTimersByTime(31_000);

    fetchMock.mockRejectedValue(new Error("timeout"));
    expect((await fetchPortalTrackOpsNow("2026-09-12"))?.map((h) => h.firstName)).toEqual(["Ana"]);
    await flush();
    // Nine minutes on, still Ana — and only ONE retry per cache window, however
    // many boards ask.
    vi.advanceTimersByTime(9 * 60_000);
    await fetchPortalTrackOpsNow("2026-09-12");
    await fetchPortalTrackOpsNow("2026-09-12");
    expect((await fetchPortalTrackOpsNow("2026-09-12"))?.map((h) => h.firstName)).toEqual(["Ana"]);
    await flush();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("cold and unreachable → null, and the failure is remembered rather than retried per poll", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    expect(await fetchPortalTrackOpsNow("2026-09-12")).toBeNull();
    expect(await fetchPortalTrackOpsNow("2026-09-12")).toBeNull();
    expect(await fetchPortalTrackOpsNow("2026-09-12")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000);
    fetchMock.mockResolvedValueOnce(ok(portalJson(["Cy"])));
    expect((await fetchPortalTrackOpsNow("2026-09-12"))?.map((h) => h.firstName)).toEqual(["Cy"]);
  });

  it("a new business day is a cold read, not yesterday's crew", async () => {
    fetchMock.mockResolvedValueOnce(ok(portalJson(["Ana"])));
    await fetchPortalTrackOpsNow("2026-09-12");
    fetchMock.mockResolvedValueOnce(ok(portalJson(["Dee"])));
    expect((await fetchPortalTrackOpsNow("2026-09-13"))?.map((h) => h.firstName)).toEqual(["Dee"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
