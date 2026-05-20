import {
  getActiveQuestionsForTags,
  type GuestSurveyQuestion,
  type SurveyOrigin,
  type SurveyQuestionTag,
} from "@/lib/guest-survey-db";

/**
 * Tag selection + question picker.
 *
 * Tag policy (locked with user 2026-05-20):
 *   - baseline is always included.
 *   - For bowling visits → [baseline, bowling, fnb_service] (always 3 tags).
 *   - For racing visits  → [baseline, racing] + ≤1 cross-sell tag (food_drink /
 *                          arcade / gel_blaster) derived from same-day Square
 *                          purchases — racing wiring lands in PR-GS4.
 *   - Max 3 tags per survey.
 *   - No question-count cap; gating in the UI keeps the survey adaptive.
 *
 * Cross-sell tags (food_drink / arcade / gel_blaster) are NOT applied to
 * bowling surveys per the policy — fnb_service is the dedicated lane-service
 * tag for bowlers; food_drink would duplicate the F&B question surface.
 */

const BOWLING_TAGS: SurveyQuestionTag[] = ["baseline", "bowling", "fnb_service"];

/**
 * Cross-sell tags that can be added to racing visits.
 * Priority order: highest first. The picker will keep at most ONE.
 */
const RACING_CROSS_SELL_PRIORITY: SurveyQuestionTag[] = ["food_drink", "arcade", "gel_blaster"];

export const MAX_TAGS_PER_SURVEY = 3;

export interface PickTagsInput {
  origin: SurveyOrigin;
  /**
   * Tags inferred from the customer's same-day Square purchases.
   * For PR-GS2 (bowling-only) this is always empty. Racing surveys
   * (PR-GS4) will populate this from same-day order line items.
   */
  purchaseTags?: SurveyQuestionTag[];
}

/**
 * Select the final tag set for a survey, applying the locked policy.
 * Returns at most MAX_TAGS_PER_SURVEY tags, baseline always first.
 */
export function pickTags(input: PickTagsInput): SurveyQuestionTag[] {
  if (input.origin === "bowling") {
    return [...BOWLING_TAGS];
  }

  // origin === "racing"
  const tags: SurveyQuestionTag[] = ["baseline", "racing"];
  const remainingSlots = MAX_TAGS_PER_SURVEY - tags.length;
  if (remainingSlots <= 0) return tags;

  // Pick the highest-priority cross-sell tag the customer actually purchased.
  const purchased = new Set(input.purchaseTags ?? []);
  for (const candidate of RACING_CROSS_SELL_PRIORITY) {
    if (purchased.has(candidate)) {
      tags.push(candidate);
      if (tags.length >= MAX_TAGS_PER_SURVEY) break;
    }
  }
  return tags;
}

/**
 * Fetch the actual question rows for a set of tags from the DB.
 * Returns them in stable order: tag (alphabetical) → ordinal → id.
 */
export async function pickQuestions(tags: SurveyQuestionTag[]): Promise<GuestSurveyQuestion[]> {
  if (tags.length === 0) return [];
  return getActiveQuestionsForTags(tags);
}
