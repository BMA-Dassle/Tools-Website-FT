import { describe, expect, it } from "vitest";

import type {
  RestrictionBlock,
  TrackTierBlock,
} from "~/features/booking/service/race-restriction-rules";

import {
  comboChainTiming,
  isWeekdayYmd,
  JUNIOR_MIRROR_WINDOW_MINUTES,
  makeComboRestrictionCheck,
  pickJuniorMirror,
  raceLegEndMs,
  type ComboHeatCandidate,
} from "./combo-booking";
import { buildChains, wallClockMs, type LegCandidate } from "./combo-itinerary";
import { getComboSpecial } from "./combo-specials";

/** Naive ET wall-clock ISO on 2026-06-01 (BMI wall-clock-in-Z form). */
const iso = (t: string) => `2026-06-01T${t}:00Z`;

const block = (freeSpots = 8) => ({
  stop: "",
  freeSpots,
  productId: "junior-starter-blue",
  track: "Blue" as string | null,
});

const blocksAt = (entries: Array<[string, ReturnType<typeof block>]>) =>
  new Map(entries.map(([t, b]) => [iso(t), b]));

describe("pickJuniorMirror — junior heat nearest the adult one (either side)", () => {
  const adultStartMs = wallClockMs(iso("14:00"));

  it("picks the junior block nearest the adult heat", () => {
    const r = pickJuniorMirror(
      blocksAt([
        ["14:24", block()],
        ["14:12", block()],
      ]),
      adultStartMs,
      1,
    );
    expect(r?.start).toBe(iso("14:12"));
  });

  it("picks a BEFORE slot when it is nearest (owner 2026-07-14: juniors can race before)", () => {
    const r = pickJuniorMirror(
      blocksAt([
        ["13:48", block()],
        ["14:24", block()],
      ]),
      adultStartMs,
      1,
    );
    expect(r?.start).toBe(iso("13:48"));
  });

  it("exact-distance tie prefers AFTER (keeps the 'right after the adults' default)", () => {
    const r = pickJuniorMirror(
      blocksAt([
        ["13:48", block()],
        ["14:12", block()],
      ]),
      adultStartMs,
      1,
    );
    expect(r?.start).toBe(iso("14:12"));
  });

  it("never mirrors onto the adult's own start (shared-track double-book hazard)", () => {
    const r = pickJuniorMirror(blocksAt([["14:00", block()]]), adultStartMs, 1);
    expect(r).toBeNull();
  });

  it("skips blocks without room for every junior", () => {
    const r = pickJuniorMirror(
      blocksAt([
        ["14:12", block(1)],
        ["14:24", block(4)],
      ]),
      adultStartMs,
      2,
    );
    expect(r?.start).toBe(iso("14:24"));
  });

  it("window boundaries both directions: ±36 min in, the next grid slot out", () => {
    expect(JUNIOR_MIRROR_WINDOW_MINUTES).toBe(36);
    expect(pickJuniorMirror(blocksAt([["14:36", block()]]), adultStartMs, 1)?.start).toBe(
      iso("14:36"),
    );
    expect(pickJuniorMirror(blocksAt([["14:48", block()]]), adultStartMs, 1)).toBeNull();
    expect(pickJuniorMirror(blocksAt([["13:24", block()]]), adultStartMs, 1)?.start).toBe(
      iso("13:24"),
    );
    expect(pickJuniorMirror(blocksAt([["13:12", block()]]), adultStartMs, 1)).toBeNull();
  });

  it("a predicate-rejected slot falls through to the next nearest legal one", () => {
    const r = pickJuniorMirror(
      blocksAt([
        ["14:12", block()],
        ["14:24", block()],
      ]),
      adultStartMs,
      1,
      { isSlotAllowed: (slot) => slot.start !== iso("14:12") },
    );
    expect(r?.start).toBe(iso("14:24"));
  });

  it("null when the predicate rejects everything in the window", () => {
    const r = pickJuniorMirror(
      blocksAt([
        ["13:48", block()],
        ["14:12", block()],
      ]),
      adultStartMs,
      1,
      { isSlotAllowed: () => false },
    );
    expect(r).toBeNull();
  });

  it("null when no junior block exists in the window", () => {
    expect(pickJuniorMirror(blocksAt([["15:00", block()]]), adultStartMs, 1)).toBeNull();
    expect(pickJuniorMirror(new Map(), adultStartMs, 1)).toBeNull();
  });
});

