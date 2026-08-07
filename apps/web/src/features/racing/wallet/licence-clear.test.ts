/**
 * The overnight failsafe clears licence fields WITHOUT consulting the schedule,
 * which is exactly what makes it useful and exactly what makes it dangerous.
 *
 * Its only protection against wiping "Check in now" off a pass while its racer
 * is standing at the desk is the ET dead-hours window. The Vercel schedule is
 * UTC and ET is not, so the schedule alone cannot be trusted across a DST
 * change — the guard has to live in the code, and these tests are what hold it
 * there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getPassesWithLiveFields = vi.fn();
const markPushed = vi.fn();
const updateLicencePass = vi.fn();

vi.mock("~/features/racing/data/racer-wallet-db", () => ({
  getPassesWithLiveFields: (...a: unknown[]) => getPassesWithLiveFields(...a),
  markPushed: (...a: unknown[]) => markPushed(...a),
}));

vi.mock("~/features/racing/wallet/licence-pass", () => ({
  updateLicencePass: (...a: unknown[]) => updateLicencePass(...a),
  licencePassEnabled: () => true,
}));

const { clearStaleLicenceFieldsOvernight, NO_NEXT_RACE } = await import("./licence-clear");

/** One racer still carrying last night's heat on their pass. */
const STALE_ROW = {
  personId: "409523",
  memberId: "m1",
  checkinStatus: "Check in now — Red Heat 60",
  checkinSessionId: "57900606",
  nextRace: "Aug 6 · 10:48 PM · Red",
  nextRaceSessionId: "57900606",
};

beforeEach(() => {
  vi.clearAllMocks();
  getPassesWithLiveFields.mockResolvedValue([STALE_ROW]);
  updateLicencePass.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A UTC instant, so the ET hour under test is unambiguous. EDT = UTC-4. */
function atUtc(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe("clearStaleLicenceFieldsOvernight — the dead-hours guard", () => {
  it("clears everything at 3am ET", async () => {
    atUtc("2026-08-07T07:00:00.000Z"); // 3am EDT
    const out = await clearStaleLicenceFieldsOvernight();

    expect(out.skipped).toBeUndefined();
    expect(out.checkinCleared).toBe(1);
    expect(out.nextRaceCleared).toBe(1);
    expect(updateLicencePass).toHaveBeenCalledWith("409523", { checkinStatus: "" });
    expect(updateLicencePass).toHaveBeenCalledWith("409523", { nextRace: NO_NEXT_RACE });
    // The session stamps must go too, or the per-minute sweep keeps testing a
    // heat that no longer means anything.
    expect(markPushed).toHaveBeenCalledWith("409523", { checkinSessionId: null });
    expect(markPushed).toHaveBeenCalledWith("409523", { nextRaceSessionId: null });
  });

  it("REFUSES to run during opening hours — the failure that must never happen", async () => {
    // 8pm ET: heats are being called and racers are at the desk. If this ever
    // fires here it silently deletes the alert they are acting on.
    atUtc("2026-08-07T00:00:00.000Z"); // 8pm EDT on the 6th
    const out = await clearStaleLicenceFieldsOvernight();

    expect(out.skipped).toContain("outside");
    expect(updateLicencePass).not.toHaveBeenCalled();
    expect(markPushed).not.toHaveBeenCalled();
  });

  it("refuses just outside the window in both directions", async () => {
    atUtc("2026-08-07T05:00:00.000Z"); // 1am EDT — before
    expect((await clearStaleLicenceFieldsOvernight()).skipped).toContain("outside");

    atUtc("2026-08-07T10:00:00.000Z"); // 6am EDT — after
    expect((await clearStaleLicenceFieldsOvernight()).skipped).toContain("outside");

    expect(updateLicencePass).not.toHaveBeenCalled();
  });

  it("fires in EST too — the schedule is UTC, the guard is ET", async () => {
    // 08:00Z is 3am EST in January. The other cron entry (07:00Z) is 2am EST
    // and correctly does nothing, so exactly one of the pair works year-round.
    atUtc("2027-01-15T13:00:00.000Z"); // 8am EST — must refuse
    expect((await clearStaleLicenceFieldsOvernight()).skipped).toContain("outside");

    atUtc("2027-01-15T08:00:00.000Z"); // 3am EST — must clear
    const out = await clearStaleLicenceFieldsOvernight();
    expect(out.skipped).toBeUndefined();
    expect(out.nextRaceCleared).toBe(1);
  });

  it("leaves an already-idle pass alone rather than pushing a no-op", async () => {
    getPassesWithLiveFields.mockResolvedValue([
      { ...STALE_ROW, checkinStatus: "", nextRace: NO_NEXT_RACE },
    ]);
    atUtc("2026-08-07T07:00:00.000Z");
    const out = await clearStaleLicenceFieldsOvernight();

    expect(out.checkinCleared).toBe(0);
    expect(out.nextRaceCleared).toBe(0);
    expect(updateLicencePass).not.toHaveBeenCalled();
  });
});
