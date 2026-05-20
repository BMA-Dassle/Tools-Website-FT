import {
  getMarketingConsent,
  upsertMarketingConsent,
  type MarketingConsentRow,
} from "@/lib/marketing-db";

/**
 * Marketing consent registry.
 *
 * Default-deny: a phone with no row is treated as "not opted in" for marketing.
 * Transactional SMS (booking confirmations, lane-ready) is governed elsewhere
 * and is NOT gated by this registry.
 *
 * STOP replies on inbound SMS webhook should call `recordOptOut`. Re-opt-in
 * via START or admin tool calls `recordOptIn`.
 */

export type MarketingConsentSource =
  | "booking_confirmation"
  | "survey_completion"
  | "admin"
  | "inbound_sms_start"
  | "inbound_sms_stop"
  | "email_unsubscribe";

export async function hasMarketingOptIn(phoneE164: string): Promise<boolean> {
  const row = await getMarketingConsent(phoneE164);
  return row?.optedIn === true;
}

export async function recordOptIn(opts: {
  phoneE164: string;
  source: MarketingConsentSource;
}): Promise<void> {
  await upsertMarketingConsent({
    phoneE164: opts.phoneE164,
    optedIn: true,
    source: opts.source,
  });
}

export async function recordOptOut(opts: {
  phoneE164: string;
  source: MarketingConsentSource;
  reason?: string;
}): Promise<void> {
  await upsertMarketingConsent({
    phoneE164: opts.phoneE164,
    optedIn: false,
    source: opts.source,
    reason: opts.reason ?? null,
  });
}

export async function getConsent(phoneE164: string): Promise<MarketingConsentRow | null> {
  return getMarketingConsent(phoneE164);
}