describe("makeComboRestrictionCheck — restriction rules + lead cutoff for combo slots", () => {
  const nowMs = wallClockMs(iso("09:00")); // hours before — no last-minute lifts
  const rb = (t: string, freeSpots: number, capacity = 10): RestrictionBlock => ({
    startMs: wallClockMs(iso(t)),
    freeSpots,
    capacity,
  });
  const tb = (t: string, freeSpots: number, adultStarter = false): TrackTierBlock => ({
    ...rb(t, freeSpots),
    adultStarter,
  });
  const slot = (t: string) => ({ start: iso(t), startMs: wallClockMs(iso(t)), track: "Blue" });

  it("blocks an intermediate slot whose clock hour has no Starter room left", () => {
    // 15:12/15:24/15:36 occupied by non-Starter sessions; only 15:48 still
    // empty besides the candidate → booking 15:00 would leave 1 < 2 room.
    const check = makeComboRestrictionCheck({
      tier: "intermediate",
      category: "adult",
      nowMs,
      leadCutoffMs: null,
      productBlocksByTrack: new Map([["Blue", [rb("15:00", 10)]]]),
      allTierByTrack: new Map([
        [
          "Blue",
          [tb("15:00", 10), tb("15:12", 0), tb("15:24", 0), tb("15:36", 0), tb("15:48", 10)],
        ],
      ]),
    });
    expect(check(slot("15:00"))).toBe(false);
  });

  it("fails OPEN when the all-tier union is missing for the track (undefined)", () => {
    const check = makeComboRestrictionCheck({
      tier: "intermediate",
      category: "adult",
      nowMs,
      leadCutoffMs: null,
      productBlocksByTrack: new Map([["Blue", [rb("15:00", 10)]]]),
      allTierByTrack: new Map([["Blue", undefined]]),
    });
    expect(check(slot("15:00"))).toBe(true);
  });

  it("enforces the new-racer lead cutoff (a before-mirror can start earlier than the adult heat)", () => {
    const check = makeComboRestrictionCheck({
      tier: "starter",
      category: "junior",
      nowMs,
      leadCutoffMs: wallClockMs(iso("14:00")),
      productBlocksByTrack: new Map([["Blue", []]]),
    });
    expect(check(slot("13:48"))).toBe(false);
    expect(check(slot("14:12"))).toBe(true);
  });

  it("junior back-to-back: blocks a new session beside an occupied junior, allows joining one", () => {
    const productBlocksByTrack = new Map([
      ["Blue", [rb("13:36", 5, 7), rb("13:24", 4, 7), rb("14:12", 7, 7)]],
    ]);
    const juniorUnionByTrack = new Map([
      ["Blue", [rb("13:36", 5, 7), rb("13:24", 4, 7), rb("14:12", 7, 7)]],
    ]);
    const check = makeComboRestrictionCheck({
      tier: "starter",
      category: "junior",
      nowMs,
      leadCutoffMs: null,
      productBlocksByTrack,
      juniorUnionByTrack,
    });
    // Joining the occupied 13:36 session (occupied neighbor at 13:24) — allowed.
    expect(check(slot("13:36"))).toBe(true);
    // A NEW session at 14:12 is fine (nearest occupied junior is 13:36, 36 min).
    expect(check(slot("14:12"))).toBe(true);
    // A NEW session at 13:48 sits 12 min from the occupied 13:36 — blocked.
    expect(check({ start: iso("13:48"), startMs: wallClockMs(iso("13:48")), track: "Blue" })).toBe(
      false,
    );
  });

  it("isComboBooking exempts the VIP anchor reserve (2 PM empty slot stays bookable)", () => {
    const check = makeComboRestrictionCheck({
      tier: "starter",
      category: "adult",
      nowMs,
      leadCutoffMs: null,
      productBlocksByTrack: new Map([["Blue", [rb("14:00", 10)]]]),
    });
    expect(check(slot("14:00"))).toBe(true);
  });
});

describe("raceLegEndMs — leg ends 30 min after its LAST race", () => {
  const candidate = (juniorStart?: string): ComboHeatCandidate => ({
    start: iso("14:00"),
    stop: iso("14:12"),
    track: "Red",
    freeSpots: 6,
    perCategory: {
      adult: { productId: "adult-starter-red", track: "Red", freeSpots: 6 },
      ...(juniorStart
        ? {
            junior: {
              productId: "junior-starter-blue",
              track: "Blue",
              freeSpots: 8,
              start: juniorStart,
              stop: "",
            },
          }
        : {}),
    },
  });

  it("no mirror → anchor + 30 min (current behavior)", () => {
    expect(raceLegEndMs(candidate())).toBe(wallClockMs(iso("14:30")));
  });

  it("mirrored junior at :12 → junior start + 30 min", () => {
    expect(raceLegEndMs(candidate(iso("14:12")))).toBe(wallClockMs(iso("14:42")));
  });

  it("a same-start junior (no start override) does not move the end", () => {
    const c = candidate();
    c.perCategory.junior = { productId: "junior-starter-blue", track: "Blue", freeSpots: 8 };
    expect(raceLegEndMs(c)).toBe(wallClockMs(iso("14:30")));
  });

  it("a junior mirror BEFORE the adult heat does not move the end (max-of-starts)", () => {
    expect(raceLegEndMs(candidate(iso("13:48")))).toBe(wallClockMs(iso("14:30")));
  });
});

