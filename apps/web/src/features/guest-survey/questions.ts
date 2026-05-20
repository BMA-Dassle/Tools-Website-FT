import {
  getActiveQuestionsForTags,
  type GuestSurveyQuestion,
  type SurveyOrigin,
  type SurveyQuestionTag,
} from "@/lib/guest-survey-db";

/**
 * Tag selection + question picker.
 *
 * Tag policy (locked with user 2026-05-20, amended for `closing`):
 *   - baseline is always included.
 *   - closing  is always included (rendered LAST regardless of pick order).
 *   - For bowling visits → [baseline, bowling, fnb_service, closing] (4 tags).
 *   - For racing visits  → [baseline, racing, closing] + ≤1 cross-sell tag
 *                          (food_drink / arcade / gel_blaster) derived from
 *                          same-day Square purchases — wiring lands in PR-GS4.
 *   - Max 4 tags per survey (was 3 before closing was added).
 *   - No question-count cap; gating in the UI keeps the survey adaptive.
 *
 * Cross-sell tags (food_drink / arcade / gel_blaster) are NOT applied to
 * bowling surveys — fnb_service is the dedicated lane-service tag for
 * bowlers; food_drink would duplicate the F&B question surface.
 *
 * Render order: pickQuestions() sorts by TAG_PRIORITY (not alphabetical),
 * so closing always renders at the bottom of the survey form.
 */

const BOWLING_TAGS: SurveyQuestionTag[] = ["baseline", "bowling", "fnb_service", "closing"];

/** Cross-sell tags that can be added to racing visits. Highest priority first. */
const RACING_CROSS_SELL_PRIORITY: SurveyQuestionTag[] = ["food_drink", "arcade", "gel_blaster"];

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
  /**
   * Tags inferred from the customer's same-day Square purchases.
   * For PR-GS2 (bowling-only) this is always empty. Racing surveys
   * (PR-GS4) will populate this from same-day order line items.
   */
  purchaseTags?: SurveyQuestionTag[];
}

/**
 * Select the final tag set for a survey, applying the locked policy.
 * Returns at most MAX_TAGS_PER_SURVEY tags. baseline first, closing last.
 */
export function pickTags(input: PickTagsInput): SurveyQuestionTag[] {
  if (input.origin === "bowling") {
    return [...BOWLING_TAGS];
  }

  // origin === "racing" — baseline + racing + (optional cross-sell) + closing
  const tags: SurveyQuestionTag[] = ["baseline", "racing"];

  // Cross-sell slot: take MAX - already-used - 1 (one slot reserved for closing)
  const reservedForClosing = 1;
  const crossSellSlots = MAX_TAGS_PER_SURVEY - tags.length - reservedForClosing;
  if (crossSellSlots > 0) {
    const purchased = new Set(input.purchaseTags ?? []);
    let added = 0;
    for (const candidate of RACING_CROSS_SELL_PRIORITY) {
      if (added >= crossSellSlots) break;
      if (purchased.has(candidate)) {
        tags.push(candidate);
        added += 1;
      }
    }
  }

  tags.push("closing");
  return tags;
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
