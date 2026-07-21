/**
 * Kiosk post-reserve session assignment — the W52504 lesson (2026-07-19).
 *
 * The Pandora /bmi/schedule endpoint SKIPS (not fails) a racer whose
 * project-person row hasn't cloud→local synced yet, so a "success" response
 * can silently leave a racer unchecked into their session. The rail must:
 *   - re-POST only the still-missing racers when per-racer results are present,
 *   - never blind-re-POST on a count-only (legacy) response,
 *   - append an AUTO CHECK-IN INCOMPLETE memo when anyone stays unlinked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runKioskPostReserve, type KioskPostReserveArgs } from "./kiosk-post-reserve";
import { appendProjectPrivateNote } from "@/lib/bmi-office-actions";

vi.mock("@/lib/bmi-office-actions", () => ({
  appendProjectPrivateNote: vi.fn(async () => true),
  setProjectState: vi.fn(async () => true),
  KIOSK_CONFIRMATION_STATE_IDS: {
    "fort-myers": "55397028",
    fasttrax: "55397028",
    naples: "8489113",
  },
}));

type ScheduleResult = { personId: string; heatStart: string; status: string };
type ScheduleData = { inserted: number; results?: ScheduleResult[] };

function racer(name: string, personId: string | null, heatStart = "2026-07-19T17:36:00") {
  return {
    racerName: name,
    personId,
    product: "Starter Race Blue",
    productId: "24952964",
    tier: "starter",
    track: "Blue" as const,
    category: "adult",
    heatName: "Starter Race Blue",
    heatStart,
    heatStop: "2026-07-19T17:43:00",
  };
}

const baseArgs = (racers: ReturnType<typeof racer>[]): KioskPostReserveArgs => ({
  racers,
  contact: {
    firstName: "Derek",
    lastName: "Runion",
    email: "d@x.com",
    phone: "2395551234",
    smsOptIn: true,
  },
  bmiBillId: "63000000005177714",
  bmiReservationNumber: "W52504",
  bmiReservationCode: "r123",
  officeProjectId: "63000000005177715",
  centerCode: "fort-myers",
  location: "fort-myers",
  isNewRacer: false,
});

/** fetch stub: records /bmi/schedule POST bodies, replays queued responses. */
function stubFetch(scheduleResponses: ScheduleData[]) {
  const scheduleBodies: Array<{ racers: Array<{ personId: string; heatStart: string }> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: string }) => {
      if (String(url).includes("/bmi/schedule/")) {
        scheduleBodies.push(JSON.parse(init?.body ?? "{}"));
        const data = scheduleResponses.shift() ?? { inserted: 0, results: [] };
        return new Response(JSON.stringify({ success: true, data }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  return scheduleBodies;
}

async function run(args: KioskPostReserveArgs) {
  const p = runKioskPostReserve(args);
  await vi.advanceTimersByTimeAsync(180_000);
  await p;
}

const memoCalls = () =>
  vi.mocked(appendProjectPrivateNote).mock.calls.map((c) => c[0].note as string);

describe("runKioskPostReserve session assignment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(appendProjectPrivateNote).mockClear();
  });

  it("all racers linked on the first POST — one call, no incomplete memo", async () => {
    const bodies = stubFetch([
      {
        inserted: 2,
        results: [
          { personId: "55700064", heatStart: "2026-07-19T17:36:00", status: "inserted" },
          { personId: "55700434", heatStart: "2026-07-19T17:36:00", status: "inserted" },
        ],
      },
    ]);
    await run(baseArgs([racer("Derek Runion", "55700064"), racer("Jace Runion", "55700434")]));
    expect(bodies).toHaveLength(1);
    expect(memoCalls().some((n) => n.includes("AUTO CHECK-IN INCOMPLETE"))).toBe(false);
  });

  it("W52504 shape: skipped racer is re-POSTed alone and recovers — no incomplete memo", async () => {
    const bodies = stubFetch([
      {
        inserted: 1,
        results: [
          { personId: "55700064", heatStart: "2026-07-19T17:36:00", status: "inserted" },
          {
            personId: "55700434",
            heatStart: "2026-07-19T17:36:00",
            status: "person_not_on_project",
          },
        ],
      },
      {
        inserted: 1,
        results: [{ personId: "55700434", heatStart: "2026-07-19T17:36:00", status: "inserted" }],
      },
    ]);
    await run(baseArgs([racer("Derek Runion", "55700064"), racer("Jace Runion", "55700434")]));
    expect(bodies).toHaveLength(2);
    // The re-POST carries ONLY the missing racer — never the already-linked one.
    expect(bodies[1].racers.map((r) => r.personId)).toEqual(["55700434"]);
    expect(memoCalls().some((n) => n.includes("AUTO CHECK-IN INCOMPLETE"))).toBe(false);
  });

  it("racer still skipped after every re-POST — incomplete memo names them", async () => {
    const skipped = {
      inserted: 0,
      results: [
        { personId: "55700434", heatStart: "2026-07-19T17:36:00", status: "person_not_on_project" },
      ],
    };
    const bodies = stubFetch([
      {
        inserted: 1,
        results: [
          { personId: "55700064", heatStart: "2026-07-19T17:36:00", status: "inserted" },
          {
            personId: "55700434",
            heatStart: "2026-07-19T17:36:00",
            status: "person_not_on_project",
          },
        ],
      },
      skipped,
      skipped,
    ]);
    await run(baseArgs([racer("Derek Runion", "55700064"), racer("Jace Runion", "55700434")]));
    expect(bodies).toHaveLength(3);
    const memo = memoCalls().find((n) => n.includes("AUTO CHECK-IN INCOMPLETE"));
    expect(memo).toContain("Jace Runion");
    expect(memo).not.toContain("Derek");
  });

  it("already_linked counts as linked on a re-run (idempotent endpoint)", async () => {
    const bodies = stubFetch([
      {
        inserted: 0,
        results: [
          { personId: "55700064", heatStart: "2026-07-19T17:36:00", status: "already_linked" },
          { personId: "55700434", heatStart: "2026-07-19T17:36:00", status: "already_linked" },
        ],
      },
    ]);
    await run(baseArgs([racer("Derek Runion", "55700064"), racer("Jace Runion", "55700434")]));
    expect(bodies).toHaveLength(1);
    expect(memoCalls().some((n) => n.includes("AUTO CHECK-IN INCOMPLETE"))).toBe(false);
  });

  it("legacy count-only shortfall: NO blind re-POST, memo carries a count", async () => {
    const bodies = stubFetch([{ inserted: 1 }]);
    await run(baseArgs([racer("Derek Runion", "55700064"), racer("Jace Runion", "55700434")]));
    expect(bodies).toHaveLength(1); // blind re-POST could double-link the racer that made it
    const memo = memoCalls().find((n) => n.includes("AUTO CHECK-IN INCOMPLETE"));
    expect(memo).toContain("1 racer(s)");
  });

  it("legacy count-only full success: no memo", async () => {
    const bodies = stubFetch([{ inserted: 2 }]);
    await run(baseArgs([racer("Derek Runion", "55700064"), racer("Jace Runion", "55700434")]));
    expect(bodies).toHaveLength(1);
    expect(memoCalls().some((n) => n.includes("AUTO CHECK-IN INCOMPLETE"))).toBe(false);
  });

  it("racer with no personId can never auto-link — goes straight on the memo", async () => {
    const bodies = stubFetch([
      {
        inserted: 1,
        results: [{ personId: "55700064", heatStart: "2026-07-19T17:36:00", status: "inserted" }],
      },
    ]);
    await run(baseArgs([racer("Derek Runion", "55700064"), racer("New Kid", null)]));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].racers.map((r) => r.personId)).toEqual(["55700064"]);
    const memo = memoCalls().find((n) => n.includes("AUTO CHECK-IN INCOMPLETE"));
    expect(memo).toContain("New Kid");
  });
});

