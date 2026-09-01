import { describe, expect, it, vi, beforeEach } from "vitest";

const moveReservationLanes = vi.fn();
const getReservation = vi.fn();

vi.mock("@/lib/qamf-bowling", () => ({
  moveReservationLanes: (...a: unknown[]) => moveReservationLanes(...a),
  getReservation: (...a: unknown[]) => getReservation(...a),
}));

import { pinReservationToBlock, type BookedLaneLike } from "./pin.server";
import { blockById } from "./blocks";

const VIP_A = blockById("fm-vip-a")!; // lanes 5-8
const FM = 9172;

function lane(id: string, n: number): BookedLaneLike {
  return {
    Id: id,
    LaneNumber: n,
    StartTime: "2026-09-13T16:45:00.000Z", // 12:45 ET
    EndTime: "2026-09-13T19:45:00.000Z", // 15:45 ET
  };
}

/** QAMF answers with the lanes it actually seated. */
const seatedAs = (...nums: number[]) =>
  getReservation.mockResolvedValue({ Lanes: nums.map((n) => ({ LaneNumber: n })) });

beforeEach(() => {
  moveReservationLanes.mockReset();
  getReservation.mockReset();
});

describe("pinReservationToBlock", () => {
  it("sends nothing when the party is already inside the block", async () => {
    const out = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X1",
      lanes: [lane("l1", 6)],
      block: VIP_A,
    });
    expect(out).toEqual({ pinned: true, lanes: [6], moved: false });
    expect(moveReservationLanes).not.toHaveBeenCalled();
  });

  it("moves a party seated outside the block onto its first free lane", async () => {
    moveReservationLanes.mockResolvedValue(undefined);
    seatedAs(5);
    const out = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X2",
      lanes: [lane("l1", 11)], // block B — wrong game's screen
      block: VIP_A,
    });
    expect(out).toEqual({ pinned: true, lanes: [5], moved: true });
    const payload = moveReservationLanes.mock.calls[0][2];
    expect(payload).toHaveLength(1);
    expect(payload[0].LaneNumber).toBe(5);
    expect(payload[0].Id).toBe("l1");
  });

  it("sends ET wall-clock with the true offset, and does NOT reschedule", async () => {
    moveReservationLanes.mockResolvedValue(undefined);
    seatedAs(5);
    await pinReservationToBlock({
      centerId: FM,
      reservationId: "X3",
      lanes: [lane("l1", 11)],
      block: VIP_A,
    });
    const p = moveReservationLanes.mock.calls[0][2][0];
    // Conqueror reads these as center-local and ignores the offset, so the
    // wall-clock has to be ET, not UTC.
    expect(p.StartTime).toBe("2026-09-13T12:45:00-04:00");
    expect(p.EndTime).toBe("2026-09-13T15:45:00-04:00");
  });

  it("uses EST for a November game", async () => {
    moveReservationLanes.mockResolvedValue(undefined);
    seatedAs(5);
    await pinReservationToBlock({
      centerId: FM,
      reservationId: "X4",
      lanes: [
        {
          Id: "l1",
          LaneNumber: 11,
          StartTime: "2026-11-09T01:05:00.000Z", // 8:05 PM EST
          EndTime: "2026-11-09T04:05:00.000Z", // 11:05 PM EST
        },
      ],
      block: VIP_A,
    });
    const p = moveReservationLanes.mock.calls[0][2][0];
    expect(p.StartTime).toBe("2026-11-08T20:05:00-05:00");
    expect(p.EndTime).toBe("2026-11-08T23:05:00-05:00");
  });

  it("tries the next arrangement when a lane is occupied", async () => {
    moveReservationLanes
      .mockRejectedValueOnce(new Error("409 LanesNotAvailable"))
      .mockResolvedValueOnce(undefined);
    seatedAs(6);
    const out = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X5",
      lanes: [lane("l1", 11)],
      block: VIP_A,
    });
    expect(out).toEqual({ pinned: true, lanes: [6], moved: true });
    expect(moveReservationLanes).toHaveBeenCalledTimes(2);
    expect(moveReservationLanes.mock.calls[0][2][0].LaneNumber).toBe(5);
    expect(moveReservationLanes.mock.calls[1][2][0].LaneNumber).toBe(6);
  });

  it("gives up as block-full once every lane is occupied", async () => {
    moveReservationLanes.mockRejectedValue(new Error("409 LanesNotAvailable"));
    const out = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X6",
      lanes: [lane("l1", 11)],
      block: VIP_A,
    });
    expect(out.pinned).toBe(false);
    if (!out.pinned) expect(out.reason).toBe("block-full");
    expect(moveReservationLanes).toHaveBeenCalledTimes(4); // lanes 5,6,7,8
  });

  it("STOPS on LanesNotCompatible — that is a config bug, not a busy lane", async () => {
    moveReservationLanes.mockRejectedValue(new Error("409 LanesNotCompatible"));
    const out = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X7",
      lanes: [lane("l1", 20)],
      block: VIP_A,
    });
    expect(out.pinned).toBe(false);
    if (!out.pinned) expect(out.reason).toBe("incompatible");
    // Exactly one attempt: retrying would fail identically and hide the bug.
    expect(moveReservationLanes).toHaveBeenCalledTimes(1);
  });

  it("moves a two-lane party as a pair", async () => {
    moveReservationLanes.mockResolvedValue(undefined);
    seatedAs(5, 6);
    const out = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X8",
      lanes: [lane("l1", 11), lane("l2", 12)],
      block: VIP_A,
    });
    expect(out).toEqual({ pinned: true, lanes: [5, 6], moved: true });
    const payload = moveReservationLanes.mock.calls[0][2];
    expect(payload.map((p: { LaneNumber: number }) => p.LaneNumber)).toEqual([5, 6]);
  });

  it("refuses to believe a PATCH that reports success but seats elsewhere", async () => {
    // A silent no-op would otherwise read as success and leave the party under
    // the wrong screen — so the reservation is read back, not assumed.
    moveReservationLanes.mockResolvedValue(undefined);
    getReservation.mockResolvedValue({ Lanes: [{ LaneNumber: 11 }] });
    const out = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X9",
      lanes: [lane("l1", 11)],
      block: VIP_A,
    });
    expect(out.pinned).toBe(false);
    if (!out.pinned) expect(out.reason).toBe("block-full");
  });

  it("falls back to the requested lanes when the read-back itself fails", async () => {
    moveReservationLanes.mockResolvedValue(undefined);
    getReservation.mockRejectedValue(new Error("QAMF down"));
    const out = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X10",
      lanes: [lane("l1", 11)],
      block: VIP_A,
    });
    expect(out).toEqual({ pinned: true, lanes: [5], moved: true });
  });

  it("reports rather than throws when the reservation has no lanes or no times", async () => {
    const noLanes = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X11",
      lanes: [],
      block: VIP_A,
    });
    expect(noLanes.pinned).toBe(false);

    const noTimes = await pinReservationToBlock({
      centerId: FM,
      reservationId: "X12",
      lanes: [{ Id: "l1", LaneNumber: 11, StartTime: null, EndTime: null }],
      block: VIP_A,
    });
    expect(noTimes.pinned).toBe(false);
    if (!noTimes.pinned) expect(noTimes.reason).toBe("error");
    expect(moveReservationLanes).not.toHaveBeenCalled();
  });
});
