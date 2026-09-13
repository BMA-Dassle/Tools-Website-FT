import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  EmailContextQuerySchema,
  EmailSendSchema,
  NoRecipientError,
  NoSenderMailboxError,
  applyReadiness,
  emailTemplatesFor,
  graphSendReadiness,
  leadEmails,
  resolveSender,
  sendCrmEmail,
} from "~/features/crm/email";
import { getLead } from "~/features/crm/leads";

/**
 * GET  /api/admin/crm/email?leadId=L-1042 → the composer's context (sender,
 *      recipients, email templates merged for this lead) plus the lead's
 *      messages, newest first, keyset-paged.
 * POST /api/admin/crm/email → send. The `crm_email_links` row is written
 *      BEFORE any transport call (R2); the transport is Graph's draft flow,
 *      never `sendMail`; SendGrid is the fallback (see `email/service/send.ts`).
 *
 * Both refuse politely when the signed-in person has no mailbox to send from
 * (a director with no `crm_reps` row, the Marketing Director hold row) rather
 * than inventing a from-address — a guest reply has to land somewhere a human
 * reads.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function senderOr403(user: Parameters<typeof resolveSender>[0]) {
  try {
    return resolveSender(user);
  } catch (err) {
    if (err instanceof NoSenderMailboxError) throw new CrmHttpError(403, err.message);
    throw err;
  }
}

export const GET = withCrmRoute(EmailContextQuerySchema, async ({ input, user }) => {
  const lead = await getLead(input.leadId);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");
  const sender = senderOr403(user);
  const [templates, page, readiness] = await Promise.all([
    emailTemplatesFor({ lead, repFirstName: user.rep?.firstName ?? user.name.split(/\s+/)[0] }),
    leadEmails(lead.id, { limit: input.limit, cursor: input.cursor }),
    graphSendReadiness(),
  ]);
  return {
    // The composer must not promise "through Microsoft Graph" and then fall
    // back: this is where the tenant's actual consent decides what it says.
    sender: applyReadiness(sender, readiness),
    to: lead.guest.email ? [lead.guest.email] : [],
    templates,
    messages: page.messages,
    nextCursor: page.nextCursor,
  };
});

export const POST = withCrmRoute(EmailSendSchema, async ({ input, user }) => {
  const lead = await getLead(input.leadId);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");
  senderOr403(user);
  try {
    const result = await sendCrmEmail({
      lead,
      user,
      subject: input.subject,
      body: input.body,
      to: input.to,
      cc: input.cc,
      templateId: input.templateId ?? null,
    });
    await writeAudit({
      entity: "lead",
      entityId: lead.id,
      action: "email",
      actorEmail: user.email,
      after: {
        link_id: result.message.id,
        mailbox: result.sender.mailbox,
        provider: result.message.provider,
        graph_message_id: result.message.graphMessageId,
        to: result.message.toEmails,
        cc: result.message.ccEmails,
        fell_back: result.fellBack,
        send_pending: result.sendPending,
      },
    });
    return {
      message: result.message,
      fellBack: result.fellBack,
      graphError: result.graphError,
      firstTouchRecorded: result.firstTouchRecorded,
      sendPending: result.sendPending,
    };
  } catch (err) {
    if (err instanceof NoRecipientError) throw new CrmHttpError(400, "no_recipient");
    throw err;
  }
});
