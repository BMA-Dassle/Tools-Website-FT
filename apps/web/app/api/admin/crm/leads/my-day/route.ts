import { withCrmRoute } from "~/features/crm/core/http";
import { EmptySchema, loadMyDay } from "~/features/crm/leads";

/**
 * GET /api/admin/crm/leads/my-day → `{ok, view: RepMyDay | DirectorMyDay}`
 *
 * The role decides the shape: a rep gets their three columns (overdue · due
 * today · new), a director the team tiles and one lane per selling rep.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(EmptySchema, async ({ user }) => ({ view: await loadMyDay(user) }));
