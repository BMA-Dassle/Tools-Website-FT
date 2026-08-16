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
/** Sessions the venue broadcast has stamped a GREEN FLAG for. */
const startedMarkers = new Map<string, number>();
const laterHeats = new Set<string>();
/** Sessions whose post-race cue has demonstrably played. */
const postCues = new Set<string>();
/** Each briefing room's live state — what the server's film gate reads. NOT
 *  mocked away as null, because a null room is the gate's own exempt case and
 *  would make every test below pass without exercising the rule. */
const briefingRooms = new Map<string, unknown>();

vi.mock("@/lib/race-business-day", () => ({ businessDayYmdET: () => "2026-08-14" }));
vi.mock("../after-response.server", () => ({ afterResponse: (fn: () => unknown) => void fn }));
vi.mock("./fast-roster.server", () => ({ primeFastRoster: vi.fn(async () => {}) }));
vi.mock("../briefing/bookmarks.server", () => ({ bookmarkBriefingEndAfter: vi.fn() }));
vi.mock("../briefing/events-db", () => ({ recordBriefingEvent: vi.fn(async () => {}) }));
vi.mock("../briefing/race-finish.server", () => ({
  readRaceFinishedMarker: vi.fn(async (sessionId: string) =>
    finishedMarkers.has(sessionId) ? { endedAtMs: finishedMarkers.get(sessionId)! } : null,
  ),
  readRaceStartedMarker: vi.fn(async (sessionId: string) => startedMarkers.get(sessionId) ?? null),
}));
vi.mock("../briefing/race-state-watch.server", () => ({
  liveHeatKey: (track: string) => `race:live-heat:${track}`,
}));
vi.mock("../briefing/state.server", () => ({
  clearBriefingRoom: vi.fn(async () => {}),
  sessionBriefed: vi.fn(async () => null),
  readBriefingRoom: vi.fn(async (_venue: string, room: string) => briefingRooms.get(room) ?? null),
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
const { holdingAvailability } = await import("./holding-availability");

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
  startedMarkers.clear();
  laterHeats.clear();
  postCues.clear();
  briefingRooms.clear();
});

/* ── the film gate, server side ─────────────────────────────────────────── */

/**
 * A room mid-film, keyed to real time because the gate asks Date.now().
 * `back` is how long ago the send fired, so 0 is a film that just started.
 */
function putBriefingRoom(
  room: "red" | "blue",
  args: { sessionId: string; backMs: number; videoMs?: number; kind?: "assigned" | "timeline" },
) {
  briefingRooms.set(room, {
    kind: args.kind ?? "timeline",
    tier: "starter",
    track: room,
    raceType: "Starter",
    sessionId: args.sessionId,
    heatNumber: 44,
    triggeredAtMs: Date.now() - args.backMs,
    videoUrl: "https://example.test/starter.mp4",
    videoDurationMs: args.videoMs ?? 4 * 60_000,
  });
}

describe("sendToHolding — the safety film is a gate on the server too", () => {
  it("REFUSES a staff press while the film is still playing", async () => {
    // Owner 2026-08-15, live: "they were able to send to holding when briefing
    // was playing". Both surfaces drew the rule; neither enforced it, so a
    // tablet running older JS walked a group out mid-briefing.
    putLane({ holding: null, racing: null, pitted: null });
    putBriefingRoom("blue", { sessionId: "s44", backMs: 30_000 });

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "s44",
      heatNumber: 44,
      raceType: "Starter",
    });
    const lane = await readPitLane("blue");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/still playing/);
    // and nothing moved — no seat taken, no room closed
    expect(lane.holding).toBeNull();
  });

  it("REFUSES before the film has been rolled at all", async () => {
    putLane({ holding: null, racing: null, pitted: null });
    putBriefingRoom("blue", { sessionId: "s44", backMs: 5_000, kind: "assigned" });

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "s44",
      heatNumber: 44,
      raceType: "Starter",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not started/);
  });

  it("ALLOWS the send once the film has finished", async () => {
    putLane({ holding: null, racing: null, pitted: null });
    putBriefingRoom("blue", { sessionId: "s44", backMs: 4 * 60_000 + 5_000 });

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "s44",
      heatNumber: 44,
      raceType: "Starter",
    });

    expect(result.ok).toBe(true);
    expect((await readPitLane("blue")).holding?.sessionId).toBe("s44");
  });

  it("ALLOWS a send when the room is holding a DIFFERENT session", async () => {
    // Someone else's timeline says nothing about this group, and refusing on it
    // would strand them with no way off the board.
    putLane({ holding: null, racing: null, pitted: null });
    putBriefingRoom("blue", { sessionId: "someone-else", backMs: 30_000 });

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "s44",
      heatNumber: 44,
      raceType: "Starter",
    });

    expect(result.ok).toBe(true);
  });

  it("ALLOWS the camera sweep mid-film — an empty room is evidence, not a clock", async () => {
    // auto-holding fires on having OBSERVED the room empty: the group has
    // already walked out, so the send records where people are rather than
    // moving them.
    putLane({ holding: null, racing: null, pitted: null });
    putBriefingRoom("blue", { sessionId: "s44", backMs: 30_000 });

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "s44",
      heatNumber: 44,
      raceType: "Starter",
      reason: "auto-holding",
    });

    expect(result.ok).toBe(true);
  });
});

