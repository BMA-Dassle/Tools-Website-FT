/**
 * The racer hub resolves a login code into a whole page. Two things here are
 * load-bearing and neither is a type error:
 *
 *   - WHERE "next race" comes from. The obvious vendor endpoint
 *     (race/next/{loc}/person/{id}) answers the next unstarted session EVER —
 *     measured 2026-08-05 it returned a 2023 Axe Lane booking for one racer and
 *     a 2025 arena match for another. These tests pin the sources we DO use and
 *     their order.
 *   - Refusing to answer for an ambiguous code. A code matching several people
 *     means we cannot tell whose page this is, and guessing shows one racer
 *     another's schedule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const redisGet = vi.fn();
const redisSet = vi.fn();
const redisSmembers = vi.fn();
const lookupMemberMatches = vi.fn();
const findTicketIdFor = vi.fn();
const getRacerPass = vi.fn();

vi.mock("@/lib/redis", () => ({
  default: {
    get: (...a: unknown[]) => redisGet(...a),
    set: (...a: unknown[]) => redisSet(...a),
    smembers: (...a: unknown[]) => redisSmembers(...a),
  },
}));
vi.mock("~/features/kiosk/license/lookup.server", () => ({
  lookupMemberMatches: (...a: unknown[]) => lookupMemberMatches(...a),
}));
vi.mock("@/lib/race-tickets", () => ({
  findTicketIdFor: (...a: unknown[]) => findTicketIdFor(...a),
}));
vi.mock("~/features/racing/data/racer-wallet-db", () => ({
  getRacerPass: (...a: unknown[]) => getRacerPass(...a),
}));

const { nextRaceForPerson, resolveRacerHub } = await import("./racer-hub");

const MATCH = {
  personId: "409523",
  fullName: "Eric Osborn",
  loginCode: "mgrm2g8o42wxc",
  races: 31,
  memberships: ["License Fee", "Qualified Intermediate", "Qualified Pro"],
};

beforeEach(() => {
  vi.clearAllMocks();
  redisGet.mockResolvedValue(null);
  redisSet.mockResolvedValue("OK");
  redisSmembers.mockResolvedValue([]);
  getRacerPass.mockResolvedValue(null);
  findTicketIdFor.mockResolvedValue(null);
  lookupMemberMatches.mockResolvedValue([MATCH]);
});

describe("nextRaceForPerson", () => {
  it("prefers the wallet pass row — the cron rewrites it every 2 minutes", async () => {
    getRacerPass.mockResolvedValue({
      nextRace: "Aug 5 · 10:48 PM · Red",
      nextRaceSessionId: "57684977",
    });

    const out = await nextRaceForPerson("409523");

    expect(out?.label).toBe("Aug 5 · 10:48 PM · Red");
    expect(out?.sessionId).toBe("57684977");
    // The pass answered, so we never touched the booking index.
    expect(redisSmembers).not.toHaveBeenCalled();
  });

  it("treats 'None in next 2 hrs' as NOT a race", async () => {
    // It is a real value the cron writes; reading it as a heat would print
    // "None in next 2 hrs" where a time belongs.
    getRacerPass.mockResolvedValue({ nextRace: "None in next 2 hrs", nextRaceSessionId: null });
    redisSmembers.mockResolvedValue([]);

    expect(await nextRaceForPerson("409523")).toBeNull();
  });

  it("falls back to our own booking index for a racer with no pass", async () => {
    const soon = new Date(Date.now() + 45 * 60_000).toISOString();
    redisSmembers.mockResolvedValue(["63000000007396352"]);
    redisGet.mockImplementation(async (key: string) => {
      if (String(key).startsWith("bookingrecord:")) {
        return JSON.stringify({
          racers: [
            { personId: "409523", sessionId: "57684977", heatStart: soon, track: "Red", heatName: "Heat 60" },
          ],
        });
      }
      return null;
    });

    const out = await nextRaceForPerson("409523");

    expect(out?.sessionId).toBe("57684977");
    expect(out?.heatNumber).toBe(60);
    expect(out?.track).toBe("Red");
    expect(out?.label).toMatch(/·/);
  });

  it("ignores heats that have already gone", async () => {
    const old = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    redisSmembers.mockResolvedValue(["1"]);
    redisGet.mockImplementation(async (key: string) =>
      String(key).startsWith("bookingrecord:")
        ? JSON.stringify({ racers: [{ personId: "409523", sessionId: "1", heatStart: old }] })
        : null,
    );

    expect(await nextRaceForPerson("409523")).toBeNull();
  });

  it("picks the EARLIEST upcoming heat when several are booked", async () => {
    const later = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const sooner = new Date(Date.now() + 30 * 60_000).toISOString();
    redisSmembers.mockResolvedValue(["a", "b"]);
    redisGet.mockImplementation(async (key: string) => {
      if (key === "bookingrecord:a")
        return JSON.stringify({ racers: [{ personId: "409523", sessionId: "LATER", heatStart: later }] });
      if (key === "bookingrecord:b")
        return JSON.stringify({ racers: [{ personId: "409523", sessionId: "SOONER", heatStart: sooner }] });
      return null;
    });

    expect((await nextRaceForPerson("409523"))?.sessionId).toBe("SOONER");
  });

  it("rejects a non-numeric personId without touching Redis", async () => {
    expect(await nextRaceForPerson("../etc/passwd")).toBeNull();
    expect(redisGet).not.toHaveBeenCalled();
  });
});

describe("resolveRacerHub", () => {
  it("resolves identity, tier and the register-scannable barcode", async () => {
    const hub = await resolveRacerHub("mgrm2g8o42wxc");

    expect(hub?.fullName).toBe("Eric Osborn");
    expect(hub?.personId).toBe("409523");
    expect(hub?.races).toBe(31);
    // Highest qualification, not the first one listed.
    expect(hub?.tier).toBe("Pro");
    // The authenticate URL is the shape BMI's own register scans; the app's
    // JSON-array payload is rejected there.
    expect(hub?.memberQr).toBe(
      "https://smstim.in/908/authenticate/?login_code=mgrm2g8o42wxc",
    );
  });

  it("refuses an AMBIGUOUS code rather than guessing whose page this is", async () => {
    lookupMemberMatches.mockResolvedValue([MATCH, { ...MATCH, personId: "999" }]);
    expect(await resolveRacerHub("mgrm2g8o42wxc")).toBeNull();
  });

  it("returns null for an unknown code", async () => {
    lookupMemberMatches.mockResolvedValue([]);
    expect(await resolveRacerHub("nosuchcode123")).toBeNull();
  });

  it("survives a degraded Office search instead of throwing", async () => {
    // `[]` is also what a degraded person subsystem returns — four hours of that
    // on 2026-08-03 — so this must be a quiet null, never a 500.
    lookupMemberMatches.mockRejectedValue(new Error("Office 500"));
    expect(await resolveRacerHub("mgrm2g8o42wxc")).toBeNull();
  });

  it("offers the e-ticket only once one has been minted", async () => {
    getRacerPass.mockResolvedValue({
      nextRace: "Aug 5 · 10:48 PM · Red",
      nextRaceSessionId: "57684977",
    });

    findTicketIdFor.mockResolvedValue(null);
    expect((await resolveRacerHub("mgrm2g8o42wxc"))?.ticketId).toBeNull();

    findTicketIdFor.mockResolvedValue("tkt_abc123");
    expect((await resolveRacerHub("mgrm2g8o42wxc"))?.ticketId).toBe("tkt_abc123");
  });

  it("does not look for a ticket when there is no heat to look under", async () => {
    getRacerPass.mockResolvedValue(null);
    redisSmembers.mockResolvedValue([]);

    const hub = await resolveRacerHub("mgrm2g8o42wxc");

    expect(hub?.nextRace).toBeNull();
    expect(hub?.ticketId).toBeNull();
    expect(findTicketIdFor).not.toHaveBeenCalled();
  });
});
