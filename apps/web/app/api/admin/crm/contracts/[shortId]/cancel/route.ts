import {
  CancelBodySchema,
  cancelEvent,
  shortIdFrom,
  withContractAction,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * POST /api/admin/crm/contracts/[shortId]/cancel — director only. Money moves.
 *
 * Flips the BMI project to Cancellation (`-4`) and then PROVES it by re-reading
 * the project three times, 1.2 s apart. `setProjectState` sends built-in
 * negative ids through Pandora and returns on Pandora's 200 with no re-read at
 * all (`lib/bmi-office-actions.ts:537-546`), and Pandora's 200 has lied before
 * — so the response tells the caller which happened:
 *
 *   `verified: true`  — Office says `-4`. The "cancelled" audit row is written
 *                       and `/api/cron/group-quote-sync` takes over the money
 *                       (drain the gift cards, then refund).
 *   `verified: false` — NO audit row, a `contract-cancel-verify` job is
 *                       enqueued and the deal reads "Cancel pending" until
 *                       Office agrees. A cancellation nobody can see in Office
 *                       is not a cancellation.
 *
 * Refunds are never issued from here: the sync cron owns that, and it acts on
 * what Office reports rather than on what we asked for.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withCrmRoute(
  CancelBodySchema,
  async ({ input, user, params }) => {
    const shortId = shortIdFrom(params);
    const result = await withContractAction(() =>
      cancelEvent({
        shortId,
        actor: user.email,
        reason: input.reason,
        note: input.note ?? null,
      }),
    );
    return {
      action: "cancel" as const,
      shortId,
      message: result.message,
      verified: result.verified,
      observedStateId: result.observedStateId,
      jobEnqueued: result.jobEnqueued,
      row: result.row,
    };
  },
  { director: true },
);
