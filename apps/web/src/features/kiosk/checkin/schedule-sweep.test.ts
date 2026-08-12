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
  SWEEP_MEMO_AFTER_MS,
  SWEEP_TERMINAL_AFTER_MS,
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
    boundHeats: [{ heatId: "2026-08-12T17:36:00", track: "Blue" }],
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

const pandoraOk = (status: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { results: [{ personId: "16331333", heatStart: "2026-08-12T17:36:00", status }] },
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

  it("past 60 min = terminal 'failed' + AUTO CHECK-IN INCOMPLETE memo, and the row exits the queue", async () => {
    db.listPendingScheduleRows.mockResolvedValueOnce([row({ createdAt: minutesAgo(61) })]);
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
