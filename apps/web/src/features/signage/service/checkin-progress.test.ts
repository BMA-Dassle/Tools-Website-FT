/**
 * THE WALLS COUNT THE SAME HEAT THE DESK DOES, and must not be slower to
 * notice a scan the desk performed itself.
 *
 * Everything here drives `sessionCheckinCounts` through Redis only:
 * `SWAGGER_ADMIN_KEY` is unset in the test environment, so the live Pandora
 * read short-circuits and the cron-warmed roster cache is the upstream — which
 * is exactly the degraded path the floor exists to rescue.
 *
 * A DISTINCT SESSION ID PER TEST, deliberately: the roster memo is module-level
 * and 12 seconds wide, so tests sharing an id would read each other's rosters.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn<(key: string) => Promise<string | null>>();
const scard = vi.fn<(key: string) => Promise<number>>();

vi.mock("@/lib/redis", () => ({
  default: {
    get: (key: string) => get(key),
    scard: (key: string) => scard(key),
    mget: () => Promise.resolve([]),
  },
}));

const { sessionCheckinCounts } = await import("./checkin-progress");

const FT = "LAB52GY480CJF";
const rosterKey = (sid: string) => `pandora:participants:${FT}:${sid}:R1`;
const ledgerKey = (sid: string) => `checkin:roster-seen:${FT}:${sid}`;

/** `n` racers, the first `checkedIn` of them stamped by Pandora. */
function roster(n: number, checkedIn: number): string {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      checkedIn: i < checkedIn ? "2026-08-19T20:14:07" : null,
    })),
  );
}

/** Upstream says `checkedIn` of `total`; our own desk has scanned `scanned`. */
function upstream(sid: string, total: number, checkedIn: number, scanned: number) {
  get.mockImplementation(async (key) => (key === rosterKey(sid) ? roster(total, checkedIn) : null));
  scard.mockImplementation(async (key) => (key === ledgerKey(sid) ? scanned : 0));
}

beforeEach(() => {
  get.mockReset();
  scard.mockReset();
});

describe("sessionCheckinCounts — floored by the desk's own scan ledger", () => {
  it("counts the scans we made ourselves, without waiting for Pandora", () => {
    const sid = "58990001";
    upstream(sid, 6, 2, 5);
    return expect(sessionCheckinCounts(sid, Date.now())).resolves.toEqual({
      checkedIn: 5,
      total: 6,
    });
  });

  it("never lowers a count the upstream already had higher", async () => {
    // Racers checked in at another station, or directly in BMI: only Pandora
    // can have seen those, and the floor must not erase them.
    const sid = "58990002";
    upstream(sid, 6, 6, 2);
    await expect(sessionCheckinCounts(sid, Date.now())).resolves.toEqual({
      checkedIn: 6,
      total: 6,
    });
  });

  it("never reports more people than the grid holds", async () => {
    // A roster read from before two racers were removed, against a fuller
    // ledger, must not print "6 of 4" on a wall.
    const sid = "58990003";
    upstream(sid, 4, 1, 6);
    await expect(sessionCheckinCounts(sid, Date.now())).resolves.toEqual({
      checkedIn: 4,
      total: 4,
    });
  });

  it("stays null when the roster cannot be read at all, ledger or no ledger", async () => {
    // A HEAT WE CANNOT COUNT IS DROPPED, never shown as a number. A floor with
    // no total is not a count — it is half of one.
    const sid = "58990004";
    get.mockResolvedValue(null);
    scard.mockResolvedValue(4);
    await expect(sessionCheckinCounts(sid, Date.now())).resolves.toBeNull();
  });

  it("leaves the upstream answer untouched when the ledger is unreadable", async () => {
    const sid = "58990005";
    get.mockImplementation(async (key) => (key === rosterKey(sid) ? roster(6, 3) : null));
    scard.mockRejectedValue(new Error("redis down"));
    await expect(sessionCheckinCounts(sid, Date.now())).resolves.toEqual({
      checkedIn: 3,
      total: 6,
    });
  });

  it("reads the ledger under the desk's own key", async () => {
    const sid = "58990006";
    upstream(sid, 3, 0, 1);
    await sessionCheckinCounts(sid, Date.now());
    expect(scard).toHaveBeenCalledWith(ledgerKey(sid));
  });
});
