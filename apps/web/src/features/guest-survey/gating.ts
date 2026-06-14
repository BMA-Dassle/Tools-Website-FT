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

// ─────────────────────────────────────────────────────────────────
// Adaptive closing prompt (low-rating follow-up)
// ─────────────────────────────────────────────────────────────────
//
// The `low_rating_followup` closing question is the catch-all free-text
// box. Its prompt is dynamic: if the guest scored any rating_1_5 question
// a 3 or below, we name those items and ask what we could have done
// better; otherwise it's the plain "Anything else?" box. Pure functions
// so the SurveyForm stays declarative and this stays unit-testable.

/** A score of 3 or below on a 1-5 rating is treated as "needs attention". */
export const LOW_RATING_THRESHOLD = 3;

/**
 * Turn a rating question into a short subject phrase by stripping the
 * lead-in ("How was your racing experience?" -> "your racing experience",
 * "Rate the food & drinks" -> "the food & drinks"). Falls back to the
 * trimmed question text if no known lead-in matches.
 */
export function ratingSubject(questionText: string): string {
  const stripped = questionText
    .trim()
    .replace(/\?+$/, "")
    .replace(/^how (?:was|were)\s+/i, "")
    .replace(/^rate\s+/i, "")
    .trim();
  return stripped || questionText.trim();
}

/**
 * Subjects of every rating_1_5 question the guest answered with a value
 * at or below LOW_RATING_THRESHOLD, in question order. Unanswered or
 * higher-scored ratings are excluded.
 */
export function lowRatedSubjects(
  allQuestions: GuestSurveyQuestion[],
  answers: AnswerMap,
): string[] {
  const out: string[] = [];
  for (const q of allQuestions) {
    if (q.kind !== "rating_1_5") continue;
    const v = answers[String(q.id)];
    if (typeof v === "number" && v <= LOW_RATING_THRESHOLD) {
      out.push(ratingSubject(q.question));
    }
  }
  return out;
}

/** Oxford-comma join: [a] -> "a", [a,b] -> "a and b", [a,b,c] -> "a, b, and c". */
function joinSubjects(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Prompt for the adaptive `low_rating_followup` question. With no low
 * scores it's the supplied fallback (the question's stored text, e.g.
 * "Anything else you'd like to share?"). With one or more low scores it
 * names them and asks what we could have done better.
 */
export function adaptiveClosingPrompt(subjects: string[], fallback: string): string {
  if (subjects.length === 0) return fallback;
  const list = joinSubjects(subjects);
  const noun = subjects.length > 1 ? "those" : "it";
  return `You rated ${list} a 3 or below. What could we have done to make ${noun} better? (Anything else you'd like to share is welcome too.)`;
}
