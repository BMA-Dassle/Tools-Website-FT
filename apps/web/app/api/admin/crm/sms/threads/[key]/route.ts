import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { crmSmsEnabled } from "~/features/crm/core/flags";
import { listRoster } from "~/features/crm/reps";
import {
  ConversationKeySchema,
  ThreadDetailQuerySchema,
  ThreadPostSchema,
  UnknownConversationError,
  loadConversation,
  markConversationRead,
  sendCrmSms,
} from "~/features/crm/sms";

/**
 * /api/admin/crm/sms/threads/[key] — ONE PERSON's conversation.
 *
 * `key` is `c-<contactId>` or `p-<digits>` (`sms/keys.ts`), NOT a thread id: a
 * guest who has texted two reps is one conversation on screen and two rows in
 * `crm_sms_threads`, and the screen's URL names the person.
 *
 *   GET  ?cursor&limit → `{ok, summary, messages, nextCursor, myDid,
 *                          myThreadId, consent, contact, lead}`
 *        Messages oldest-first for display; the cursor pages BACKWARDS in time.
 *   POST {action:"send", body, templateId?, leadId?} → `{ok, key, result}`
 *        `{action:"read"}`                            → `{ok, key, unread}`
 *
 * A `send` that the consent rule refuses answers 200 with `result.ok:false`
 * and the refusal code — it is a decision, not a transport error, and the
 * composer turns it into the sentence the rep needs to read.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function keyFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.key) ? params.key[0] : params.key;
  const parsed = ConversationKeySchema.safeParse(raw ?? "");
  if (!parsed.success) throw new CrmHttpError(404, "conversation_not_found");
  return parsed.data;
}

export const GET = withCrmRoute(ThreadDetailQuerySchema, async ({ input, params, user }) => {
  const key = keyFrom(params);
  try {
    const detail = await loadConversation({
      key,
      rep: user.rep,
      reps: await listRoster(),
      smsEnabled: crmSmsEnabled(),
      limit: input.limit,
      cursor: input.cursor ?? null,
    });
    return { ...detail };
  } catch (err) {
    if (err instanceof UnknownConversationError) {
      throw new CrmHttpError(404, "conversation_not_found");
    }
    throw err;
  }
});

export const POST = withCrmRoute(ThreadPostSchema, async ({ input, params, user }) => {
  const key = keyFrom(params);
  if (input.action === "read") {
    try {
      const { unread } = await markConversationRead(key, user.rep);
      return { key, unread };
    } catch (err) {
      if (err instanceof UnknownConversationError) {
        throw new CrmHttpError(404, "conversation_not_found");
      }
      throw err;
    }
  }
  const result = await sendCrmSms(
    {
      key,
      body: input.body,
      templateId: input.templateId ?? null,
      leadId: input.leadId ?? null,
    },
    user,
  );
  return { key, result };
});
