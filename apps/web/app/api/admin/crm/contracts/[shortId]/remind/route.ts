import {
  RemindBodySchema,
  fireReminder,
  shortIdFrom,
  withContractAction,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * POST /api/admin/crm/contracts/[shortId]/remind — director only.
 *
 * Fires ONE `group-event-rules` rule now, bypassing its once-only dedup gate,
 * exactly as `/api/admin/group-functions/reminders` does — and writing the same
 * `group_event_notifications` ledger row, so a hand-fired reminder shows up on
 * both boards instead of only this one. Director-gated because it sends a real
 * message to a guest outside the schedule.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(
  RemindBodySchema,
  async ({ input, user, params }) => {
    const shortId = shortIdFrom(params);
    const result = await withContractAction(() =>
      fireReminder({ shortId, actor: user.email, ruleKey: input.ruleKey }),
    );
    return { action: "remind" as const, shortId, message: result.message, row: result.row };
  },
  { director: true },
);
