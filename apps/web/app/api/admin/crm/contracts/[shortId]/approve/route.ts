import {
  ApproveBodySchema,
  approveContract,
  shortIdFrom,
  withContractAction,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * POST /api/admin/crm/contracts/[shortId]/approve — director only (D15: the
 * approvers are everyone with `sales-director`).
 *
 * The approver is `requireCrmUser().email`, taken from the SSO session. The
 * CRM never POSTs to `/api/group-function/approve`, whose only auth is a
 * body-supplied email against a two-address allowlist (R9); both routes call
 * the same `approveQuote`, so what approving DOES is one implementation.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(
  ApproveBodySchema,
  async ({ input, user, params }) => {
    const shortId = shortIdFrom(params);
    const result = await withContractAction(() =>
      approveContract({ shortId, actor: user.email, memo: input.memo ?? null }),
    );
    return { action: "approve" as const, shortId, message: result.message, row: result.row };
  },
  { director: true },
);
