import { lastSentAt } from "./touches";

/**
 * Per-campaign frequency cap.
 *
 * `canSend({ customerId, campaign, windowDays })` returns `{ allowed: true }`
 * if the customer has not received a `sent` touch for this campaign within
 * `windowDays`, else `{ allowed: false, lastSentAt }`.
 *
 * Boundary rule: the window is OPEN at the start — exactly `windowDays`
 * since the last send IS allowed (`now - lastSent >= windowDays * 24h`).
 *
 * Time source is injectable so tests can pin "now" without faking the clock.
 */

export interface CanSendResult {
  allowed: boolean;
  lastSentAt: Date | null;
  /** Reason code when blocked — useful for ops logging. */
  reason?: "within_window";
}

export interface CanSendOpts {
  customerId: string;
  campaign: string;
  windowDays: number;
  /** Defaults to `new Date()`. Pass a fixed value in tests. */
  now?: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function canSend(opts: CanSendOpts): Promise<CanSendResult> {
  const last = await lastSentAt({ customerId: opts.customerId, campaign: opts.campaign });
  if (!last) return { allowed: true, lastSentAt: null };

  const now = opts.now ?? new Date();
  const elapsedMs = now.getTime() - last.getTime();
  const windowMs = opts.windowDays * MS_PER_DAY;

  if (elapsedMs >= windowMs) return { allowed: true, lastSentAt: last };
  return { allowed: false, lastSentAt: last, reason: "within_window" };
}
