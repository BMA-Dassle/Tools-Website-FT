/**
 * `share-link-expire` — the one job kind C6 owns in `jobs/registry.ts`
 * (brief §3.5, §3.9).
 *
 * What it does: stamp `expired_at` on every `crm_share_links` row whose
 * `expires_at` has passed. The public route ALREADY refuses an out-of-date
 * link by comparing `expires_at` to now (`isShareExpired`), so this job is not
 * what makes a link stop working — it is what makes the STATE VISIBLE: the
 * rep's sheet can show "expired" without every reader re-deriving it, and a
 * revoke and a timeout end up in the same column.
 *
 * It is therefore safe to never run (previews have no crons at all, brief
 * §1.7) and safe to run twice: the UPDATE only touches rows where `expired_at
 * IS NULL`, so a second pass in the same minute reports 0.
 *
 * Its idempotency key is exported for the cron's `enqueueScheduled` step —
 * whichever release stage wires the scheduled kinds in adds one line naming
 * it, exactly as §5.7b describes for B2's sweep. Until then a director runs it
 * from the Statuses screen's Run job control.
 */

import type { JobHandler } from "~/features/crm/jobs";
import { todayEasternYmd } from "../../core/dates";
import { expireShareLinks } from "./share";

/** One run per ET calendar day; nothing here is time-of-day sensitive. */
export function shareLinkExpireIdempotencyKey(now: Date = new Date()): string {
  return `share-link-expire:${todayEasternYmd(now)}`;
}

export const shareLinkExpireHandler: JobHandler = async ({ now }) => {
  const expired = await expireShareLinks(now);
  return { ok: true, result: { expired, ranAt: now.toISOString() } };
};
