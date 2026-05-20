import type { GuestSurveyQuestion } from "@/lib/guest-survey-db";

/**
 * Pure gating logic used by the survey UI.
 *
 * A question is "visible" iff:
 *   - It is ungated (gateOrdinal == null), OR
 *   - The question at (same tag, gateOrdinal) has an answer matching gateAnswer.
 *
 * Extracted as a pure function so we can unit-test without a DOM.
 */

export type AnswerValue = string | number | boolean | null;
export type AnswerMap = Record<string, AnswerValue>;

export function isQuestionVisible(
  question: GuestSurveyQuestion,
  allQuestions: GuestSurveyQuestion[],
  answers: AnswerMap,
): boolean {
  if (question.gateOrdinal == null) return true;
  const gate = allQuestions.find(
    (q) => q.tag === question.tag && q.ordinal === question.gateOrdinal,
  );
  // Fail-closed when the gate question isn't in the set: a survey rendered
  // without its gate is misconfigured, and hiding the dependent question
  // degrades gracefully rather than asking a follow-up out of context.
  if (!gate) return false;
  const gateValue = answers[String(gate.id)];
  if (gateValue == null) return false;
  return String(gateValue) === String(question.gateAnswer);
}

/** Return the questions in stable order that should currently be rendered. */
export function visibleQuestions(
  allQuestions: GuestSurveyQuestion[],
  answers: AnswerMap,
): GuestSurveyQuestion[] {
  return allQuestions.filter((q) => isQuestionVisible(q, allQuestions, answers));
}
