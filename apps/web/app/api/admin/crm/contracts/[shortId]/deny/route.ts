import {
  DenyBodySchema,
  denyContract,
  shortIdFrom,
  withContractAction,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * POST /api/admin/crm/contracts/[shortId]/deny — director only.
 * `{reason}` is required and is what the planner receives, so it is not
 * optional and not defaulted.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(
  DenyBodySchema,
  async ({ input, user, params }) => {
    const shortId = shortIdFrom(params);
    const result = await withContractAction(() =>
      denyContract({ shortId, actor: user.email, reason: input.reason }),
    );
    return { action: "deny" as const, shortId, message: result.message, row: result.row };
  },
  { director: true },
);
