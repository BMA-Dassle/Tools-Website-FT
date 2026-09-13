import { withCrmRoute } from "~/features/crm/core/http";
import { isDirector } from "~/features/crm/core/identity";
import { crmSmsEnabled } from "~/features/crm/core/flags";
import { listRoster } from "~/features/crm/reps";
import {
  NewTextSchema,
  ThreadsListQuerySchema,
  contactKey,
  conversationScopeFor,
  getThread,
  loadConversations,
  phoneKey,
  sendCrmSms,
} from "~/features/crm/sms";

/**
 * /api/admin/crm/sms/threads (wire contract: `sms/types.ts`)
 *   GET  ?cursor&limit&folder=all|unread|texts|email&all=1
 *        → `{ok, conversations, nextCursor, unread, myDid}`
 *        ONE ENTRY PER PERSON (the owner's shape), keyset on the thread's
 *        `last_message_at`, limit ≤ 200 (R10). A rep sees their own threads;
 *        `all=1` is honoured for a director only.
 *   POST {to, body, leadId?, templateId?} → `{ok, key, result}`
 *        Start a conversation with a number that has no thread yet — the deal's
 *        Text button and the phone's "new message". The send itself is
 *        `sms/service/send.ts`: Neon row first, then Vox, from the rep's own
 *        DID or not at all.
 *
 * `folder=email` returns nothing today and says so by returning an empty list:
 * the Email tab is C2's, and an empty tab is honest where a fabricated one is
 * not.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(ThreadsListQuerySchema, async ({ input, user }) => {
  const reps = await listRoster();
  const teamWide = input.all === "1" && isDirector(user);
  // A signed-in sales user with no `crm_reps` row scopes to NOTHING, not to the
  // whole team: `identity.ts` degrades `rep` to null on a Neon hiccup, and that
  // must not hand an ordinary rep everyone's conversations.
  const page = await loadConversations({
    scope: conversationScopeFor(user.rep, teamWide),
    reps,
    limit: input.limit,
    cursor: input.cursor ?? null,
    unreadOnly: input.folder === "unread",
  });
  const conversations = input.folder === "email" ? [] : page.conversations;
  return {
    conversations,
    nextCursor: input.folder === "email" ? null : page.nextCursor,
    unread: page.unread,
    myDid: user.rep?.voxDid ?? null,
    smsEnabled: crmSmsEnabled(),
  };
});

export const POST = withCrmRoute(NewTextSchema, async ({ input, user }) => {
  const result = await sendCrmSms(
    {
      to: input.to,
      body: input.body,
      leadId: input.leadId ?? null,
      templateId: input.templateId ?? null,
    },
    user,
  );
  // The key the caller should navigate to, whether or not the send went out —
  // a refused text still belongs to a conversation the rep can open.
  const key = result.message ? await keyForThread(result.threadId) : phoneKey(input.to);
  return { key, result };
});

/** The conversation key for a thread we just wrote to. */
async function keyForThread(threadId: string | null): Promise<string> {
  if (!threadId) return "";
  const thread = await getThread(threadId);
  if (!thread) return "";
  return thread.contactId ? contactKey(thread.contactId) : phoneKey(thread.guestE164);
}
