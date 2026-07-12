/**
 * syncQamfPlayers — player-count decreases per the bowling-reservations v1.2
 * spec: excess players are removed via the per-player DELETE (lane PUTs are
 * same-count-only), then names sync onto the surviving seats and the Title
 * carries the "(Np)" count. All fixtures model FUTURE reservations (lanes
 * Confirmed, no check-in) — the API only permits player mutation before the
 * lanes open.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/qamf-bowling", () => ({
  getReservation: vi.fn(),
  setLanePlayers: vi.fn(async () => {}),
  deleteLanePlayer: vi.fn(async () => {}),
  patchReservation: vi.fn(async () => {}),
  searchAvailability: vi.fn(),
}));
vi.mock("~/features/booking/service/qamf-reschedule", () => ({
  rescheduleQamfReservation: vi.fn(),
}));

import {
  deleteLanePlayer,
  getReservation,
  patchReservation,
  setLanePlayers,
} from "@/lib/qamf-bowling";
import { syncQamfPlayers } from "./qamf-sync";

const qamfPlayer = (name: string, id: number | null) => ({
  Name: name,
  ActivateBumpers: false,
  Id: id,
});

/** A booked-for-later reservation: future BookedAt, Confirmed lanes, no check-in. */
const futureReservation = (lanes: unknown[], over: Record<string, unknown> = {}) => ({
  Id: "X158469",
  Status: "Confirmed",
  BookedAt: "2026-08-01T18:00:00.0000000+00:00",
  Title: "Ann Guest (2p)",
  Lanes: lanes,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncQamfPlayers — decrease via per-player DELETE", () => {
  it("removes the excess player, re-reads, and PUTs the surviving seat count", async () => {
    vi.mocked(getReservation)
      .mockResolvedValueOnce(
        futureReservation([
          {
            Id: "L1",
            Status: "Confirmed",
            Players: [qamfPlayer("Ann", 111), qamfPlayer("Bob", 222)],
          },
        ]) as never,
      )
      .mockResolvedValueOnce(
        futureReservation([
          { Id: "L1", Status: "Confirmed", Players: [qamfPlayer("Ann", 111)] },
        ]) as never,
      );

    const r = await syncQamfPlayers({
      qamfCenterId: 9172,
      qamfReservationId: "X158469",
      players: [{ name: "Ann", shoeSize: "Adult 8", bumpers: false }],
      guestName: "Ann Guest",
    });

    expect(r).toEqual({ lanesUpdated: 1, playersRemoved: 1 });
    // GETs run under api-version 1.2 — the pinned version omits Player.Id.
    expect(vi.mocked(getReservation)).toHaveBeenCalledWith(9172, "X158469", "1.2");
    // End of the lineup dies first — Bob (Id 222).
    expect(vi.mocked(deleteLanePlayer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteLanePlayer)).toHaveBeenCalledWith(9172, "X158469", "L1", 222);
    // The follow-up PUT matches the POST-delete seat count — no same-count 409.
    const sent = vi.mocked(setLanePlayers).mock.calls[0][3];
    expect(sent).toHaveLength(1);
    expect(sent[0].Name).toBe("Ann");
    expect(vi.mocked(patchReservation)).toHaveBeenCalledWith(
      9172,
      "X158469",
      expect.objectContaining({ Title: "Ann Guest (1p)" }),
    );
  });

  it("spreads removals across lanes, last lane first", async () => {
    vi.mocked(getReservation)
      .mockResolvedValueOnce(
        futureReservation([
          {
            Id: "L1",
            Status: "Confirmed",
            Players: [qamfPlayer("A", 1), qamfPlayer("B", 2)],
          },
          {
            Id: "L2",
            Status: "Confirmed",
            Players: [qamfPlayer("C", 3), qamfPlayer("D", 4)],
          },
        ]) as never,
      )
      .mockResolvedValueOnce(
        futureReservation([
          {
            Id: "L1",
            Status: "Confirmed",
            Players: [qamfPlayer("A", 1), qamfPlayer("B", 2)],
          },
          { Id: "L2", Status: "Confirmed", Players: [qamfPlayer("C", 3)] },
        ]) as never,
      );

    const r = await syncQamfPlayers({
      qamfCenterId: 9172,
      qamfReservationId: "X158469",
      players: [{ name: "Ann" }, { name: "Bob" }, { name: "Cara" }],
      guestName: "Ann Guest",
    });

    expect(r.playersRemoved).toBe(1);
    expect(vi.mocked(deleteLanePlayer)).toHaveBeenCalledWith(9172, "X158469", "L2", 4);
    const lane1 = vi.mocked(setLanePlayers).mock.calls[0][3];
    const lane2 = vi.mocked(setLanePlayers).mock.calls[1][3];
    expect(lane1.map((p: { Name: string }) => p.Name)).toEqual(["Ann", "Bob"]);
    expect(lane2.map((p: { Name: string }) => p.Name)).toEqual(["Cara"]);
  });

  it("skips players without an addressable id and throws if the decrease can't complete", async () => {
    vi.mocked(getReservation).mockResolvedValue(
      futureReservation([
        {
          Id: "L1",
          Status: "Confirmed",
          Players: [qamfPlayer("Ann", null), qamfPlayer("Bob", null)],
        },
      ]) as never,
    );

    await expect(
      syncQamfPlayers({
        qamfCenterId: 9172,
        qamfReservationId: "X158469",
        players: [{ name: "Ann" }],
        guestName: "Ann Guest",
      }),
    ).rejects.toThrow(/decrease incomplete/);
    expect(vi.mocked(setLanePlayers)).not.toHaveBeenCalled();
  });

  it("no deletes on a same-count roster sync (names/shoes only)", async () => {
    vi.mocked(getReservation).mockResolvedValue(
      futureReservation([
        {
          Id: "L1",
          Status: "Confirmed",
          Players: [qamfPlayer("Ann", 111), qamfPlayer("Bob", 222)],
        },
      ]) as never,
    );

    await syncQamfPlayers({
      qamfCenterId: 9172,
      qamfReservationId: "X158469",
      players: [{ name: "Ann" }, { name: "Bobby" }],
      guestName: "Ann Guest",
    });

    expect(vi.mocked(deleteLanePlayer)).not.toHaveBeenCalled();
    const sent = vi.mocked(setLanePlayers).mock.calls[0][3];
    expect(sent.map((p: { Name: string }) => p.Name)).toEqual(["Ann", "Bobby"]);
  });

  it("an increase beyond booked seats syncs the first names and the Title carries the count", async () => {
    vi.mocked(getReservation).mockResolvedValue(
      futureReservation([
        {
          Id: "L1",
          Status: "Confirmed",
          Players: [qamfPlayer("Ann", 111), qamfPlayer("Bob", 222)],
        },
      ]) as never,
    );

    await syncQamfPlayers({
      qamfCenterId: 9172,
      qamfReservationId: "X158469",
      players: [{ name: "Ann" }, { name: "Bob" }, { name: "Cara" }],
      guestName: "Ann Guest",
    });

    expect(vi.mocked(deleteLanePlayer)).not.toHaveBeenCalled();
    const sent = vi.mocked(setLanePlayers).mock.calls[0][3];
    expect(sent.map((p: { Name: string }) => p.Name)).toEqual(["Ann", "Bob"]);
    expect(vi.mocked(patchReservation)).toHaveBeenCalledWith(
      9172,
      "X158469",
      expect.objectContaining({ Title: "Ann Guest (3p)" }),
    );
  });

  it("preserves live Notes verbatim on the Title re-patch", async () => {
    vi.mocked(getReservation).mockResolvedValue(
      futureReservation(
        [
          {
            Id: "L1",
            Status: "Confirmed",
            Players: [qamfPlayer("Ann", 111), qamfPlayer("Bob", 222)],
          },
        ],
        { Notes: "Deposit $44 paid (incl. tax)" },
      ) as never,
    );

    await syncQamfPlayers({
      qamfCenterId: 9172,
      qamfReservationId: "X158469",
      players: [{ name: "Ann" }, { name: "Bob" }],
      guestName: "Ann Guest",
    });

    expect(vi.mocked(patchReservation)).toHaveBeenCalledWith(9172, "X158469", {
      Title: "Ann Guest (2p)",
      Notes: "Deposit $44 paid (incl. tax)",
    });
  });
});
