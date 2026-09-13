import {
  ChargeBalanceBodySchema,
  chargeBalance,
  shortIdFrom,
  withContractAction,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * POST /api/admin/crm/contracts/[shortId]/send-balance-link
 *
 * The guest would rather pay by link than have the card on file charged. Runs
 * `chargeBalanceForQuote` in `mode:"link"`, which skips Path A entirely and
 * sends our own pay page — so this is NOT recorded as a decline, and no card
 * is touched.
 *
 * Not director-gated: it takes no money, it asks for it. It still passes
 * through the same claim, so it cannot race the cron's charge.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withCrmRoute(ChargeBalanceBodySchema, async ({ input, user, params }) => {
  const shortId = shortIdFrom(params);
  const result = await withContractAction(() =>
    chargeBalance({ shortId, actor: user.email, reason: input.reason ?? null, mode: "link" }),
  );
  return {
    action: "send-balance-link" as const,
    shortId,
    message: result.message,
    outcome: result.outcome,
    row: result.row,
  };
});
