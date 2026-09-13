import {
  ChargeBalanceBodySchema,
  chargeBalance,
  shortIdFrom,
  withContractAction,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * POST /api/admin/crm/contracts/[shortId]/charge-balance — director only.
 *
 * Charges the card on file NOW instead of at T-72h, through the SAME
 * `chargeBalanceForQuote` the cron runs (`lib/group-balance-charge.ts`). The
 * atomic claim inside it is what stops this and the cron from both taking the
 * money (#H2884): a lost claim comes back as `skipped`, which the toast says
 * plainly rather than dressing up as success.
 *
 * No card on file → 409 `no_card_on_file`; use "Send balance link" instead.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withCrmRoute(
  ChargeBalanceBodySchema,
  async ({ input, user, params }) => {
    const shortId = shortIdFrom(params);
    const result = await withContractAction(() =>
      chargeBalance({ shortId, actor: user.email, reason: input.reason ?? null, mode: "auto" }),
    );
    return {
      action: "charge-balance" as const,
      shortId,
      message: result.message,
      outcome: result.outcome,
      row: result.row,
    };
  },
  { director: true },
);
