/**
 * Marketing primitives — shared across all campaigns (guest survey,
 * future birthday SMS, abandoned-cart, etc.).
 *
 * Campaign-specific code lives in ~/features/<campaign>/ and *consumes*
 * these primitives; never reimplements them.
 */

export {
  resolveAudienceMember,
  normalizePhoneE164,
  splitGuestName,
  type AudienceMember,
  type ResolveAudienceMemberInput,
} from "./audience";

export { canSend, type CanSendOpts, type CanSendResult } from "./frequency";

export {
  recordTouch,
  lastSentAt,
  type RecordTouchInput,
  type MarketingTouchEvent,
  type MarketingTouchRow,
} from "./touches";

export {
  hasMarketingOptIn,
  recordOptIn,
  recordOptOut,
  getConsent,
  type MarketingConsentSource,
} from "./consent";

export {
  assertGsm7Safe,
  renderBowlingSurveyInvite,
  TEMPLATE_KEYS,
  type BowlingSurveyInviteVars,
  type TemplateKey,
} from "./templates";

export {
  issueReward,
  renderPinzAwardSms,
  renderGiftCardAwardSms,
  PINZ_AWARD_POINTS,
  GIFT_CARD_AWARD_CENTS,
  type RewardKind,
  type IssueRewardInput,
  type IssueRewardResult,
} from "./rewards";
