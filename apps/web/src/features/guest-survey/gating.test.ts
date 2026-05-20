import { describe, expect, it } from "vitest";
import { aQuestion } from "~/test/builders/survey";
import { isQuestionVisible, visibleQuestions, type AnswerMap } from "./gating";

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
