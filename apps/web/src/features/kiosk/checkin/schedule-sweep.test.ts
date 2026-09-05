import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The sweep's module graph reaches redis / Neon / the Office client — all
// mocked so these tests exercise the brain's decisions, not the plumbing.
vi.mock("@/lib/redis", () => ({
  default: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));
const db = {
  listPendingScheduleRows: vi.fn(async () => [] as unknown[]),
  setCheckinPersonStatus: vi.fn(async () => {}),
};
vi.mock("../data/kiosk-checkins-db", () => ({
  listPendingScheduleRows: (...a: unknown[]) =>
    (db.listPendingScheduleRows as (...a: unknown[]) => Promise<unknown[]>)(...a),
  setCheckinPersonStatus: (...a: unknown[]) =>
    (db.setCheckinPersonStatus as (...a: unknown[]) => Promise<void>)(...a),
}));
const office = {
  fetchOfficePerson: vi.fn(async () => ({ id: "16331333" }) as Record<string, unknown> | null),
  appendProjectPrivateNote: vi.fn<(args: { note: string }) => Promise<boolean>>(async () => true),
};
vi.mock("@/lib/bmi-office-actions", () => ({
  fetchOfficePerson: (...a: unknown[]) =>
    (office.fetchOfficePerson as (...a: unknown[]) => unknown)(...a),
  appendProjectPrivateNote: (...a: unknown[]) =>
    (office.appendProjectPrivateNote as (...a: unknown[]) => unknown)(...a),
}));
const attach = {
  registerProjectPersonServer: vi.fn(async () => ({ ok: true, status: 200, body: "" })),
};
vi.mock("~/features/kiosk/waiver/bmi-attach", () => ({
  registerProjectPersonServer: (...a: unknown[]) =>
    (attach.registerProjectPersonServer as (...a: unknown[]) => unknown)(...a),
}));
const bowling = {
  getBowlingReservationByBillId: vi.fn(async () => ({ bmiReservationNumber: "W59832" })),
};
vi.mock("@/lib/bowling-db", () => ({
  getBowlingReservationByBillId: (...a: unknown[]) =>
    (bowling.getBowlingReservationByBillId as (...a: unknown[]) => unknown)(...a),
}));

import {
  classifyRowAge,
  hasSweepMemoMarker,
  buildRacersFromRow,
  runCheckinScheduleSweep,
  lastBoundHeatMs,
  SWEEP_MEMO_AFTER_MS,
  SWEEP_TERMINAL_AFTER_MS,
  SWEEP_HEAT_GRACE_MS,
} from "./schedule-sweep";

describe("classifyRowAge (the patience ladder)", () => {
  const now = Date.parse("2026-08-12T20:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("young rows just retry", () => {
    expect(classifyRowAge(at(60_000), now)).toBe("retry");
    expect(classifyRowAge(at(SWEEP_MEMO_AFTER_MS - 1), now)).toBe("retry");
  });
  it("10+ minutes = memo staff once, keep retrying", () => {
    expect(classifyRowAge(at(SWEEP_MEMO_AFTER_MS), now)).toBe("memo-then-retry");
    expect(classifyRowAge(at(SWEEP_TERMINAL_AFTER_MS - 1), now)).toBe("memo-then-retry");
  });
  it("60+ minutes = terminal", () => {
    expect(classifyRowAge(at(SWEEP_TERMINAL_AFTER_MS), now)).toBe("terminal");
  });
  it("an unparseable timestamp is terminal, never an infinite retry", () => {
    expect(classifyRowAge("not-a-date", now)).toBe("terminal");
  });
});

/**
 * A TIMEOUT IS NOT A REFUSAL.
 *
 * The flat 60-minute rule wrote `failed` — the label for a vendor refusal — onto
 * rows that were merely slow, and `listPendingScheduleRows` excludes `failed`
 * forever, so nothing ever re-seated them. That is why the grid could not repair
 * itself: measured 2026-09-05, 133 of 806 schedule rows sat `failed`, and 25 of
 * the 26 stamps that lapsed waiting on the grid had every racer at `inserted`.
 */
