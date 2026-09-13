import {
  EmptyBodySchema,
  backfillDayofOrder,
  shortIdFrom,
  withContractAction,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * POST /api/admin/crm/contracts/[shortId]/backfill-dayof — director only.
 *
 * Creates the Square day-of order that the deposit flow failed to create
 * (the prototype's "Create now" beside an empty Day-of order row).
 * Delegates to `createDayofOrder`, the single source of truth for building
 * one — this route is the second CALLER, never a second copy: the admin
 * backfill route already learned what a second copy costs (a tax/service-charge
 * misclassification that had to be fixed twice).
 *
 * Already has one → 200 with `created:false`, not an error.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withCrmRoute(
  EmptyBodySchema,
  async ({ user, params }) => {
    const shortId = shortIdFrom(params);
    const result = await withContractAction(() =>
      backfillDayofOrder({ shortId, actor: user.email }),
    );
    return {
      action: "backfill-dayof" as const,
      shortId,
      message: result.message,
      created: result.created,
      dayofOrderId: result.dayofOrderId,
      row: result.row,
    };
  },
  { director: true },
);
