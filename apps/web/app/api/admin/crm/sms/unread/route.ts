import { withCrmRoute } from "~/features/crm/core/http";
import { isDirector } from "~/features/crm/core/identity";
import { UnreadQuerySchema, unreadTotal } from "~/features/crm/sms";

/**
 * GET /api/admin/crm/sms/unread → `{ok, n}`
 *
 * The sidebar's Conversations badge (`core/nav.ts` badge key `unread`). Its own
 * endpoint rather than a field on the threads list because the shell polls it
 * on every screen and must not pay for a page of conversations to do it.
 *
 * A rep counts their own; `all=1` gives a director the team's.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(UnreadQuerySchema, async ({ input, user }) => {
  const teamWide = input.all === "1" && isDirector(user);
  const n = await unreadTotal(teamWide ? null : (user.rep?.id ?? null));
  return { n };
});
