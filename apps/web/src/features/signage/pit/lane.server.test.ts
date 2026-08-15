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
/** Sessions whose post-race cue has demonstrably played. */
const postCues = new Set<string>();

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
vi.mock("./audio-stamps.server", () => ({
  cueKey: (cue: string, sessionId: string) => `pit:cue:${cue}:${sessionId}`,
  readCueStamp: vi.fn(async (cue: string, sessionId: string) =>
    cue === "post" && postCues.has(sessionId) ? { atMs: 7_777, durationS: null } : null,
  ),
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
  postCues.clear();
});

/* ── the promotion, from both slots ─────────────────────────────────────── */

describe("resolveLane — one predicate, two source slots", () => {
  for (const slot of ["holding", "karts"] as const) {
    describe(`from ${slot}`, () => {
      it("moves straight to the PIT when the finish marker is the witness", async () => {
        // The marker proves they went out — you cannot finish without it — but
        // it equally proves they are back. Leaving them in `racing` pinned them
        // there permanently, because resolve does not persist and the next read
        // recomputed the identical result (Red 12, 2026-08-15).
        putLane({ [slot]: group("s1", 44), racing: null, pitted: null });
        finishedMarkers.set("s1", 9_000);

        const lane = await readPitLane("blue");

        expect(lane.racing).toBeNull();
        expect(lane.pitIn?.sessionId).toBe("s1");
        expect(lane.pitIn?.heatNumber).toBe(44);
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

  /**
   * THE RED 12 SHAPE, off the live lane 2026-08-15.
   *
   * stored: racing = 11 (finished), holding = 12 (also finished, already
   * pitted). One pass used to run step 1 against 11, move it to the pit, then
   * promote 12 into `racing` on its own finish marker — with step 1 already
   * spent for the pass. Resolve does not persist, so every later read rebuilt
   * the identical result from the identical stored state and 12 showed "on
   * track" indefinitely. It had to be cleared out of Redis by hand.
   */
  it("does not pin a group that finished before it was ever promoted", async () => {
    putLane({
      holding: group("s12", 12),
      racing: group("s11", 11),
      pitted: { sessionId: "s12", atMs: 5_000 },
    });
    finishedMarkers.set("s11", 9_000);
    finishedMarkers.set("s12", 9_500);
    postCues.add("s11"); // 11's post played, which frees the pit slot

    const lane = await readPitLane("blue");

    expect(lane.racing).toBeNull();
    expect(lane.holding).toBeNull();
    expect(lane.karts).toBeNull();
    // 12 was already pitted, so its slot is spent too — the lane is idle.
    expect(lane.pitIn).toBeNull();
  });

  it("still holds a finished group in the pit when its post is owed", async () => {
    // The other half of the rule: settling must not silently discard a group
    // that has not been announced yet.
    putLane({ holding: group("s12", 12), racing: null, pitted: null });
    finishedMarkers.set("s12", 9_500);

    const lane = await readPitLane("blue");

    expect(lane.racing).toBeNull();
    expect(lane.pitIn?.sessionId).toBe("s12");
  });

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

    // Karts is the later stage, so it is the group closer to the flag — and
    // since its race has already finished it settles into the pit rather than
    // being pinned in `racing`.
    expect(lane.pitIn?.sessionId).toBe("inkarts");
    expect(lane.racing).toBeNull();
    // And the group behind them is untouched — they have not raced.
    expect(lane.holding?.sessionId).toBe("seated");
  });

  /**
   * THE STUCK RACE (owner 2026-08-14: "62 blue was posted and wasn't cleared").
   * A pitted stamp is a person saying the karts are in, which means the race is
   * over — it must end the racing claim on its own, with or without a finish
   * marker. Without that, a night when the kart bridge is silent leaves a group
   * reading RACING on two walls with no control able to clear them.
   */
  it("a pitted stamp clears the lane even with no finish marker", async () => {
    putLane({
      holding: null,
      racing: { sessionId: "s62", heatNumber: 62, room: "blue" },
      pitted: { sessionId: "s62", atMs: 5_000 },
    });
    // Deliberately no finish marker and no live heat — the silent-bridge case.

    const lane = await readPitLane("blue");

    expect(lane.racing).toBeNull();
    expect(lane.pitIn).toBeNull();
  });

  it("a pitted stamp clears the lane after a finish it answers", async () => {
    putLane({
      holding: null,
      racing: { sessionId: "s62", heatNumber: 62, room: "blue" },
      pitted: { sessionId: "s62", atMs: 9_500 },
    });
    finishedMarkers.set("s62", 9_000);

    const lane = await readPitLane("blue");
    expect(lane.racing).toBeNull();
    expect(lane.pitIn).toBeNull();
  });

  it("a pitted stamp for a DIFFERENT session leaves the pit occupied", async () => {
    putLane({
      holding: null,
      racing: { sessionId: "s62", heatNumber: 62, room: "blue" },
      pitted: { sessionId: "someone-else", atMs: 9_999 },
    });
    finishedMarkers.set("s62", 9_000);

    const lane = await readPitLane("blue");

    expect(lane.racing).toBeNull();
    expect(lane.pitIn?.sessionId).toBe("s62");
  });

  /* ── pit in ───────────────────────────────────────────────────────────── */

  /**
   * THE DESTROYED RETURNING GROUP (owner 2026-08-15: "the inbound race that is
   * still sitting in karts waiting for post announcements gets cleared by the
   * race that is sent to track").
   *
   * One `racing` slot could not hold two groups, and at the pit there are
   * routinely two: one rolling in under the chequered flag, one already in
   * their karts waiting on the green. Promotion overwrote the first with the
   * second, taking the only record that post was owed with it.
   */
  it("the group going out does NOT destroy the group coming in", async () => {
    putLane({
      holding: null,
      karts: group("next", 63),
      racing: { sessionId: "prev", heatNumber: 62, room: "blue" },
      pitted: null,
    });
    // 63 takes the track. 62 has no finish marker at all — the silent-bridge
    // night — so succession is the only thing that knows they are off it.
    putLiveHeat(63, "running");

    const lane = await readPitLane("blue");

    expect(lane.racing?.sessionId).toBe("next");
    expect(lane.pitIn?.sessionId).toBe("prev");
    expect(lane.karts).toBeNull();
  });

  it("the chequered flag moves a race off the track and into the pit", async () => {
    putLane({
      holding: null,
      racing: { sessionId: "s62", heatNumber: 62, room: "blue" },
      pitted: null,
    });
    finishedMarkers.set("s62", 9_000);

    const lane = await readPitLane("blue");

    // "On track only is when they're really out on track."
    expect(lane.racing).toBeNull();
    expect(lane.pitIn?.sessionId).toBe("s62");
    expect(lane.pitIn?.finishedAtMs).toBe(9_000);
  });

  it("the post cue clears the pit on its own, with no pitted stamp", async () => {
    putLane({
      holding: null,
      racing: { sessionId: "s62", heatNumber: 62, room: "blue" },
      pitted: null,
    });
    finishedMarkers.set("s62", 9_000);
    postCues.add("s62");

    const lane = await readPitLane("blue");

    expect(lane.pitIn).toBeNull();
    expect(lane.racing).toBeNull();
  });

  it("a group in the pit and a group on track coexist", async () => {
    putLane({
      holding: null,
      karts: null,
      racing: { sessionId: "out", heatNumber: 63, room: "blue" },
      pitIn: {
        sessionId: "in",
        heatNumber: 62,
        raceType: "Blue Starter",
        room: "blue",
        finishedAtMs: 5_000,
        atMs: 5_000,
      },
      pitted: null,
    });

    const lane = await readPitLane("blue");

    expect(lane.racing?.sessionId).toBe("out");
    expect(lane.pitIn?.sessionId).toBe("in");
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
  it("stages BEHIND a karts group instead of evicting them", async () => {
    // The normal shape of a busy night: one group in the karts waiting on the
    // green, the next sent to the seats. This used to promote the karts group
    // to `racing` on no evidence at all.
    putLane({ holding: null, karts: group("inkarts", 44), racing: null, pitted: null });

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "next",
      heatNumber: 45,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(result.ok).toBe(true);
    expect(lane.karts?.sessionId).toBe("inkarts");
    expect(lane.holding?.sessionId).toBe("next");
    expect(lane.racing).toBeNull();
  });

  it("REFUSES when holding still has a group that has not gone out", async () => {
    // Blue 27, 2026-08-15: sent to holding, then the next group was sent, and
    // 27 was written out of existence — no lane slot, no keys in Redis.
    putLane({ holding: group("seated", 44), racing: null, pitted: null });

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "next",
      heatNumber: 45,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(result.ok).toBe(false);
    // and nothing moved
    expect(lane.holding?.sessionId).toBe("seated");
    expect(lane.racing).toBeNull();
  });

  it("still displaces the seated group once they HAVE taken the track", async () => {
    // The legitimate case the displacement exists for: stored is stale after a
    // real green flag, so the press is what catches the lane up.
    putLane({ holding: group("seated", 44), racing: null, pitted: null });
    putLiveHeat(44, "running");

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "next",
      heatNumber: 45,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(result.ok).toBe(true);
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

  /**
   * THE UNCLEARABLE LANE (owner 2026-08-14: "I can't clear 62 red and its
   * done"). `racing` is derived, so emptying it while its SOURCE still sat in
   * `holding` wrote null over a field that was already null and left the next
   * read to promote the same session straight back. The press worked, the write
   * landed, and the session returned — for as long as anyone kept pressing.
   */
  it("clearing racing also clears the staged slot that derives it", async () => {
    // Stored as holding; the socket showing heat 62 on track means every read
    // resolves it to racing. (Deliberately NOT a finish marker — that now says
    // the race is over and settles them into the pit instead.)
    putLane({ holding: group("s62", 62), racing: null, pitted: null });
    putLiveHeat(62, "running");
    expect((await readPitLane("blue")).racing?.sessionId).toBe("s62");

    const result = await overrideLaneSlot({ track: "blue", slot: "racing", occupant: null });

    expect(result.ok).toBe(true);
    const lane = await readPitLane("blue");
    expect(lane.racing).toBeNull();
    expect(lane.holding).toBeNull();
    expect(lane.karts).toBeNull();
  });

  it("clearing racing also clears it out of the karts slot", async () => {
    putLane({ holding: null, karts: group("s62", 62), racing: null, pitted: null });
    putLiveHeat(62, "running");
    expect((await readPitLane("blue")).racing?.sessionId).toBe("s62");

    await overrideLaneSlot({ track: "blue", slot: "racing", occupant: null });

    const lane = await readPitLane("blue");
    expect(lane.racing).toBeNull();
    expect(lane.karts).toBeNull();
  });

  it("clearing racing leaves a DIFFERENT session in the seats alone", async () => {
    // The busy shape: one group out, the next already seated behind them.
    putLane({
      holding: group("next", 63),
      karts: group("out", 62),
      racing: null,
      pitted: null,
    });
    finishedMarkers.set("out", 9_000);

    await overrideLaneSlot({ track: "blue", slot: "racing", occupant: null });

    const lane = await readPitLane("blue");
    expect(lane.racing).toBeNull();
    expect(lane.karts).toBeNull();
    expect(lane.holding?.sessionId).toBe("next");
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
