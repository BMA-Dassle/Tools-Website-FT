import { describe, expect, it } from "vitest";
import { aQuestion } from "~/test/builders/survey";
import {
  isQuestionVisible,
  visibleQuestions,
  ratingSubject,
  lowRatedSubjects,
  adaptiveClosingPrompt,
  isPositiveSentiment,
  type AnswerMap,
} from "./gating";

describe("isQuestionVisible", () => {
  const gate = aQuestion({
    id: 100,
    tag: "fnb_service",
    ordinal: 1,
    question: "Did you have a server at your lane?",
    kind: "yes_no",
  });
  const dependent = aQuestion({
    id: 200,
    tag: "fnb_service",
    ordinal: 2,
    question: "How quickly did your server check on you?",
    kind: "multi",
    gateOrdinal: 1,
    gateAnswer: "Yes",
  });
  const independent = aQuestion({
    id: 300,
    tag: "fnb_service",
    ordinal: 6,
    question: "Did a manager check on you?",
    kind: "yes_no",
  });

  const all = [gate, dependent, independent];

  it("shows an ungated question regardless of state", () => {
    expect(isQuestionVisible(independent, all, {})).toBe(true);
    expect(isQuestionVisible(independent, all, { "100": "No" })).toBe(true);
  });

  it("hides a gated question when the gate is unanswered", () => {
    expect(isQuestionVisible(dependent, all, {})).toBe(false);
  });

  it("hides a gated question when the gate answer doesn't match", () => {
    expect(isQuestionVisible(dependent, all, { "100": "No" })).toBe(false);
  });

  it("shows a gated question once the gate answer matches", () => {
    expect(isQuestionVisible(dependent, all, { "100": "Yes" })).toBe(true);
  });

  it("matches by string-equality across numeric / boolean answers", () => {
    // rating-style gate would never be string-compared but we tolerate it
    const numericGate = aQuestion({ id: 50, tag: "racing", ordinal: 1, kind: "rating_1_5" });
    const numericDep = aQuestion({
      id: 60,
      tag: "racing",
      ordinal: 2,
      gateOrdinal: 1,
      gateAnswer: "5",
    });
    const set = [numericGate, numericDep];
    expect(isQuestionVisible(numericDep, set, { "50": 5 })).toBe(true);
    expect(isQuestionVisible(numericDep, set, { "50": 4 })).toBe(false);
  });

  it("fail-closes when the referenced gate ordinal can't be found (misconfig)", () => {
    const orphan = aQuestion({
      id: 999,
      tag: "fnb_service",
      ordinal: 99,
      gateOrdinal: 88, // doesn't exist
      gateAnswer: "Yes",
    });
    expect(isQuestionVisible(orphan, all, {})).toBe(false);
  });

  it("scopes the gate lookup to the same tag", () => {
    // Even if a same-ordinal question exists in another tag, the gate should
    // not reference it.
    const bowlingQ1 = aQuestion({ id: 1, tag: "bowling", ordinal: 1, kind: "yes_no" });
    const fnbDep = aQuestion({
      id: 2,
      tag: "fnb_service",
      ordinal: 2,
      gateOrdinal: 1,
      gateAnswer: "Yes",
    });
    const set = [bowlingQ1, fnbDep];
    // bowling Q1 = Yes should NOT satisfy the fnb_service gate ord=1.
    expect(isQuestionVisible(fnbDep, set, { "1": "Yes" })).toBe(false);
  });
});

describe("visibleQuestions", () => {
  it("filters in stable input order", () => {
    const q1 = aQuestion({ id: 1, tag: "fnb_service", ordinal: 1, kind: "yes_no" });
    const q2 = aQuestion({
      id: 2,
      tag: "fnb_service",
      ordinal: 2,
      gateOrdinal: 1,
      gateAnswer: "Yes",
    });
    const q3 = aQuestion({ id: 3, tag: "fnb_service", ordinal: 6, kind: "yes_no" });
    const list = [q1, q2, q3];
    const answers: AnswerMap = { "1": "No" };
    expect(visibleQuestions(list, answers)).toEqual([q1, q3]);
  });
});

describe("ratingSubject", () => {
  it("strips 'How was' lead-in and trailing question mark", () => {
    expect(ratingSubject("How was your racing experience?")).toBe("your racing experience");
  });
  it("strips 'How were' lead-in", () => {
    expect(ratingSubject("How were our karting team members (track crew)?")).toBe(
      "our karting team members (track crew)",
    );
  });
  it("strips 'Rate' lead-in", () => {
    expect(ratingSubject("Rate the food & drinks")).toBe("the food & drinks");
  });
  it("falls back to the trimmed text when no lead-in matches", () => {
    expect(ratingSubject("Overall vibe")).toBe("Overall vibe");
  });
});

