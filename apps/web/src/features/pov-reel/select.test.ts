import { describe, expect, it } from "vitest";
import {
  isJuniorRace,
  raceTypeFromHeatName,
  reelTierFor,
  selectReel,
  videoCoversRace,
  type ReelCandidate,
} from "./select";

/** Real shapes off the live corpus, 2026-08-16/17. */
function cand(over: Partial<ReelCandidate> = {}): ReelCandidate {
  return {
    sessionId: "58586780",
    racerName: "Chris ferguson",
    kart: "35",
    bestLapMs: 37244,
    bestLapAtMs: Date.parse("2026-08-17T03:00:02.948Z"),
    heatName: "60 - Red Intermediate",
    videoCode: "B7VF4VT67K",
    videoDurationS: 726,
    raceDurationS: 501,
    pauseCount: 0,
    blocked: false,
    ...over,
  };
}

describe("raceTypeFromHeatName", () => {
  it("splits on the venue's separator", () => {
    expect(raceTypeFromHeatName("60 - Red Intermediate")).toBe("Red Intermediate");
    expect(raceTypeFromHeatName("2 - Mega Starter")).toBe("Mega Starter");
    expect(raceTypeFromHeatName("27 - Blue GF Intermediate")).toBe("Blue GF Intermediate");
  });
  it("returns null for a group or custom event rather than guessing", () => {
    expect(raceTypeFromHeatName("Corporate Event")).toBeNull();
    expect(raceTypeFromHeatName("")).toBeNull();
    expect(raceTypeFromHeatName(null)).toBeNull();
  });
});

describe("reelTierFor", () => {
  it("tests INTERMEDIATE before PRO — the whole trap", () => {
    // "Intermediate" contains no "pro", but the ordering still matters for the
    // junior variants and any future "Pro Intermediate"-style naming.
    expect(reelTierFor("Red Intermediate")).toBe("intermediate");
    expect(reelTierFor("Blue Pro")).toBe("pro");
  });
  it("rejects Starter and anything unrecognised", () => {
    expect(reelTierFor("Blue Starter")).toBeNull();
    expect(reelTierFor("Mega Starter")).toBeNull();
    expect(reelTierFor("Corporate")).toBeNull();
  });
  it("is case-insensitive, because these are human-typed", () => {
    expect(reelTierFor("blue intermediate")).toBe("intermediate");
    expect(reelTierFor("BLUE PRO")).toBe("pro");
  });
});

describe("isJuniorRace", () => {
  it("catches the variants that PASS a naive tier test", () => {
    // Both of these return a valid reel tier — which is exactly why juniors
    // must be excluded on their own, before tier is consulted.
    expect(reelTierFor("Junior Pro Blue")).toBe("pro");
    expect(reelTierFor("Junior Intermediate Blue")).toBe("intermediate");
    expect(isJuniorRace("Junior Pro Blue")).toBe(true);
    expect(isJuniorRace("Junior Intermediate Blue")).toBe(true);
  });
  it("leaves adult races alone", () => {
    expect(isJuniorRace("Red Intermediate")).toBe(false);
    expect(isJuniorRace("Blue Pro")).toBe(false);
  });
});

describe("videoCoversRace", () => {
  it("rejects a video shorter than its race (the real NY8G4JUHFD case)", () => {
    expect(videoCoversRace(cand({ videoDurationS: 191, raceDurationS: 501 }))).toBe(false);
  });
  it("accepts a video that contains the race", () => {
    expect(videoCoversRace(cand({ videoDurationS: 829, raceDurationS: 501 }))).toBe(true);
  });
  it("accepts the marginal case where the camera ran exactly the race", () => {
    expect(videoCoversRace(cand({ videoDurationS: 761, raceDurationS: 760 }))).toBe(true);
  });
  it("passes when a duration is unknown — reject on evidence, not absence", () => {
    expect(videoCoversRace(cand({ videoDurationS: null }))).toBe(true);
    expect(videoCoversRace(cand({ raceDurationS: null }))).toBe(true);
  });
});

