/**
 * Guest Survey feature — public surface.
 *
 * Imports the shared marketing primitives from ~/features/marketing/* —
 * never re-implements them.
 */

export { enqueueBowlingSurvey } from "./service";
export { pickTags, pickQuestions, MAX_TAGS_PER_SURVEY } from "./questions";
export { isQuestionVisible, visibleQuestions, type AnswerValue, type AnswerMap } from "./gating";
export type {
  EnqueueBowlingSurveyInput,
  EnqueueOutcome,
  SkipReason,
  SurveyOrigin,
  SurveyRewardKind,
  SurveyQuestionKind,
  SurveyQuestionTag,
  GuestSurveyQuestion,
  GuestSurveyRow,
  GuestSurveyPromoCode,
} from "./types";
