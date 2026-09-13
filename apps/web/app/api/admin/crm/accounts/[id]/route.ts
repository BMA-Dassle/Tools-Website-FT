import { AccountQuerySchema, accountDetail } from "~/features/crm/bmi";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";

/**
 * GET /api/admin/crm/accounts/[id]?limit=&cursor= (wire contract)
 *   → `{ok, account, contacts, events, eventsNextCursor}`
 *
 * One business or household across every year: the account roll-up, its
 * contacts, and its mirrored events newest first (keyset by event date).
 * An unknown id is our own JSON 404 envelope — a real not-found, which
 * `crmFetch` reports rather than treating as an expired credential.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(AccountQuerySchema, async ({ input, params }) => {
  const id = typeof params.id === "string" ? params.id : "";
  if (!/^\d{1,18}$/.test(id)) throw new CrmHttpError(404, "account_not_found");
  const detail = await accountDetail(id, { limit: input.limit, cursor: input.cursor ?? null });
  if (!detail) throw new CrmHttpError(404, "account_not_found");
  return detail;
});
