import { z } from "zod";
import { withCrmRoute } from "~/features/crm/core/http";
import { publicUser } from "~/features/crm/core/projections";

/**
 * GET /api/admin/crm/me → `{ok:true, user: PublicCrmUser}` (wire contract).
 *
 * The chain is `withCrmRoute` (brief §3.4): credential → session → sales role.
 * The body is the same projection `AdminToolPage` renders with, so the client
 * can refresh its idea of "who am I" without a page load.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(z.object({}), async ({ user }) => ({ user: publicUser(user) }));
