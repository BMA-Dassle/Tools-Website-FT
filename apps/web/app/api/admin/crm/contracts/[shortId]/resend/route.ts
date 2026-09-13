import {
  ResendBodySchema,
  resendContract,
  shortIdFrom,
  withContractAction,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * POST /api/admin/crm/contracts/[shortId]/resend
 *
 * Any signed-in salesperson may resend their own guest's contract — the
 * prototype's Resend button is not director-gated, and a rep who cannot resend
 * a link the guest lost has to ask someone else to do their job.
 *
 * Same link, same version, the rail the automatic send uses. Logged on the
 * contract audit ledger, on the deal timeline and in the BMI private notes.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(ResendBodySchema, async ({ input, user, params }) => {
  const shortId = shortIdFrom(params);
  const result = await withContractAction(() =>
    resendContract({ shortId, actor: user.email, note: input.note ?? null }),
  );
  return { action: "resend" as const, shortId, message: result.message, row: result.row };
});
