import {
  creditLoyaltyPoints,
  ensureLoyaltyEnrollment,
  mintDigitalGiftCard,
} from "@/lib/square-gift-card";
import { insertGuestSurveyPromoCode } from "@/lib/guest-survey-db";
import { ensureUniquePromoCode } from "~/features/guest-survey/reward";

/**
 * Marketing reward issuance — strategy router.
 *
 * Campaigns (guest survey today, birthday/abandoned-cart/win-back later)
 * call into `issueReward` rather than wiring up Square Loyalty / Gift
 * Cards themselves. New reward kinds plug in here without touching the
 * campaign code.
 *
 * Locked-in v1 strategies (2026-05-20):
 *   - "pinz"      → ensure Loyalty enrollment + creditLoyaltyPoints
 *   - "gift_card" → mintDigitalGiftCard + GS-XXXX promo code link
 *
 * Caller is responsible for catching errors and rolling back any
 * upstream state (the guest_surveys row, the marketing_touches row).
 * `issueReward` itself does NOT delete anything on failure — it
 * throws so the caller can decide.
 */

export type RewardKind = "pinz" | "gift_card";

/** Default reward values (locked with user 2026-05-20). */
export const PINZ_AWARD_POINTS = 500;
export const GIFT_CARD_AWARD_CENTS = 500;

export interface IssueRewardInput {
  /** Square customer id — assumed already resolved via resolveAudienceMember. */
  customerId: string;
  /** E.164 phone — needed for Loyalty enrollment mapping. */
  phoneE164: string;
  /** Square location id (= QAMF center code for HP). For Pinz this isn't used,
   *  but it's part of the input shape for symmetry. */
  locationId: string;
  /** Which reward to issue. */
  kind: RewardKind;
  /** Idempotency seed. Reused as prefix for every Square mutation. */
  baseKey: string;
  /** Survey row id (for gift_card path, links the promo code → survey). */
  surveyId?: string;
  /** Free-text reason shown in the Square dashboard. */
  reason?: string;
}

export type IssueRewardResult =
  | {
      kind: "pinz";
      ref: string; // Square Loyalty event id
      value: number; // points credited
      displayText: string; // for SMS body / Square customer note
      meta: {
        accountId: string;
        newBalance: number;
      };
    }
  | {
      kind: "gift_card";
      ref: string; // GS-XXXX promo code
      value: number; // cents loaded
      displayText: string;
      meta: {
        giftCardId: string;
        gan: string;
        promoCode: string;
      };
    };

export async function issueReward(input: IssueRewardInput): Promise<IssueRewardResult> {
  if (input.kind === "pinz") {
    return issuePinzReward(input);
  }
  if (input.kind === "gift_card") {
    return issueGiftCardReward(input);
  }
  // Exhaustiveness guard — keep TypeScript narrowing strict if a new
  // RewardKind is added without a handler here.
  const exhaustive: never = input.kind;
  throw new Error(`Unhandled reward kind: ${exhaustive as string}`);
}

async function issuePinzReward(input: IssueRewardInput): Promise<IssueRewardResult> {
  const account = await ensureLoyaltyEnrollment({
    customerId: input.customerId,
    phoneE164: input.phoneE164,
    baseKey: input.baseKey,
  });
  const result = await creditLoyaltyPoints({
    accountId: account.accountId,
    points: PINZ_AWARD_POINTS,
    reason: input.reason ?? "Guest Survey Reward",
    baseKey: input.baseKey,
  });
  return {
    kind: "pinz",
    ref: result.eventId,
    value: PINZ_AWARD_POINTS,
    displayText: `${PINZ_AWARD_POINTS} Pinz added (new balance: ${result.newBalance})`,
    meta: {
      accountId: account.accountId,
      newBalance: result.newBalance,
    },
  };
}

async function issueGiftCardReward(input: IssueRewardInput): Promise<IssueRewardResult> {
  if (!input.surveyId) {
    throw new Error("issueGiftCardReward: surveyId is required to link the GS-XXXX promo code");
  }

  // 1. Generate the promo code first — cheap, no Square mutation.
  const promoCode = await ensureUniquePromoCode();

  // 2. Mint the Square Gift Card. If this fails, no DB rows were
  //    written so no cleanup needed.
  const card = await mintDigitalGiftCard({
    locationId: input.locationId,
    amountCents: GIFT_CARD_AWARD_CENTS,
    baseKey: input.baseKey,
  });

  // 3. Link the promo code → gift card → survey row. If this fails,
  //    the Square gift card is orphaned (still valid, but no
  //    server-side trace). Acceptable since the GAN is still in our
  //    Square dashboard.
  await insertGuestSurveyPromoCode({
    code: promoCode,
    surveyId: input.surveyId,
    squareGiftCardId: card.giftCardId,
    squareGiftCardGan: card.gan,
    amountCents: GIFT_CARD_AWARD_CENTS,
  });

  return {
    kind: "gift_card",
    ref: promoCode,
    value: GIFT_CARD_AWARD_CENTS,
    displayText: `$${(GIFT_CARD_AWARD_CENTS / 100).toFixed(2)} e-gift card ${promoCode}`,
    meta: {
      giftCardId: card.giftCardId,
      gan: card.gan,
      promoCode,
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// SMS body templates for the reward confirmation step
// ─────────────────────────────────────────────────────────────────

/**
 * "Your reward is on its way" SMS — sent immediately after the customer
 * picks Pinz on the survey page.
 *
 * GSM-7 safe; no emoji, no smart quotes.
 */
export function renderPinzAwardSms(opts: {
  points: number;
  newBalance: number;
  brand: "HeadPinz" | "FastTrax";
}): string {
  return (
    `${opts.brand}: ${opts.points} Pinz added to your account. ` +
    `New balance: ${opts.newBalance} Pinz. Thanks for the feedback!`
  );
}

/**
 * "Your $5 e-gift card" SMS — sent immediately after the customer picks
 * gift card on the survey page. Approved Draft A (2026-05-20):
 *
 *   Your $5 e-gift card from HeadPinz!
 *   Show this at checkout:
 *   Card 1234-5678-9012-3456
 *   Code GS-7F2A
 *   Thanks for the feedback!
 *
 * No expiration line — per user's "no expiration" decision.
 */
export function renderGiftCardAwardSms(opts: {
  gan: string;
  promoCode: string;
  brand: "HeadPinz" | "FastTrax";
}): string {
  return (
    `Your $5 e-gift card from ${opts.brand}!\n` +
    `Show this at checkout:\n` +
    `Card ${opts.gan}\n` +
    `Code ${opts.promoCode}\n` +
    `Thanks for the feedback!`
  );
}
