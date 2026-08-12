import { describe, it, expect, vi, afterEach } from "vitest";
import {
  addMinutesNaive,
  heatStopFor,
  scheduleCheckinRacers,
  type ScheduleRacer,
} from "./schedule-racers";

describe("addMinutesNaive (naive-ET wall-clock, TZ-neutral)", () => {
  it("adds minutes without shifting the wall clock", () => {
    expect(addMinutesNaive("2026-07-20T16:12:00", 7)).toBe("2026-07-20T16:19:00");
  });
  it("crosses an hour boundary", () => {
    expect(addMinutesNaive("2026-07-20T16:58:00", 7)).toBe("2026-07-20T17:05:00");
  });
  it("tolerates a trailing Z (treats it as the same wall clock)", () => {
    expect(addMinutesNaive("2026-07-20T16:12:00Z", 7)).toBe("2026-07-20T16:19:00");
  });
  it("heatStopFor = heatStart + 7 min (HEAT_DURATION_MIN)", () => {
    expect(heatStopFor("2026-07-20T16:12:00")).toBe("2026-07-20T16:19:00");
  });
});

// ── per-racer outcome classification ─────────────────────────────────────────
// The whole point of the rewrite: Pandora's own words decide retryable vs
// terminal. person_not_on_project is the vendor-documented "not yet synced,
// retry" — folding it into 'failed' is what sent staff to hand-seat racers and
// jam WSync with duplicate project-persons (2026-08-11).

const racer = (
  name: string,
  personId: string,
  heatStart = "2026-08-12T16:12:00",
): ScheduleRacer => ({
  racerName: name,
  personId,
  product: "Race",
  productId: null,
  tier: "starter",
  track: "Blue",
  category: "adult",
  heatName: "Race",
  heatStart,
  heatStop: heatStopFor(heatStart),
});

const pandoraResponse = (data: unknown, success = true) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ success, data }),
  }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scheduleCheckinRacers classification", () => {
  it("maps Pandora's per-racer statuses: inserted/already_linked=linked, person_not_on_project=waiting, schedule_not_found=refused", async () => {
    const racers = [
      racer("Ann", "111"),
      racer("Bob", "222"),
      racer("Cyd", "333"),
      racer("Dee", "444"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pandoraResponse({
          results: [
            { personId: "111", heatStart: "2026-08-12T16:12:00", status: "inserted" },
            { personId: "222", heatStart: "2026-08-12T16:12:00", status: "already_linked" },
            { personId: "333", heatStart: "2026-08-12T16:12:00", status: "person_not_on_project" },
            { personId: "444", heatStart: "2026-08-12T16:12:00", status: "schedule_not_found" },
          ],
        }),
      ),
    );
    const res = await scheduleCheckinRacers({ reservationNumber: "W1", racers });
    expect(res.attempted).toBe(4);
    expect(res.linked).toBe(2);
    const kind = (id: string) => res.outcomes.find((o) => o.personId === id)?.kind;
    expect(kind("111")).toBe("linked");
    expect(kind("222")).toBe("linked");
    expect(kind("333")).toBe("waiting");
    expect(kind("444")).toBe("refused");
    expect(res.unlinked.sort()).toEqual(["Cyd", "Dee"]);
    expect(res.unlinkedPersonIds.sort()).toEqual(["333", "444"]);
  });

  it("a racer missing from results[] entirely is WAITING (idempotent re-POST is safe), never failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pandoraResponse({
          results: [{ personId: "111", heatStart: "2026-08-12T16:12:00", status: "inserted" }],
        }),
      ),
    );
    const res = await scheduleCheckinRacers({
      reservationNumber: "W1",
      racers: [racer("Ann", "111"), racer("Bob", "222")],
    });
    expect(res.outcomes.find((o) => o.personId === "222")).toMatchObject({
      kind: "waiting",
      vendorStatus: "no-result-row",
    });
  });

  it("count-only response covering the whole batch = everyone linked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pandoraResponse({ inserted: 2 })),
    );
    const res = await scheduleCheckinRacers({
      reservationNumber: "W1",
      racers: [racer("Ann", "111"), racer("Bob", "222")],
    });
    expect(res.linked).toBe(2);
    expect(res.unlinked).toEqual([]);
  });

  it("count-only PARTIAL marks everyone waiting — the old code skipped retries here and stranded real racers (W52504 class)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pandoraResponse({ inserted: 1 })),
    );
    const res = await scheduleCheckinRacers({
      reservationNumber: "W1",
      racers: [racer("Ann", "111"), racer("Bob", "222")],
    });
    expect(res.linked).toBe(0);
    expect(res.outcomes.every((o) => o.kind === "waiting")).toBe(true);
    expect(res.outcomes[0].vendorStatus).toBe("count-only-partial");
  });

  it("transport failure (both attempts) = everyone WAITING for the sweep, never thrown, never failed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNRESET"))),
    );
    const p = scheduleCheckinRacers({
      reservationNumber: "W1",
      racers: [racer("Ann", "111")],
    });
    await vi.advanceTimersByTimeAsync(2_000); // release the single 1.5s retry gap
    const res = await p;
    expect(res.outcomes[0]).toMatchObject({ kind: "waiting", vendorStatus: "transport" });
    expect(res.linked).toBe(0);
  });

  it("a 200 with success:false is a non-write (retried, then WAITING)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pandoraResponse({}, false)),
    );
    const p = scheduleCheckinRacers({
      reservationNumber: "W1",
      racers: [racer("Ann", "111")],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await p;
    expect(res.outcomes[0].kind).toBe("waiting");
    expect((vi.mocked(fetch) as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      2,
    );
  });

  it("racers without a personId or heatStart are never POSTed", async () => {
    const fetchMock = vi.fn(async () => pandoraResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await scheduleCheckinRacers({
      reservationNumber: "W1",
      racers: [{ ...racer("Ann", "111"), personId: null }],
    });
    expect(res.attempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
