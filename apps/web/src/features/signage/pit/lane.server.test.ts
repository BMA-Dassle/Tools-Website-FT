import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * IN KARTS MUST NOT CHANGE WHAT HOLDING ALREADY DID.
 *
 * The stage between the seats and the green flag was added by giving the lane a
 * third slot and pointing the promotion at `karts ?? holding` — one predicate,
 * two possible source slots (owner 2026-08-14: "the existing trigger from
 * holding to race should still exist. Same trigger from karts to race").
 *
 * That claim is only worth anything if it is tested from both ends, so every
 * promotion case below is asserted TWICE: once for a group in the seats and once
 * for the same group in the karts. If the two ever diverge, someone has grown a
 * second copy of the rule.
 *
 * The other half is that In Karts is SKIPPABLE. A lane that never fills the slot
 * — every night until the pit station's pre-race cue is in use, and any night
 * the PA is down — has to behave exactly as the two-slot lane did, including
 * lanes written to Redis before the slot existed at all.
 */

const store = new Map<string, string>();

vi.mock("@/lib/redis", () => ({
  default: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    }),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
  },
}));

const finishedMarkers = new Map<string, number>();
const laterHeats = new Set<string>();

vi.mock("@/lib/race-business-day", () => ({ businessDayYmdET: () => "2026-08-14" }));
vi.mock("../after-response.server", () => ({ afterResponse: (fn: () => unknown) => void fn }));
vi.mock("./fast-roster.server", () => ({ primeFastRoster: vi.fn(async () => {}) }));
vi.mock("../briefing/bookmarks.server", () => ({ bookmarkBriefingEndAfter: vi.fn() }));
vi.mock("../briefing/events-db", () => ({ recordBriefingEvent: vi.fn(async () => {}) }));
vi.mock("../briefing/race-finish.server", () => ({
  readRaceFinishedMarker: vi.fn(async (sessionId: string) =>
    finishedMarkers.has(sessionId) ? { endedAtMs: finishedMarkers.get(sessionId)! } : null,
  ),
}));
vi.mock("../briefing/race-state-watch.server", () => ({
  liveHeatKey: (track: string) => `race:live-heat:${track}`,
}));
vi.mock("../briefing/state.server", () => ({
  clearBriefingRoom: vi.fn(async () => {}),
  sessionBriefed: vi.fn(async () => null),
}));
vi.mock("./day-schedule.server", () => ({
  liveHeatIsLaterThan: vi.fn(async (track: string, live: number, ours: number) =>
    laterHeats.has(`${track}:${live}>${ours}`),
  ),
}));

const { markInKarts, readPitLane, sendToHolding, overrideLaneSlot } = await import("./lane.server");

const LANE = "pit:lane:FT:blue";

/** A group, in whichever slot the case under test puts them. */
const group = (sessionId: string, heatNumber: number, atMs = 1_000) => ({
  sessionId,
  heatNumber,
  raceType: "Blue Starter",
  room: "blue" as const,
  atMs,
});

function putLane(lane: Record<string, unknown>) {
  store.set(LANE, JSON.stringify(lane));
}

/** The timing socket's reading for the track. */
function putLiveHeat(heatNumber: number, state: string) {
  store.set("race:live-heat:blue", JSON.stringify({ heatNumber, state, atMs: Date.now() }));
}

beforeEach(() => {
  store.clear();
  finishedMarkers.clear();
  laterHeats.clear();
});

/* ── the promotion, from both slots ─────────────────────────────────────── */

describe("resolveLane — one predicate, two source slots", () => {
  for (const slot of ["holding", "karts"] as const) {
    describe(`from ${slot}`, () => {
      it("promotes on the venue's finish marker", async () => {
        putLane({ [slot]: group("s1", 44), racing: null, pitted: null });
        finishedMarkers.set("s1", 9_000);

        const lane = await readPitLane("blue");

        expect(lane.racing?.sessionId).toBe("s1");
        expect(lane.racing?.heatNumber).toBe(44);
        expect(lane.holding).toBeNull();
        expect(lane.karts).toBeNull();
      });

      it("promotes when the timing socket has this heat on track", async () => {
        putLane({ [slot]: group("s1", 44), racing: null, pitted: null });
        putLiveHeat(44, "running");

        const lane = await readPitLane("blue");

        expect(lane.racing?.sessionId).toBe("s1");
        expect(lane[slot]).toBeNull();
      });

      it("promotes when a strictly later heat is loaded", async () => {
        putLane({ [slot]: group("s1", 44), racing: null, pitted: null });
        putLiveHeat(51, "running");
        laterHeats.add("blue:51>44");

        const lane = await readPitLane("blue");

        expect(lane.racing?.sessionId).toBe("s1");
      });

      it("does NOT promote on a track sitting between heats", async () => {
        putLane({ [slot]: group("s1", 44), racing: null, pitted: null });
        putLiveHeat(44, "none");

        const lane = await readPitLane("blue");

        expect(lane.racing).toBeNull();
        expect(lane[slot]?.sessionId).toBe("s1");
      });

      it("does NOT promote on an earlier heat being loaded", async () => {
        putLane({ [slot]: group("s1", 44), racing: null, pitted: null });
        putLiveHeat(43, "running");
        // laterHeats deliberately empty — 43 is not later than 44.

        const lane = await readPitLane("blue");

        expect(lane.racing).toBeNull();
        expect(lane[slot]?.sessionId).toBe("s1");
      });
    });
  }

  it("promotes the karts group, not the seats, when both are filled", async () => {
    putLane({
      holding: group("seated", 45, 2_000),
      karts: group("inkarts", 44, 1_000),
      racing: null,
      pitted: null,
    });
    finishedMarkers.set("inkarts", 9_000);
    finishedMarkers.set("seated", 9_000);

    const lane = await readPitLane("blue");

    // Karts is the later stage, so it is the group closer to the flag.
    expect(lane.racing?.sessionId).toBe("inkarts");
    // And the group behind them is untouched — they have not raced.
    expect(lane.holding?.sessionId).toBe("seated");
  });

  it("resolves a lane written before the karts slot existed", async () => {
    // No `karts` key at all — exactly what is in Redis mid-flow on deploy day.
    putLane({ holding: group("s1", 44), racing: null, pitted: null });

    const lane = await readPitLane("blue");

    expect(lane.karts).toBeNull();
    expect(lane.holding?.sessionId).toBe("s1");
  });
});

