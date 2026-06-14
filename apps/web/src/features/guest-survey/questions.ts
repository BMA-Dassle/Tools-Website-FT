import {
  getActiveQuestionsForTags,
  type GuestSurveyQuestion,
  type SurveyOrigin,
  type SurveyQuestionTag,
} from "@/lib/guest-survey-db";

/**
 * Tag selection + question picker.
 *
 * Tag policy (locked with user 2026-05-20, amended for `closing`; racing
 * food wiring landed 2026-06-14):
 *   - baseline is always included.
 *   - closing  is always included (rendered LAST regardless of pick order).
 *   - For bowling visits → [baseline, bowling, fnb_service, closing] (4 tags).
 *   - For racing visits  → [baseline, racing, food_drink, closing] (4 tags).
 *       food_drink is ALWAYS included for racing: its Q1 ("Did you purchase
 *       food or drinks?") self-gates the rest of the food + service block,
 *       so a racer who bought nothing only sees that one yes/no + the
 *       independent manager-check. This is more robust than deriving the
 *       tag from same-day Square purchases (which misses cash / combined
 *       orders). arcade / gel_blaster cross-sells are deferred — adding
 *       them means raising MAX_TAGS_PER_SURVEY past 4.
 *   - Max 4 tags per survey (was 3 before closing was added).
 *   - No question-count cap; gating in the UI keeps the survey adaptive.
 *
 * food_drink is NOT applied to bowling surveys — fnb_service is the
 * dedicated lane-service tag for bowlers; food_drink would duplicate the
 * F&B question surface.
 *
 * Render order: pickQuestions() sorts by TAG_PRIORITY (not alphabetical),
 * so closing always renders at the bottom of the survey form.
 */

const BOWLING_TAGS: SurveyQuestionTag[] = ["baseline", "bowling", "fnb_service", "closing"];

/**
 * Racing tag set. food_drink is always present and self-gates on its own
 * Q1 ("Did you purchase food or drinks?"). baseline first, closing last
 * (closing sorts last via TAG_PRIORITY regardless of position here).
 */
const RACING_TAGS: SurveyQuestionTag[] = ["baseline", "racing", "food_drink", "closing"];

export const MAX_TAGS_PER_SURVEY = 4;

/**
 * Explicit render order for question tags. Lower = earlier in the survey.
 * `closing` deliberately uses a large value so it renders last — bypasses
 * the alphabetical sort that would otherwise put it among the cross-sells.
 */
const TAG_PRIORITY: Record<SurveyQuestionTag, number> = {
  baseline: 1,
  bowling: 2,
  fnb_service: 3,
  food_drink: 4,
  arcade: 5,
  gel_blaster: 6,
  racing: 7,
  closing: 99,
};

export interface PickTagsInput {
  origin: SurveyOrigin;
}

/**
 * Select the final tag set for a survey, applying the locked policy.
 * Returns at most MAX_TAGS_PER_SURVEY tags. baseline first, closing last.
 */
export function pickTags(input: PickTagsInput): SurveyQuestionTag[] {
  if (input.origin === "bowling") {
    return [...BOWLING_TAGS];
  }
  // origin === "racing" — fixed set; food_drink self-gates (see above).
  return [...RACING_TAGS];
}

/**
 * Fetch active questions for a set of tags, ordered by TAG_PRIORITY then
 * ordinal so the survey renders in the curated order (closing always last).
 */
export async function pickQuestions(tags: SurveyQuestionTag[]): Promise<GuestSurveyQuestion[]> {
  if (tags.length === 0) return [];
  const rows = await getActiveQuestionsForTags(tags);
  return rows.slice().sort((a, b) => {
    const pa = TAG_PRIORITY[a.tag] ?? 50;
    const pb = TAG_PRIORITY[b.tag] ?? 50;
    if (pa !== pb) return pa - pb;
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return a.id - b.id;
  });
}
