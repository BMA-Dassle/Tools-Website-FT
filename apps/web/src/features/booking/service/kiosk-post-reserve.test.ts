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