describe("classifyRowAge — the heat is the deadline", () => {
  const now = Date.parse("2026-08-12T20:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const HOUR = 3_600_000;

  it("keeps retrying a 3-hour-old row whose heat is STILL AHEAD", () => {
    // The exact case the old rule wrote off: long past 60 minutes, but the guest
    // has not raced yet and still wants their seat.
    expect(classifyRowAge(at(3 * HOUR), now, now + 2 * HOUR)).toBe("memo-then-retry");
  });

  it("still memos early, so staff are told without the row being abandoned", () => {
    expect(classifyRowAge(at(SWEEP_MEMO_AFTER_MS - 1), now, now + HOUR)).toBe("retry");
    expect(classifyRowAge(at(SWEEP_MEMO_AFTER_MS), now, now + HOUR)).toBe("memo-then-retry");
  });

  it("goes terminal only once the heat has gone past the grace", () => {
    expect(classifyRowAge(at(HOUR), now, now - SWEEP_HEAT_GRACE_MS + 60_000)).toBe(
      "memo-then-retry",
    );
    expect(classifyRowAge(at(HOUR), now, now - SWEEP_HEAT_GRACE_MS - 60_000)).toBe("terminal");
  });

  it("a heat that has only just started is still worth seating — heats run late", () => {
    expect(classifyRowAge(at(HOUR), now, now - 60_000)).toBe("memo-then-retry");
  });

  it("falls back to the 60-minute rule when the row names no heat", () => {
    for (const noHeat of [null, undefined]) {
      expect(classifyRowAge(at(SWEEP_TERMINAL_AFTER_MS), now, noHeat)).toBe("terminal");
      expect(classifyRowAge(at(60_000), now, noHeat)).toBe("retry");
    }
  });
});

describe("lastBoundHeatMs", () => {
  it("takes the LATEST heat — a racer with two heats is owed the second", () => {
    const early = lastBoundHeatMs([{ heatId: "2026-08-12T16:00" }]);
    const both = lastBoundHeatMs([{ heatId: "2026-08-12T16:00" }, { heatId: "2026-08-12T19:00" }]);
    expect(early).not.toBeNull();
    expect(both).not.toBeNull();
    expect(both!).toBeGreaterThan(early!);
  });

  it("reads heatId as CENTER-LOCAL, not UTC", () => {
    // 16:00 ET on 2026-08-12 (EDT, UTC-4) is 20:00Z. Reading it as UTC would be
    // four hours early and would retire rows before their heat.
    expect(lastBoundHeatMs([{ heatId: "2026-08-12T16:00" }])).toBe(
      Date.parse("2026-08-12T20:00:00Z"),
    );
  });

  it("is null for anything it cannot date, so the caller falls back", () => {
    expect(lastBoundHeatMs(null)).toBeNull();
    expect(lastBoundHeatMs([])).toBeNull();
    expect(lastBoundHeatMs("nope")).toBeNull();
    expect(lastBoundHeatMs([{ track: "Blue" }])).toBeNull();
    expect(lastBoundHeatMs([{ heatId: "not-a-date" }])).toBeNull();
  });

  it("ignores unparseable entries but still uses the good ones", () => {
    expect(lastBoundHeatMs([{ heatId: "not-a-date" }, { heatId: "2026-08-12T16:00" }])).toBe(
      Date.parse("2026-08-12T20:00:00Z"),
    );
  });
});

describe("hasSweepMemoMarker", () => {
  it("recognises only the sweep's own marker", () => {
    expect(hasSweepMemoMarker({ step: "schedule-sweep-memo", message: "x" })).toBe(true);
    expect(hasSweepMemoMarker({ step: "schedule", message: "x" })).toBe(false);
    expect(hasSweepMemoMarker(null)).toBe(false);
    expect(hasSweepMemoMarker(undefined)).toBe(false);
    expect(hasSweepMemoMarker("schedule-sweep-memo")).toBe(false);
  });
});

describe("buildRacersFromRow (assignToSlot's mapping, rebuilt from bound_heats)", () => {
  const base = {
    personId: "63000000007188906",
    pandoraPersonId: "16331333",
    displayName: "Justin Vazquez",
    firstName: "Justin",
  };

  it("prefers the SHORT Pandora id and derives heatStop", () => {
    const racers = buildRacersFromRow({
      ...base,
      boundHeats: [
        { heatId: "2026-08-12T17:36:00", track: "Blue", tier: "pro", category: "adult" },
      ],
    });
    expect(racers).toHaveLength(1);
    expect(racers[0]).toMatchObject({
      personId: "16331333",
      racerName: "Justin",
      track: "Blue",
      tier: "pro",
      category: "adult",
      heatStart: "2026-08-12T17:36:00",
      heatStop: "2026-08-12T17:43:00",
    });
  });

  it("falls back to defaults when the heat carries no tier/category/product", () => {
    const [r] = buildRacersFromRow({ ...base, boundHeats: [{ heatId: "2026-08-12T17:36:00" }] });
    expect(r).toMatchObject({ tier: "starter", category: "adult", product: "Race" });
  });

  it("skips heats without a heatId and returns [] when no id or heats exist", () => {
    expect(buildRacersFromRow({ ...base, boundHeats: [{ track: "Red" }] })).toHaveLength(0);
    expect(
      buildRacersFromRow({
        ...base,
        personId: null,
        pandoraPersonId: null,
        boundHeats: [{ heatId: "x" }],
      }),
    ).toHaveLength(0);
    expect(buildRacersFromRow({ ...base, boundHeats: null })).toHaveLength(0);
  });
});

// ── the sweep's end-to-end decisions (vendor + stores mocked) ────────────────

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    eventId: 10,
    slotKey: "16331333",
    personId: "16331333",
    pandoraPersonId: "16331333",
    displayName: "Justin Vazquez",
    firstName: "Justin",
    lastName: "Vazquez",
    waiverValid: true,
    boundHeats: [{ heatId: FIXTURE_HEAT, track: "Blue" }],
    boundAttractionSlugs: [],
    bowlingSlot: null,
    bmiAttachStatus: "attached",
    scheduleStatus: "waiting-sync",
    qamfStatus: "n/a",
    errors: null,
    createdAt: minutesAgo(2),
    updatedAt: minutesAgo(2),
    billId: "63000000008065143",
    center: "fort-myers",
    eventBusinessDate: "2026-08-12",
    ...over,
  };
}