describe("chain math — bowling window measures from the junior mirror's end", () => {
  const legCand = (startIso: string, endMs: number, payload: string): LegCandidate<string> => ({
    startIso,
    startMs: wallClockMs(startIso),
    endMs,
    payload,
  });
  const lane = (t: string) => legCand(iso(t), wallClockMs(iso(t)) + 90 * 60_000, `lane-${t}`);

  it("a lane that fit the adult-only leg is too soon once the junior heat extends it", () => {
    // Adult 14:00 (+30 = 14:30) vs mirrored junior 14:12 (leg end 14:42, via
    // raceLegEndMs). 15-min transition → bowling floors at 14:45 vs 14:57.
    const adultOnlyLeg = [legCand(iso("14:00"), wallClockMs(iso("14:30")), "race")];
    const mirroredLeg = [legCand(iso("14:00"), wallClockMs(iso("14:42")), "race")];
    const earlyLane = [lane("14:45")];
    expect(buildChains([adultOnlyLeg, earlyLane], 15, [null, 75])[0].chain).not.toBeNull();
    expect(buildChains([mirroredLeg, earlyLane], 15, [null, 75])[0].chain).toBeNull();
    // A 15:00 lane satisfies both the 14:57 floor and the 75-min max wait
    // (14:42 + 75 = 15:57).
    expect(buildChains([mirroredLeg, [lane("15:00")]], 15, [null, 75])[0].chain).not.toBeNull();
  });
});

describe("comboChainTiming — Mon–Fri bowling compression (owner 2026-08-10)", () => {
  const combo = getComboSpecial("race-bowl")!;
  // 2026-06-01 = Monday, 06-05 = Friday, 06-06 = Saturday, 06-07 = Sunday.
  const MON = "2026-06-01";
  const FRI = "2026-06-05";
  const SAT = "2026-06-06";

  it("isWeekdayYmd: Mon–FRI true, Sat/Sun false (Friday is a weekday HERE, unlike pricing)", () => {
    expect(isWeekdayYmd(MON)).toBe(true);
    expect(isWeekdayYmd(FRI)).toBe(true);
    expect(isWeekdayYmd(SAT)).toBe(false);
    expect(isWeekdayYmd("2026-06-07")).toBe(false);
  });

  it("weekend: the normal 15-min transition and per-leg waits pass through untouched", () => {
    const t = comboChainTiming(combo, combo.components, SAT);
    expect(t.transitionMinutes).toBe(15);
    expect(t.maxWaitMinutes).toEqual([null, 75, null]);
    expect(t.minWaitMinutes).toEqual([null, null, null]);
  });

  it("weekday: the bowling buffer drops to 0 — every other leg keeps 15 via its minWait", () => {
    const t = comboChainTiming(combo, combo.components, MON);
    expect(t.transitionMinutes).toBe(0);
    expect(t.maxWaitMinutes).toEqual([null, 75, null]);
    expect(t.minWaitMinutes).toEqual([15, null, 15]);
  });

  it("weekday fallback ordering: race 2 keeps its own ≥20 floor; the trailing lane drops to 0", () => {
    const t = comboChainTiming(combo, combo.fallbackComponents!, MON);
    expect(t.transitionMinutes).toBe(0);
    expect(t.maxWaitMinutes).toEqual([null, 45, 45]);
    expect(t.minWaitMinutes).toEqual([15, 20, null]);
  });

  it("end-to-end: a lane at race-start + 30 chains on Monday but NOT on Saturday", () => {
    const legCand = (startIso: string, endMs: number, payload: string): LegCandidate<string> => ({
      startIso,
      startMs: wallClockMs(startIso),
      endMs,
      payload,
    });
    // Starter 2:00 (leg end 2:30) → lane 2:30–4:00 → Intermediate 4:15.
    const legs = [
      [legCand(iso("14:00"), wallClockMs(iso("14:30")), "race1")],
      [legCand(iso("14:30"), wallClockMs(iso("16:00")), "lane")],
      [legCand(iso("16:15"), wallClockMs(iso("16:45")), "race2")],
    ];
    const weekday = comboChainTiming(combo, combo.components, MON);
    const weekend = comboChainTiming(combo, combo.components, SAT);
    expect(
      buildChains(
        legs,
        weekday.transitionMinutes,
        weekday.maxWaitMinutes,
        weekday.minWaitMinutes,
      )[0].chain,
    ).not.toBeNull();
    expect(
      buildChains(
        legs,
        weekend.transitionMinutes,
        weekend.maxWaitMinutes,
        weekend.minWaitMinutes,
      )[0].chain,
    ).toBeNull();
  });
});
