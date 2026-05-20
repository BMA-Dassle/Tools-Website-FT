import { describe, expect, it } from "vitest";
import { GUEST_SURVEY_QUESTIONS_SEED, type SurveyQuestionTag } from "./guest-survey-db";

/**
 * Pure-logic tests for the seed pool. The seed function itself (writes to
 * Neon) is exercised in integration tests that spin up a test schema.
 */

const ALL_TAGS: SurveyQuestionTag[] = [
  "baseline",
  "bowling",
  "fnb_service",
  "food_drink",
  "gel_blaster",
  "arcade",
  "racing",
];

describe("GUEST_SURVEY_QUESTIONS_SEED", () => {
  it("has 21 questions in total (matches the user-approved spec)", () => {
    expect(GUEST_SURVEY_QUESTIONS_SEED).toHaveLength(21);
  });

  it("covers exactly the 7 approved tags — no axe, no surprises", () => {
    const tags = new Set(GUEST_SURVEY_QUESTIONS_SEED.map((q) => q.tag));
    expect(tags).toEqual(new Set(ALL_TAGS));
    expect(tags.has("axe" as SurveyQuestionTag)).toBe(false);
  });

  it("uses sequential ordinals starting at 1 within each tag", () => {
    for (const tag of ALL_TAGS) {
      const ordinals = GUEST_SURVEY_QUESTIONS_SEED.filter((q) => q.tag === tag)
        .map((q) => q.ordinal)
        .sort((a, b) => a - b);
      expect(ordinals[0]).toBe(1);
      for (let i = 1; i < ordinals.length; i++) {
        expect(ordinals[i]).toBe(ordinals[i - 1] + 1);
      }
    }
  });

  it("has the expected question count per tag", () => {
    const countByTag = Object.fromEntries(
      ALL_TAGS.map((tag) => [tag, GUEST_SURVEY_QUESTIONS_SEED.filter((q) => q.tag === tag).length]),
    );
    expect(countByTag).toEqual({
      baseline: 2,
      bowling: 3,
      fnb_service: 6,
      food_drink: 3,
      gel_blaster: 2,
      arcade: 2,
      racing: 3,
    });
  });

  it("uses only valid kinds", () => {
    const validKinds = new Set(["rating_1_5", "multi", "text", "yes_no"]);
    for (const q of GUEST_SURVEY_QUESTIONS_SEED) {
      expect(validKinds.has(q.kind)).toBe(true);
    }
  });

  it("attaches choices iff the kind is 'multi'", () => {
    for (const q of GUEST_SURVEY_QUESTIONS_SEED) {
      if (q.kind === "multi") {
        expect(q.choices, `tag=${q.tag} ord=${q.ordinal}`).toBeDefined();
        expect(q.choices!.length).toBeGreaterThanOrEqual(2);
      } else {
        expect(q.choices, `tag=${q.tag} ord=${q.ordinal}`).toBeUndefined();
      }
    }
  });

  it("never says 'bowling alley' (per feedback_bowling_center_not_alley)", () => {
    for (const q of GUEST_SURVEY_QUESTIONS_SEED) {
      expect(q.question.toLowerCase()).not.toContain("alley");
    }
  });

  describe("fnb_service gating", () => {
    const fnb = GUEST_SURVEY_QUESTIONS_SEED.filter((q) => q.tag === "fnb_service");

    it("Q1 (gate) is the 'did you have a server' yes/no, ungated", () => {
      const q1 = fnb.find((q) => q.ordinal === 1)!;
      expect(q1.kind).toBe("yes_no");
      expect(q1.question.toLowerCase()).toContain("server");
      expect(q1.gateOrdinal).toBeUndefined();
      expect(q1.gateAnswer).toBeUndefined();
    });

    it("Q2-Q5 are gated on Q1 = 'Yes'", () => {
      for (const ord of [2, 3, 4, 5]) {
        const q = fnb.find((x) => x.ordinal === ord)!;
        expect(q.gateOrdinal, `fnb_service ord=${ord}`).toBe(1);
        expect(q.gateAnswer, `fnb_service ord=${ord}`).toBe("Yes");
      }
    });

    it("Q6 (manager check) is NOT gated — fires for everyone", () => {
      const q6 = fnb.find((q) => q.ordinal === 6)!;
      expect(q6.question.toLowerCase()).toContain("manager");
      expect(q6.gateOrdinal).toBeUndefined();
      expect(q6.gateAnswer).toBeUndefined();
    });
  });

  it("no question outside fnb_service uses gating (current spec)", () => {
    for (const q of GUEST_SURVEY_QUESTIONS_SEED) {
      if (q.tag === "fnb_service") continue;
      expect(q.gateOrdinal, `${q.tag} ord=${q.ordinal}`).toBeUndefined();
      expect(q.gateAnswer, `${q.tag} ord=${q.ordinal}`).toBeUndefined();
    }
  });

  it("bowling Q2 references 'bowling area' not 'bowling center' (per user edit)", () => {
    const q = GUEST_SURVEY_QUESTIONS_SEED.find((x) => x.tag === "bowling" && x.ordinal === 2)!;
    expect(q.question).toContain("bowling area");
    expect(q.question).not.toContain("bowling center");
  });
});