/** fetch stub for the POV path: records claim GETs + notification POST bodies,
 *  replays queued claim responses ("ERROR" → HTTP 500). Schedule POSTs succeed. */
function stubFetchPov(claimResponses: Array<string[] | "ERROR">) {
  const claimUrls: string[] = [];
  const notifyBodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: string; method?: string }) => {
      const u = String(url);
      if (u.includes("/api/pov-codes")) {
        claimUrls.push(u);
        const next = claimResponses.shift();
        if (next === "ERROR") return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ codes: next ?? [] }), { status: 200 });
      }
      if (u.includes("/api/notifications/booking-confirmation")) {
        notifyBodies.push(JSON.parse(init?.body ?? "{}"));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (u.includes("/bmi/schedule/")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              inserted: 1,
              results: [
                { personId: "55700064", heatStart: "2026-07-19T17:36:00", status: "inserted" },
              ],
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  return { claimUrls, notifyBodies };
}

describe("runKioskPostReserve POV codes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(appendProjectPrivateNote).mockClear();
  });

  it("codes claimed inline ride the notification + memo — no re-claim", async () => {
    const { claimUrls, notifyBodies } = stubFetchPov([]);
    await run({
      ...baseArgs([racer("Derek Runion", "55700064")]),
      povQty: 2,
      povCodes: ["AB12CD34", "EF56GH78"],
    });
    expect(claimUrls).toHaveLength(0); // inline claim already delivered
    expect(notifyBodies[0].povCodes).toEqual(["AB12CD34", "EF56GH78"]);
    const memo = memoCalls()[0];
    expect(memo).toContain("Kiosk Booking, please check into session");
    // EXACT web format (buildReservationMemo, reservation-memo.ts:66).
    expect(memo).toContain("POV Codes: AB12CD34, EF56GH78 — emailed & texted to guest.");
    expect(memo).not.toContain("POV CODES OWED");
  });

  it("inline claim failed → rail re-claims (idempotent) before notifying", async () => {
    const { claimUrls, notifyBodies } = stubFetchPov([["AB12CD34"]]);
    await run({ ...baseArgs([racer("Derek Runion", "55700064")]), povQty: 1, povCodes: [] });
    expect(claimUrls).toHaveLength(1);
    expect(claimUrls[0]).toContain("action=claim");
    expect(claimUrls[0]).toContain("qty=1");
    // billId rides as the raw string — never parsed to a number.
    expect(claimUrls[0]).toContain("billId=63000000005177714");
    expect(notifyBodies[0].povCodes).toEqual(["AB12CD34"]);
    expect(memoCalls()[0]).toContain("POV Codes: AB12CD34 — emailed & texted to guest.");
  });

  it("pool short: memo carries the OWED line, no POV-codes line beyond what issued", async () => {
    stubFetchPov([["AB12CD34"]]);
    await run({ ...baseArgs([racer("Derek Runion", "55700064")]), povQty: 2, povCodes: [] });
    const memo = memoCalls()[0];
    expect(memo).toContain("POV Codes: AB12CD34 — emailed & texted to guest.");
    expect(memo).toContain(
      "POV CODES OWED — pool short: issued 1 of 2. Import codes and backfill bill 63000000005177714.",
    );
  });

  it("no POV on the booking: no claim, memo unchanged from today", async () => {
    const { claimUrls, notifyBodies } = stubFetchPov([["ZZ99"]]);
    await run(baseArgs([racer("Derek Runion", "55700064")]));
    expect(claimUrls).toHaveLength(0);
    expect(notifyBodies[0].povCodes).toBeUndefined();
    expect(memoCalls()[0]).toBe("Kiosk Booking, please check into session");
  });

  it("kill switch KIOSK_POV_CODES=0: no re-claim; owed line still flags the debt", async () => {
    vi.stubEnv("KIOSK_POV_CODES", "0");
    const { claimUrls } = stubFetchPov([["ZZ99"]]);
    await run({ ...baseArgs([racer("Derek Runion", "55700064")]), povQty: 1, povCodes: [] });
    expect(claimUrls).toHaveLength(0);
    expect(memoCalls()[0]).toContain("POV CODES OWED — pool short: issued 0 of 1");
  });

  it("claim 500s on every attempt: rail still notifies + memos (never throws)", async () => {
    const { claimUrls, notifyBodies } = stubFetchPov(["ERROR", "ERROR", "ERROR"]);
    await run({ ...baseArgs([racer("Derek Runion", "55700064")]), povQty: 1, povCodes: [] });
    expect(claimUrls).toHaveLength(3); // withRetry exhausted
    expect(notifyBodies).toHaveLength(1); // notification still went out (no codes)
    expect(notifyBodies[0].povCodes).toBeUndefined();
    const memo = memoCalls()[0];
    expect(memo).toContain("Kiosk Booking, please check into session");
    expect(memo).toContain("POV CODES OWED — pool short: issued 0 of 1");
  });
});
