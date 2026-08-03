import { describe, expect, it } from "vitest";
import {
  GUEST_SURVEY_QUESTIONS_SEED,
  type SurveyQuestionKind,
  type SurveyQuestionTag,
} from "./guest-survey-db";

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
  "closing",
];

describe("GUEST_SURVEY_QUESTIONS_SEED", () => {
  it("has the expected total question count", () => {
    // 2 baseline + 2 bowling + 6 fnb_service + 6 food_drink + 2 gel_blaster
    // + 2 arcade + 8 racing + 2 closing = 30
    expect(GUEST_SURVEY_QUESTIONS_SEED).toHaveLength(30);
  });

  it("covers exactly the 8 approved tags — no axe, no surprises", () => {
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
      bowling: 2,
      fnb_service: 6,
      // food_drink grew 3 → 6 and racing 3 → 8 with the FastTrax racing survey
      // (88dd28d7, 2026-06-14): food_drink became the racing-side mirror of the
      // fnb_service block, and racing gained the slow-down and front-desk-wait
      // branches. Gating keeps the guest-facing length short.
      food_drink: 6,
      gel_blaster: 2,
      arcade: 2,
      racing: 8,
      closing: 2,
    });
  });

  it("does NOT include the removed 'lane open on time' question", () => {
    const hits = GUEST_SURVEY_QUESTIONS_SEED.filter((q) =>
      q.question.toLowerCase().includes("lane open"),
    );
    expect(hits).toHaveLength(0);
  });

  it("closing tag includes Team Member Fist Bump and an open comments box", () => {
    const closing = GUEST_SURVEY_QUESTIONS_SEED.filter((q) => q.tag === "closing");
    expect(closing).toHaveLength(2);
    expect(closing[0].question.toLowerCase()).toContain("team member fist bump");
    expect(closing[0].kind).toBe("text");
    // The comments box became an ADAPTIVE free-text box (d76b4c6c, 2026-06-14):
    // it always renders like `text`, but its prompt changes when the guest has
    // rated us low, so the follow-up asks what went wrong. Still free text —
    // never a choice list. See features/guest-survey/gating.ts.
    expect(closing[1].kind).toBe("low_rating_followup");
    expect(closing[1].choices).toBeUndefined();
  });

  it("uses only valid kinds", () => {
    const validKinds = new Set<SurveyQuestionKind>([
      "rating_1_5",
      "multi",
      "text",
      "yes_no",
      "low_rating_followup",
    ]);
    for (const q of GUEST_SURVEY_QUESTIONS_SEED) {
      expect(validKinds.has(q.kind), `tag=${q.tag} ord=${q.ordinal}`).toBe(true);
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

  /**
   * Until 2026-06-14 this file asserted "only fnb_service gates". That stopped
   * being the spec when the racing survey shipped: food_drink became the
   * racing-side mirror of the fnb_service block and racing gained its own
   * branches. A tag allow-list was the wrong shape anyway — it snapshots WHICH
   * questions gate but never checks a gate is well-formed. These assert the
   * structural rules instead, which is what actually catches an authoring bug.
   */
  describe("gate structure (every tag)", () => {
    const gated = GUEST_SURVEY_QUESTIONS_SEED.filter(
      (q) => q.gateOrdinal !== undefined || q.gateAnswer !== undefined,
    );
    const at = (tag: string, ordinal: number) =>
      GUEST_SURVEY_QUESTIONS_SEED.find((q) => q.tag === tag && q.ordinal === ordinal)!;

    it("the seed still HAS gates — an edit that drops them all is a regression", () => {
      // Gating is what keeps a 30-question pool short for the guest; silently
      // losing it would show every branch to everyone.
      expect(gated.length).toBeGreaterThan(0);
    });

    it("sets gateOrdinal and gateAnswer together — never one without the other", () => {
      for (const q of gated) {
        expect(q.gateOrdinal, `${q.tag} ord=${q.ordinal}`).toBeDefined();
        expect(q.gateAnswer, `${q.tag} ord=${q.ordinal}`).toBeDefined();
      }
    });

    it("gates only on an EARLIER question in its OWN tag", () => {
      // A forward or cross-tag gate can never be satisfied: the picker emits
      // one tag block at a time, in ordinal order, so the answer wouldn't exist.
      for (const q of gated) {
        expect(q.gateOrdinal!, `${q.tag} ord=${q.ordinal}`).toBeLessThan(q.ordinal);
        expect(at(q.tag, q.gateOrdinal!), `${q.tag} ord=${q.ordinal}`).toBeDefined();
      }
    });

    it("gates only on a yes_no question, answered Yes or No", () => {
      for (const q of gated) {
        expect(at(q.tag, q.gateOrdinal!).kind, `${q.tag} ord=${q.ordinal}`).toBe("yes_no");
        expect(["Yes", "No"], `${q.tag} ord=${q.ordinal}`).toContain(q.gateAnswer);
      }
    });
  });

  it("food_drink mirrors fnb_service: Q2–Q5 gated on Q1='Yes', Q1 + Q6 ungated", () => {
    // Racing visits always get the food_drink block; its Q1 ("Did you purchase
    // any food or drinks?") self-gates the rest, so a guest who bought nothing
    // answers one question. Q6 is the manager check — everyone gets it.
    const fd = GUEST_SURVEY_QUESTIONS_SEED.filter((q) => q.tag === "food_drink");
    expect(fd.find((q) => q.ordinal === 1)!.kind).toBe("yes_no");
    for (const ord of [2, 3, 4, 5]) {
      const q = fd.find((x) => x.ordinal === ord)!;
      expect(q.gateOrdinal, `food_drink ord=${ord}`).toBe(1);
      expect(q.gateAnswer, `food_drink ord=${ord}`).toBe("Yes");
    }
    for (const ord of [1, 6]) {
      expect(fd.find((x) => x.ordinal === ord)!.gateOrdinal, `food_drink ord=${ord}`).toBeUndefined();
    }
    expect(fd.find((q) => q.ordinal === 6)!.question.toLowerCase()).toContain("manager");
  });

  it("racing branches: Q4 on Q3=Yes, Q5 on Q4=No, Q8 on Q7=No", () => {
    // Two independent chains: the kart slow-down ("did you slow down" → "did you
    // know why" → "would an explanation have helped") and the front-desk wait,
    // which only applies to walk-ins (Q7 "book in advance?" = No).
    const racing = GUEST_SURVEY_QUESTIONS_SEED.filter((q) => q.tag === "racing");
    const gate = (ord: number) => {
      const q = racing.find((x) => x.ordinal === ord)!;
      return [q.gateOrdinal, q.gateAnswer];
    };
    expect(gate(4)).toEqual([3, "Yes"]);
    expect(gate(5)).toEqual([4, "No"]);
    expect(gate(8)).toEqual([7, "No"]);
    for (const ord of [1, 2, 3, 6, 7]) {
      expect(racing.find((x) => x.ordinal === ord)!.gateOrdinal, `racing ord=${ord}`).toBeUndefined();
    }
  });

  it("bowling Q2 references 'bowling area' not 'bowling center' (per user edit)", () => {
    const q = GUEST_SURVEY_QUESTIONS_SEED.find((x) => x.tag === "bowling" && x.ordinal === 2)!;
    expect(q.question).toContain("bowling area");
    expect(q.question).not.toContain("bowling center");
  });
});
