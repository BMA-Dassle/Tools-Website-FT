import { withCrmRoute } from "~/features/crm/core/http";
import { EmailThreadsQuerySchema, emailThreads } from "~/features/crm/email";

/**
 * GET /api/admin/crm/email/threads — one row per lead with email, newest
 * first, keyset-paged (`limit ≤ 200`, R10).
 *
 * A rep sees the threads on their own mailbox; a director sees every one.
 * This is the list the Conversations screen's Email folder renders — C1 owns
 * that screen and mounts `conversations/email/EmailThread` into it at release.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(EmailThreadsQuerySchema, async ({ input, user }) => {
  const page = await emailThreads(user, { limit: input.limit, cursor: input.cursor });
  return { threads: page.threads, nextCursor: page.nextCursor };
});
