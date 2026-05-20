import {
  recordMarketingTouch,
  getLastSentTouch,
  type MarketingTouchEvent,
  type MarketingTouchRow,
} from "@/lib/marketing-db";

/**
 * Marketing touches: write-side helpers + the cross-campaign lookup used
 * by `frequency.canSend`.
 *
 * One row per touch event (sent / opened / clicked / converted / opted_out /
 * skipped). The frequency-cap query reads only `sent` rows; analytics can
 * read whatever it needs.
 */

export type { MarketingTouchEvent, MarketingTouchRow };

export interface RecordTouchInput {
  customerId: string;
  phoneE164: string;
  campaign: string;
  event: MarketingTouchEvent;
  channel?: string;
  refId?: string | null;
  meta?: Record<string, unknown>;
}

export async function recordTouch(input: RecordTouchInput): Promise<MarketingTouchRow> {
  return recordMarketingTouch(input);
}

export async function lastSentAt(opts: {
  customerId: string;
  campaign: string;
}): Promise<Date | null> {
  const row = await getLastSentTouch(opts);
  if (!row) return null;
  return new Date(row.occurredAt);
}