describe("selectReel", () => {
  it("excludes juniors, Starters, stopped races and blocked heats — with reasons", () => {
    const out = selectReel([
      cand({ racerName: "Adult Pro", heatName: "12 - Blue Pro", bestLapMs: 31000 }),
      cand({ racerName: "A Junior", heatName: "13 - Junior Pro Blue", bestLapMs: 30000 }),
      cand({ racerName: "A Starter", heatName: "14 - Blue Starter", bestLapMs: 30500 }),
      cand({
        racerName: "Red Flagged",
        heatName: "15 - Blue Pro",
        bestLapMs: 30100,
        pauseCount: 1,
      }),
      cand({ racerName: "Crashed", heatName: "16 - Blue Pro", bestLapMs: 30200, blocked: true }),
      cand({
        racerName: "No Footage",
        heatName: "17 - Blue Pro",
        bestLapMs: 30300,
        videoCode: null,
      }),
      cand({
        racerName: "Short Video",
        heatName: "18 - Blue Pro",
        bestLapMs: 30400,
        videoDurationS: 191,
        raceDurationS: 501,
      }),
    ]);
    expect(out.picked.map((p) => p.racerName)).toEqual(["Adult Pro"]);
    expect(out.rejected.map((r) => `${r.candidate.racerName}:${r.reason}`).sort()).toEqual(
      [
        "A Junior:junior",
        "A Starter:wrong-tier",
        "Crashed:staff-blocked",
        "No Footage:no-video",
        "Red Flagged:race-stopped",
        "Short Video:video-does-not-cover-race",
      ].sort(),
    );
  });

  it("splits per tier so Pro cannot take every slot", () => {
    const pros = Array.from({ length: 8 }, (_, i) =>
      cand({ racerName: `Pro ${i}`, heatName: "1 - Blue Pro", bestLapMs: 31000 + i }),
    );
    const inters = Array.from({ length: 8 }, (_, i) =>
      cand({ racerName: `Int ${i}`, heatName: "2 - Blue Intermediate", bestLapMs: 38000 + i }),
    );
    const out = selectReel([...pros, ...inters], { perTier: 5 });
    expect(out.picked).toHaveLength(10);
    expect(out.picked.filter((p) => p.tier === "pro")).toHaveLength(5);
    expect(out.picked.filter((p) => p.tier === "intermediate")).toHaveLength(5);
  });

  it("backfills when a tier cannot fill its half — the observed all-Intermediate night", () => {
    // 199 unlocked videos over 3 days produced 44 eligible and zero Pro.
    const inters = Array.from({ length: 12 }, (_, i) =>
      cand({ racerName: `Int ${i}`, heatName: "2 - Blue Intermediate", bestLapMs: 31000 + i }),
    );
    const out = selectReel(inters, { perTier: 5, backfill: true });
    expect(out.picked).toHaveLength(10);
    expect(out.picked.every((p) => p.tier === "intermediate")).toBe(true);
  });

  it("leaves the reel short when backfill is off", () => {
    const inters = Array.from({ length: 12 }, (_, i) =>
      cand({ racerName: `Int ${i}`, heatName: "2 - Blue Intermediate", bestLapMs: 31000 + i }),
    );
    expect(selectReel(inters, { perTier: 5, backfill: false }).picked).toHaveLength(5);
  });

  it("never shows the same racer twice", () => {
    const out = selectReel([
      cand({ racerName: "Chris ferguson", sessionId: "1", bestLapMs: 37244 }),
      cand({ racerName: "chris FERGUSON", sessionId: "2", bestLapMs: 36900 }),
    ]);
    expect(out.picked).toHaveLength(1);
    // The FASTER of the two survives.
    expect(out.picked[0].bestLapMs).toBe(36900);
  });

  it("ranks fastest first and numbers from 1", () => {
    const out = selectReel([
      cand({ racerName: "Slower", heatName: "1 - Blue Pro", bestLapMs: 33000 }),
      cand({ racerName: "Faster", heatName: "1 - Blue Pro", bestLapMs: 31000 }),
    ]);
    expect(out.picked.map((p) => [p.rank, p.racerName])).toEqual([
      [1, "Faster"],
      [2, "Slower"],
    ]);
  });

  it("is stable on tied lap times, so a rebuild does not reshuffle the wall", () => {
    const tied = [
      cand({ racerName: "Zoe", heatName: "1 - Blue Pro", bestLapMs: 32000 }),
      cand({ racerName: "Amy", heatName: "1 - Blue Pro", bestLapMs: 32000 }),
    ];
    expect(selectReel(tied).picked.map((p) => p.racerName)).toEqual(["Amy", "Zoe"]);
    expect(selectReel([...tied].reverse()).picked.map((p) => p.racerName)).toEqual(["Amy", "Zoe"]);
  });

  it("returns nothing rather than something wrong when there are no candidates", () => {
    expect(selectReel([]).picked).toEqual([]);
  });
});