/* ── a `finished` reading for a race that never ran ─────────────────────── */

/**
 * BLUE 66/67, 2026-08-15 — THE NIGHT A GROUP WAS ERASED BY ONE SOCKET FRAME.
 *
 * race-state.ts buckets the socket's `S` field as `>= 3 finished`, and a heat
 * that is merely LOADED reports into that bucket too. The feed called Blue 66
 * `finished` at 10:41:07 PM; 66's green flag was at 10:44:34 PM. The group was
 * sitting in the briefing room the whole time.
 *
 * The damage was a chain, so these tests walk it: the bad promotion, the pinned
 * finish that outlives it, and the tablet being cleared to seat the next group
 * on top. `running` and `paused` must keep working with no marker at all — they
 * cannot be said of a race that has not started, and requiring a marker for them
 * would break every night the webhook is slow.
 */
describe("resolveLane — the live feed cannot retire a race that never started", () => {
  for (const slot of ["holding", "karts"] as const) {
    it(`does NOT promote from ${slot} on a "finished" reading with no start marker`, async () => {
      putLane({ [slot]: group("s66", 66), racing: null, pitted: null });
      putLiveHeat(66, "finished");
      // No startedMarkers entry — this race has never turned a wheel.

      const lane = await readPitLane("blue");

      expect(lane.racing).toBeNull();
      expect(lane.pitIn).toBeNull();
      expect(lane[slot]?.sessionId).toBe("s66");
    });

    it(`DOES promote from ${slot} once the green flag has been stamped`, async () => {
      putLane({ [slot]: group("s66", 66), racing: null, pitted: null });
      putLiveHeat(66, "finished");
      startedMarkers.set("s66", 5_000);

      const lane = await readPitLane("blue");

      // They leave the staged slot, which is the whole point: the marker makes
      // the witness admissible again. They land in `racing` rather than the pit
      // because only the BROADCAST finish marker routes straight there — the
      // live witness is answered by step 1 on a later pass, once the pitted
      // press or the post cue writes something to the stored lane.
      expect(lane.racing?.sessionId).toBe("s66");
      expect(lane[slot]).toBeNull();
    });

    for (const state of ["running", "paused"] as const) {
      it(`still promotes from ${slot} on "${state}" with no marker`, async () => {
        putLane({ [slot]: group("s66", 66), racing: null, pitted: null });
        putLiveHeat(66, state);

        const lane = await readPitLane("blue");

        expect(lane.racing?.sessionId).toBe("s66");
        expect(lane[slot]).toBeNull();
      });
    }
  }

  it("does not pin a finish time for a race that never started", async () => {
    putLane({ holding: null, racing: group("s66", 66), pitted: null });
    putLiveHeat(66, "finished");

    const lane = await readPitLane("blue");

    // Still on track as far as we can honestly tell — and, the point of the
    // test, NOTHING was written to the NX pin, which would have been permanent.
    expect(lane.racing?.sessionId).toBe("s66");
    expect(lane.pitIn).toBeNull();
    expect(store.get("pit:live-finished:s66")).toBeUndefined();
  });

  it("keeps the seats shut against the next group — the whole incident", async () => {
    // 66 is in the seats. The feed calls the loaded heat `finished`.
    putLane({ holding: group("s66", 66), racing: null, pitted: null });
    putLiveHeat(66, "finished");

    // The tablet and the server read the same rule off this lane.
    const lane = await readPitLane("blue");
    const verdict = holdingAvailability({
      holding: lane.holding,
      racing: lane.racing,
      pitIn: lane.pitIn,
      sessionId: "s67",
    });
    expect(verdict.ok).toBe(false);

    // ...and the server refuses the send, so 67 never lands on top of 66.
    const sent = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "s67",
      heatNumber: 67,
      raceType: "Junior Intermediate",
    });
    expect(sent.ok).toBe(false);

    const after = await readPitLane("blue");
    expect(after.holding?.sessionId).toBe("s66");
  });
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

  /**
   * THE LEVEL TRAVELS WITH THE GROUP (owner 2026-08-15, the idle pit board:
   * "add the session type to those").
   *
   * `racing` never stored a raceType, so the type died at the green flag — and
   * `pitIn`, which is DERIVED from `racing`, was therefore hardcoded null at
   * all three of its construction sites. Every stage after the karts printed a
   * bare session number.
   */
  it("carries the race type from the staged slot through racing and into the pit", async () => {
    putLane({ karts: group("s1", 44), racing: null, pitted: null });
    putLiveHeat(44, "running");

    const out = await readPitLane("blue");
    expect(out.racing?.raceType).toBe("Blue Starter");

    // …and the same group, once their finish lands, keeps it in the pit.
    putLane({ karts: null, racing: { ...group("s1", 44) }, pitted: null });
    finishedMarkers.set("s1", 9_000);

    const back = await readPitLane("blue");
    expect(back.pitIn?.sessionId).toBe("s1");
    expect(back.pitIn?.raceType).toBe("Blue Starter");
  });

  it("resolves a lane written before racing carried a type", async () => {
    // Mid-flow when this shipped: the stored slot has no raceType at all, and
    // a null type must be the answer rather than a crash or a stale guess.
    putLane({
      holding: null,
      racing: { sessionId: "s62", heatNumber: 62, room: "blue" },
      pitted: null,
    });
    finishedMarkers.set("s62", 9_000);

    const lane = await readPitLane("blue");

    expect(lane.pitIn?.sessionId).toBe("s62");
    expect(lane.pitIn?.raceType).toBeNull();
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

  /**
   * THE VANISHING POST (owner 2026-08-15: "if a race comes back, and another
   * gets moved into holding our post goes away even if not played, this also
   * means we lose our hold indicator").
   *
   * A's pit-in was DERIVED from `stored.racing = A` on every read. The press
   * displaced B into `racing`, severing that anchor, and the write carried no
   * pitIn field at all — so the hold rail and the record that A's post was owed
   * evaporated on the button. The resolved pit-in must ride the write.
   */
  it("keeps the returning group's pit-in when the press displaces the group that went out", async () => {
    putLane({
      holding: null,
      karts: group("outB", 45),
      racing: { sessionId: "backA", heatNumber: 44, room: "blue" },
      pitted: null,
    });
    finishedMarkers.set("backA", 9_000); // A is back, post owed
    putLiveHeat(45, "running"); // B has taken the track

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "nextC",
      heatNumber: 46,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(result.ok).toBe(true);
    expect(lane.holding?.sessionId).toBe("nextC");
    expect(lane.racing?.sessionId).toBe("outB");
    // The whole point: A is still in the pit, hold up, post still owed.
    expect(lane.pitIn?.sessionId).toBe("backA");
    expect(lane.pitIn?.finishedAtMs).toBe(9_000);
  });

  it("a displaced group already settled into the pit is not re-declared racing", async () => {
    // B went out AND finished before the press landed — they are back, not out.
    putLane({ holding: null, karts: group("outB", 45), racing: null, pitted: null });
    finishedMarkers.set("outB", 9_000);

    const result = await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "nextC",
      heatNumber: 46,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(result.ok).toBe(true);
    expect(lane.holding?.sessionId).toBe("nextC");
    expect(lane.pitIn?.sessionId).toBe("outB");
    expect(lane.racing).toBeNull();
  });

  it("a stored (hand-placed) pit-in survives the press", async () => {
    putLane({
      holding: null,
      karts: null,
      racing: null,
      pitIn: {
        sessionId: "in",
        heatNumber: 44,
        raceType: null,
        room: "blue",
        finishedAtMs: null,
        atMs: 5_000,
      },
      pitted: null,
    });

    await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "next",
      heatNumber: 45,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(lane.holding?.sessionId).toBe("next");
    expect(lane.pitIn?.sessionId).toBe("in");
  });

  it("does not resurrect a pit-in the pitted press already answered", async () => {
    // The write drops the pitted stamp (it is keyed to `racing`), so persisting
    // the STORED pit-in here would bring back a group with nothing left able to
    // clear it. Persisting the resolved value — null, because it was answered —
    // is what this pins.
    putLane({
      holding: null,
      karts: null,
      racing: null,
      pitIn: {
        sessionId: "in",
        heatNumber: 44,
        raceType: null,
        room: "blue",
        finishedAtMs: null,
        atMs: 5_000,
      },
      pitted: { sessionId: "in", atMs: 6_000 },
    });

    await sendToHolding({
      room: "blue",
      track: "blue",
      sessionId: "next",
      heatNumber: 45,
      raceType: "Blue Pro",
    });
    const lane = await readPitLane("blue");

    expect(lane.holding?.sessionId).toBe("next");
    expect(lane.pitIn).toBeNull();
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
