import { describe, expect, it } from "vitest";

import {
  JUNIOR_MIRROR_WINDOW_MINUTES,
  pickJuniorMirror,
  raceLegEndMs,
  type ComboHeatCandidate,
} from "./combo-booking";
import { buildChains, wallClockMs, type LegCandidate } from "./combo-itinerary";

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

describe("pickJuniorMirror — first junior heat right after the adult one", () => {
  const adultStartMs = wallClockMs(iso("14:00"));

  it("picks the earliest junior block strictly after the adult heat", () => {
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

  it("never mirrors onto the adult's own start (juniors race AFTER, not alongside)", () => {
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

  it("window boundary: +36 min is in, the next grid slot is out", () => {
    expect(JUNIOR_MIRROR_WINDOW_MINUTES).toBe(36);
    expect(pickJuniorMirror(blocksAt([["14:36", block()]]), adultStartMs, 1)?.start).toBe(
      iso("14:36"),
    );
    expect(pickJuniorMirror(blocksAt([["14:48", block()]]), adultStartMs, 1)).toBeNull();
  });

  it("null when no junior block exists in the window", () => {
    expect(pickJuniorMirror(blocksAt([["13:48", block()]]), adultStartMs, 1)).toBeNull();
    expect(pickJuniorMirror(new Map(), adultStartMs, 1)).toBeNull();
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