/* ── the trigger ────────────────────────────────────────────────────────── */

describe("markInKarts", () => {
  it("frees the seats and takes the karts slot", async () => {
    putLane({ holding: group("s1", 44), racing: null, pitted: null });

    await markInKarts({ track: "blue", sessionId: "s1", atMs: 5_000 });
    const lane = await readPitLane("blue");

    expect(lane.holding).toBeNull();
    expect(lane.karts?.sessionId).toBe("s1");
    // Carried off the holding record, so the board keeps its labels.
    expect(lane.karts?.heatNumber).toBe(44);
    expect(lane.karts?.raceType).toBe("Blue Starter");
    expect(lane.karts?.atMs).toBe(5_000);
  });

  it("is idempotent — a repeated cue does not restart the clock", async () => {
    putLane({ holding: group("s1", 44), racing: null, pitted: null });

    await markInKarts({ track: "blue", sessionId: "s1", atMs: 5_000 });
    await markInKarts({ track: "blue", sessionId: "s1", atMs: 8_000 });
    const lane = await readPitLane("blue");

    expect(lane.karts?.atMs).toBe(5_000);
  });

  it("refuses a session already out on track", async () => {
    putLane({
      holding: null,
      racing: { sessionId: "s1", heatNumber: 44, room: "blue" },
      pitted: null,
    });

    const result = await markInKarts({ track: "blue", sessionId: "s1" });

    expect(result.ok).toBe(false);
    const lane = await readPitLane("blue");
    expect(lane.karts).toBeNull();
  });

  it("places a group nobody sent, without evicting whoever is in the seats", async () => {
    putLane({ holding: group("seated", 45), racing: null, pitted: null });

    await markInKarts({ track: "blue", sessionId: "ghost", heatNumber: 44, atMs: 5_000 });
    const lane = await readPitLane("blue");

    expect(lane.karts?.sessionId).toBe("ghost");
    expect(lane.holding?.sessionId).toBe("seated");
  });
});

/* ── displacement ───────────────────────────────────────────────────────── */

describe("sendToHolding — displacement follows the staged group", () => {
  it("displaces the karts group into racing, not the empty seats", async () => {
    putLane({ holding: null, karts: group("inkarts", 44), racing: null, pitted: null });

    await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "next",
      heatNumber: 45,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(lane.racing?.sessionId).toBe("inkarts");
    expect(lane.karts).toBeNull();
    expect(lane.holding?.sessionId).toBe("next");
  });

  it("still displaces a holding group when nobody is in the karts", async () => {
    putLane({ holding: group("seated", 44), racing: null, pitted: null });

    await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "next",
      heatNumber: 45,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(lane.racing?.sessionId).toBe("seated");
    expect(lane.holding?.sessionId).toBe("next");
  });

  it("re-sending the seated group is a refresh, not a displacement", async () => {
    putLane({ holding: group("s1", 44), racing: null, pitted: null });

    await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "s1",
      heatNumber: 44,
      raceType: "Blue Starter",
    });
    const lane = await readPitLane("blue");

    expect(lane.racing).toBeNull();
    expect(lane.holding?.sessionId).toBe("s1");
  });
});

/* ── the desk's manual placement ────────────────────────────────────────── */

describe("overrideLaneSlot — karts", () => {
  it("places into and clears the karts slot", async () => {
    const placed = await overrideLaneSlot({
      track: "blue",
      slot: "karts",
      occupant: { sessionId: "s1", heatNumber: 44, raceType: "Blue Starter", room: "blue" },
    });
    expect(placed.ok).toBe(true);
    expect((await readPitLane("blue")).karts?.sessionId).toBe("s1");

    const cleared = await overrideLaneSlot({ track: "blue", slot: "karts", occupant: null });
    expect(cleared.ok).toBe(true);
    expect((await readPitLane("blue")).karts).toBeNull();
  });

  it("refuses a second claimant on the karts slot, naming the occupant", async () => {
    putLane({ holding: null, karts: group("s1", 44), racing: null, pitted: null });

    const result = await overrideLaneSlot({
      track: "blue",
      slot: "karts",
      occupant: { sessionId: "s2", heatNumber: 45, raceType: null, room: null },
    });

    expect(result.ok).toBe(false);
    expect(result.occupiedBy).toBe("s1");
    expect(result.error).toContain("44");
    expect((await readPitLane("blue")).karts?.sessionId).toBe("s1");
  });

  it("replaces on force", async () => {
    putLane({ holding: null, karts: group("s1", 44), racing: null, pitted: null });

    const result = await overrideLaneSlot({
      track: "blue",
      slot: "karts",
      occupant: { sessionId: "s2", heatNumber: 45, raceType: null, room: null },
      force: true,
    });

    expect(result.ok).toBe(true);
    expect((await readPitLane("blue")).karts?.sessionId).toBe("s2");
  });
});