describe("lowRatedSubjects", () => {
  const race = aQuestion({
    id: 1,
    tag: "racing",
    ordinal: 1,
    question: "How was your racing experience?",
    kind: "rating_1_5",
  });
  const crew = aQuestion({
    id: 2,
    tag: "racing",
    ordinal: 2,
    question: "How were our karting team members (track crew)?",
    kind: "rating_1_5",
  });
  const food = aQuestion({
    id: 3,
    tag: "food_drink",
    ordinal: 2,
    question: "Rate the food & drinks",
    kind: "rating_1_5",
  });
  const yesno = aQuestion({
    id: 4,
    tag: "racing",
    ordinal: 3,
    question: "Did you experience a slow-down?",
    kind: "yes_no",
  });
  const all = [race, crew, food, yesno];

  it("returns nothing when all ratings are 4+", () => {
    expect(lowRatedSubjects(all, { "1": 5, "2": 4, "3": 5 })).toEqual([]);
  });
  it("includes only ratings at or below 3, in question order", () => {
    expect(lowRatedSubjects(all, { "1": 3, "2": 5, "3": 2 })).toEqual([
      "your racing experience",
      "the food & drinks",
    ]);
  });
  it("ignores unanswered ratings and non-rating kinds", () => {
    expect(lowRatedSubjects(all, { "2": 1, "4": "Yes" })).toEqual([
      "our karting team members (track crew)",
    ]);
  });
  it("treats exactly 3 as low", () => {
    expect(lowRatedSubjects([race], { "1": 3 })).toEqual(["your racing experience"]);
  });
});

describe("adaptiveClosingPrompt", () => {
  const fallback = "Anything else you'd like to share?";
  it("returns the fallback when there are no low scores", () => {
    expect(adaptiveClosingPrompt([], fallback)).toBe(fallback);
  });
  it("uses singular 'it' for one low score and names it", () => {
    const p = adaptiveClosingPrompt(["your racing experience"], fallback);
    expect(p).toContain("your racing experience");
    expect(p).toContain("make it better");
    expect(p).toContain("3 or below");
  });
  it("uses 'those' and an oxford-comma list for multiple low scores", () => {
    const p = adaptiveClosingPrompt(
      ["your racing experience", "the food & drinks", "our track crew"],
      fallback,
    );
    expect(p).toContain("your racing experience, the food & drinks, and our track crew");
    expect(p).toContain("make those better");
  });
});

describe("isPositiveSentiment", () => {
  // Mirrors the real seed: baseline #1 = overall rating, baseline #2 = recommend.
  const overall = aQuestion({
    id: 10,
    tag: "baseline",
    ordinal: 1,
    question: "How was your visit overall?",
    kind: "rating_1_5",
  });
  const recommend = aQuestion({
    id: 11,
    tag: "baseline",
    ordinal: 2,
    question: "Would you recommend us to a friend?",
    kind: "yes_no",
  });
  const food = aQuestion({
    id: 12,
    tag: "food_drink",
    ordinal: 2,
    question: "Rate the food & drinks",
    kind: "rating_1_5",
  });
  const managerCheck = aQuestion({
    id: 13,
    tag: "food_drink",
    ordinal: 6,
    question: "Did a manager check on you during your visit?",
    kind: "yes_no",
  });
  const all = [overall, recommend, food, managerCheck];

  it("passes a straight-5s survey with an explicit recommendation", () => {
    expect(isPositiveSentiment(all, { "10": 5, "11": "Yes", "12": 5, "13": "Yes" })).toBe(true);
  });

  it("passes a 4 overall with the recommend question left blank", () => {
    expect(isPositiveSentiment(all, { "10": 4, "12": 4 })).toBe(true);
  });

  it("fails when any other rating is low, even with a 5 overall", () => {
    // The guest who loved the visit but rated the food a 2 — don't send them
    // to a public review form.
    expect(isPositiveSentiment(all, { "10": 5, "11": "Yes", "12": 2 })).toBe(false);
  });

  it("treats exactly 3 on another rating as low", () => {
    expect(isPositiveSentiment(all, { "10": 5, "12": 3 })).toBe(false);
  });

  it("fails a middling overall rating", () => {
    expect(isPositiveSentiment(all, { "10": 3, "12": 5 })).toBe(false);
  });

  it("fails an explicit 'No' on the recommend question", () => {
    expect(isPositiveSentiment(all, { "10": 5, "11": "No", "12": 5 })).toBe(false);
  });

  it("fail-closes when the overall rating is unanswered", () => {
    expect(isPositiveSentiment(all, { "11": "Yes", "12": 5, "13": "Yes" })).toBe(false);
  });

  it("fail-closes when the overall question isn't in the set at all", () => {
    expect(isPositiveSentiment([recommend, food], { "11": "Yes", "12": 5 })).toBe(false);
  });

  it("fail-closes on an empty answer map", () => {
    expect(isPositiveSentiment(all, {})).toBe(false);
  });

  it("ignores a same-ordinal question in another tag when locating baseline #1", () => {
    // bowling #1 is also ordinal 1 — it must not stand in for the overall rating.
    const bowling = aQuestion({ id: 20, tag: "bowling", ordinal: 1, kind: "rating_1_5" });
    expect(isPositiveSentiment([bowling, recommend], { "20": 5, "11": "Yes" })).toBe(false);
  });

  it("does not treat a non-numeric overall answer as a passing rating", () => {
    expect(isPositiveSentiment(all, { "10": "5", "12": 5 } as AnswerMap)).toBe(false);
  });
});