/**
 * A heat `mins` from now, as the naive center-local key a real row carries.
 *
 * The fixture used to pin a fixed 2026-08-12 heat while `createdAt` was relative
 * to now, so once that date fell into the past every fixture row looked like a
 * party whose heat had already gone. Real rows can never look like that:
 * `listPendingScheduleRows` is scoped to TODAY's business date, so the heat is
 * always same-day. Keeping it relative keeps the fixture honest.
 */
function heatInMinutes(mins: number): string {
  return new Date(Date.now() + mins * 60_000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T")
    .slice(0, 16);
}

/** The heat every sweep fixture below is bound to — comfortably ahead. */
const FIXTURE_HEAT = `${heatInMinutes(90)}:00`;

const pandoraOk = (status: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { results: [{ personId: "16331333", heatStart: FIXTURE_HEAT, status }] },
    }),
  }) as unknown as Response;

describe("runCheckinScheduleSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seats a waiting-sync row once Pandora accepts, and clears it from the queue", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([row()]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pandoraOk("inserted")),
    );
    const s = await runCheckinScheduleSweep({ dryRun: false });
    expect(s.seated).toBe(1);
    expect(db.setCheckinPersonStatus).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ scheduleStatus: "inserted" }),
    );
    expect(office.appendProjectPrivateNote).not.toHaveBeenCalled();
  });

  it("person_not_on_project on a YOUNG row = keep waiting, no memo, no status churn", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([row()]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pandoraOk("person_not_on_project")),
    );
    const s = await runCheckinScheduleSweep({ dryRun: false });
    expect(s.stillWaiting).toBe(1);
    expect(s.memoed).toBe(0);
    expect(office.appendProjectPrivateNote).not.toHaveBeenCalled();
  });

  it("still waiting past 10 min = ONE staff memo (marker written), row keeps retrying", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([row({ createdAt: minutesAgo(15) })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pandoraOk("person_not_on_project")),
    );
    const s = await runCheckinScheduleSweep({ dryRun: false });
    expect(s.memoed).toBe(1);
    expect(office.appendProjectPrivateNote).toHaveBeenCalledTimes(1);
    const note = office.appendProjectPrivateNote.mock.calls[0][0];
    expect(note.note).toContain("only seat by hand if the heat is about to start");
    expect(db.setCheckinPersonStatus).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ error: expect.objectContaining({ step: "schedule-sweep-memo" }) }),
    );
  });

  it("already-memoed rows do not memo again", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([
      row({ createdAt: minutesAgo(15), errors: { step: "schedule-sweep-memo", message: "x" } }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pandoraOk("person_not_on_project")),
    );
    const s = await runCheckinScheduleSweep({ dryRun: false });
    expect(s.memoed).toBe(0);
    expect(office.appendProjectPrivateNote).not.toHaveBeenCalled();
  });

  it("past 60 min but the heat is STILL AHEAD = keep re-seating, never 'failed'", async () => {
    // The regression that let the grid stop repairing itself. A row this old used
    // to be written off as `failed` — the label for a vendor REFUSAL — and
    // `listPendingScheduleRows` excludes `failed` forever, so nothing re-seated it
    // while the guest was still waiting to race.
    db.listPendingScheduleRows.mockResolvedValueOnce([row({ createdAt: minutesAgo(61) })]);
    const fetchMock = vi.fn(async () => pandoraOk("inserted"));
    vi.stubGlobal("fetch", fetchMock);
    const s = await runCheckinScheduleSweep({ dryRun: false });
    expect(s.terminal).toBe(0);
    expect(s.seated).toBe(1);
    expect(db.setCheckinPersonStatus).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ scheduleStatus: "failed" }),
    );
  });

  it("once the HEAT has gone = terminal 'failed' + AUTO CHECK-IN INCOMPLETE memo, row exits the queue", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([
      row({
        createdAt: minutesAgo(120),
        // Heat well past the grace — there is nothing left to seat them on.
        boundHeats: [{ heatId: `${heatInMinutes(-90)}:00`, track: "Blue" }],
      }),
    ]);
    const fetchMock = vi.fn(async () => pandoraOk("inserted"));
    vi.stubGlobal("fetch", fetchMock);
    const s = await runCheckinScheduleSweep({ dryRun: false });
    expect(s.terminal).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // no pointless POST for a dead row
    expect(db.setCheckinPersonStatus).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ scheduleStatus: "failed" }),
    );
    const note = office.appendProjectPrivateNote.mock.calls[0][0];
    expect(note.note).toContain("AUTO CHECK-IN INCOMPLETE");
  });

  it("BARRIER A: an unattached row whose person is NOT cloud-visible is left alone (no attach POST, no schedule)", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([row({ bmiAttachStatus: "failed" })]);
    office.fetchOfficePerson.mockResolvedValueOnce(null);
    const fetchMock = vi.fn(async () => pandoraOk("inserted"));
    vi.stubGlobal("fetch", fetchMock);
    const s = await runCheckinScheduleSweep({ dryRun: false });
    expect(s.waitingPersonSync).toBe(1);
    expect(attach.registerProjectPersonServer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("BARRIER A: once the person is cloud-visible, the attach is re-driven and the seat follows in the same tick", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([row({ bmiAttachStatus: "failed" })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pandoraOk("inserted")),
    );
    const s = await runCheckinScheduleSweep({ dryRun: false });
    expect(attach.registerProjectPersonServer).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "63000000008065143", personId: "16331333" }),
    );
    expect(s.attachLanded).toBe(1);
    expect(s.seated).toBe(1);
  });

  it("dryRun reads but never writes", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([row({ bmiAttachStatus: "failed" })]);
    const fetchMock = vi.fn(async () => pandoraOk("inserted"));
    vi.stubGlobal("fetch", fetchMock);
    await runCheckinScheduleSweep({ dryRun: true });
    expect(attach.registerProjectPersonServer).not.toHaveBeenCalled();
    expect(db.setCheckinPersonStatus).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(office.appendProjectPrivateNote).not.toHaveBeenCalled();
  });
});
