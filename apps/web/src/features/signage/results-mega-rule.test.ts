import { describe, it, expect } from "vitest";
import { mergeCandidates, rankFinished } from "./results-board";

/**
 * THE MEGA RULE for a scores wall.
 *
 * A results board's candidate list spans its own track AND Mega (see
 * buildBoard), and `rankFinished` is what decides between them — so these are
 * the cases that decide what a Blue-labelled wall shows on a Mega night.
 *
 * Kept in its own file rather than appended to results-board.test.ts because it
 * is testing one RULE across four situations, not the function's mechanics.
 */
const race = (id: string, track: "blue" | "mega", endedAtMs: number | null) => ({
  sessionId: id,
  heatNumber: null,
  heatName: null,
  endedAtMs,
  track,
});

describe("rankFinished — the mega rule", () => {
  it("ordinary day: only Blue has finishes, so Blue wins and nothing changes", () => {
    const ranked = rankFinished([race("b1", "blue", 100), race("b2", "blue", 200)]);
    expect(ranked[0]).toMatchObject({ sessionId: "b2", track: "blue" });
  });

  it("mega day: a Blue wall follows the combined circuit", () => {
    // Nobody raced Blue at all — the barrier is out.
    const ranked = rankFinished([race("m1", "mega", 100), race("m2", "mega", 200)]);
    expect(ranked[0]).toMatchObject({ sessionId: "m2", track: "mega" });
  });

  it("MIXED day: Blue in the afternoon, Mega in the evening — the evening wins", () => {
    // The case a plain "own track first, else Mega" fallback gets wrong: it
    // would sit on the afternoon's last Blue race all evening. That is the
    // stale-carry poisoning mega-mode.server exists to prevent.
    const ranked = rankFinished([
      race("blue-afternoon", "blue", 1_000),
      race("mega-evening", "mega", 9_000),
    ]);
    expect(ranked[0]).toMatchObject({ sessionId: "mega-evening", track: "mega" });
  });

  it("FLAG AHEAD OF THE DATA: shows last night's real race, not an empty board", () => {
    // Observed live 2026-08-18 00:30 — the flag read Mega because Tuesday is a
    // Mega day, but the business day was still Monday's split-track night, with
    // 37 Blue/Red timings and zero Mega. Force-swapping to Mega found nothing
    // and blanked the wall; ranking by finish time finds Heat 60.
    const ranked = rankFinished([race("heat-60-blue", "blue", 5_000)]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ sessionId: "heat-60-blue", track: "blue" });
  });

  it("carries each race's own track, so a Mega heat is never captioned Blue", () => {
    const ranked = rankFinished([race("b", "blue", 100), race("m", "mega", 200)]);
    expect(ranked.map((r) => r.track)).toEqual(["mega", "blue"]);
  });

  it("a still-running Mega race does not displace a finished Blue one", () => {
    // Only finishes are subjects; a green-flagged Mega heat must not blank the
    // wall that is currently showing the race before it.
    const ranked = rankFinished([
      race("mega-running", "mega", null),
      race("blue-done", "blue", 10),
    ]);
    expect(ranked.map((r) => r.sessionId)).toEqual(["blue-done"]);
  });
});

describe("mergeCandidates — track", () => {
  it("keeps the first source's track, like every other field", () => {
    const merged = mergeCandidates([
      [{ sessionId: "A", heatNumber: 1, heatName: null, endedAtMs: 1, track: "mega" as const }],
      [{ sessionId: "A", heatNumber: 1, heatName: "x", endedAtMs: 2, track: "blue" as const }],
    ]);
    expect(merged[0].track).toBe("mega");
  });

  it("keeps both tracks' races when they are different sessions", () => {
    const merged = mergeCandidates([[race("b", "blue", 100)], [race("m", "mega", 200)]]);
    expect(merged.map((c) => c.track).sort()).toEqual(["blue", "mega"]);
  });
});
