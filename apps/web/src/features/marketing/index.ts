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
