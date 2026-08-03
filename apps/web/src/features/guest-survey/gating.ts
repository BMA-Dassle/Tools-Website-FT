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

/**
 * Narrow a stored `responses_json` blob (typed `Record<string, unknown>`) to an
 * AnswerMap, for server-side consumers that need to re-derive UI state from a
 * completed survey row.
 *
 * Drops any value that isn't a scalar rather than casting blindly: the submit
 * endpoint accepts a permissive body, so an array or object could be in there,
 * and one would otherwise stringify to "[object Object]" inside a comparison
 * and quietly skew the result.
 */
export function toAnswerMap(stored: Record<string, unknown> | null | undefined): AnswerMap {
  if (!stored) return {};
  const out: AnswerMap = {};
  for (const [key, value] of Object.entries(stored)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
}

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

// ─────────────────────────────────────────────────────────────────
// Positive-sentiment gate (Google review ask)
// ─────────────────────────────────────────────────────────────────
//
// We only ask a guest for a public Google review when their own answers say
// the visit went well. This is the ONE definition of "happy guest" — the
// survey UI uses it to decide whether to render the CTA, and the redirect
// route re-runs it server-side against the stored responses so a hand-crafted
// URL can't bypass it. Keep it pure and keep it here: nothing else in the
// codebase should grow a second, drifting notion of a good visit.

/** A rating must be at least this high to count as positive. */
export const POSITIVE_RATING_MIN = 4;

/**
 * Locators for the two universal baseline questions the gate depends on.
 *
 * Addressed by (tag, ordinal) rather than question text — same approach
 * `isQuestionVisible` uses for gates. Question copy gets edited in the seed
 * (GUEST_SURVEY_QUESTIONS_SEED); tag+ordinal is the stable identity, so a
 * wording tweak can't silently disable the gate.
 */
export const OVERALL_QUESTION = { tag: "baseline", ordinal: 1 } as const;
export const RECOMMEND_QUESTION = { tag: "baseline", ordinal: 2 } as const;

function findQuestion(
  allQuestions: GuestSurveyQuestion[],
  locator: { tag: string; ordinal: number },
): GuestSurveyQuestion | undefined {
  return allQuestions.find((q) => q.tag === locator.tag && q.ordinal === locator.ordinal);
}

/**
 * True when the guest's answers indicate a genuinely good visit.
 *
 * All three must hold:
 *   1. The overall visit rating (baseline #1) is answered and >= 4.
 *   2. NO rating_1_5 answer anywhere is <= LOW_RATING_THRESHOLD (3). Catches
 *      the guest who loved bowling but rated the food a 2 — we don't want to
 *      point them at a public review form.
 *   3. "Would you recommend us to a friend?" (baseline #2) is not "No".
 *      Unanswered passes; an explicit No does not.
 *
 * Fail-closed: an unanswered or absent overall question returns false, so a
 * misconfigured survey asks nobody rather than asking everybody.
 */
export function isPositiveSentiment(
  allQuestions: GuestSurveyQuestion[],
  answers: AnswerMap,
): boolean {
  // 1. Overall rating present and strong.
  const overall = findQuestion(allQuestions, OVERALL_QUESTION);
  if (!overall) return false;
  const overallValue = answers[String(overall.id)];
  if (typeof overallValue !== "number" || overallValue < POSITIVE_RATING_MIN) return false;

  // 2. Nothing rated at or below the low-rating threshold.
  if (lowRatedSubjects(allQuestions, answers).length > 0) return false;

  // 3. Not an explicit "No" on the recommend question.
  const recommend = findQuestion(allQuestions, RECOMMEND_QUESTION);
  if (recommend) {
    const recommendValue = answers[String(recommend.id)];
    if (recommendValue != null && String(recommendValue).toLowerCase() === "no") return false;
  }

  return true;
}
