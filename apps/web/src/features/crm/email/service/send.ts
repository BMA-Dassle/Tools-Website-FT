/**
 * Send an email as the rep, and leave a record either way.
 *
 * ORDER, AND IT IS NOT NEGOTIABLE (R2 — the Pizza Bowl lesson): the
 * `crm_email_links` row lands in Neon BEFORE any transport call, carrying the
 * subject, the body we composed, the recipients, the actor and our own
 * Message-ID, with `graph_message_id = NULL` and `send_status = 'pending'`.
 * If Graph, SendGrid, the network or the function itself dies after that, the
 * message a rep typed is still recoverable and the deal shows a red chip.
 *
 * THE TRANSPORT IS THE DRAFT FLOW, NEVER `sendMail` (brief §1.11): `sendMail`
 * answers 202 with no body, so there is no id to store and the Sent Items copy
 * can never be reconciled.
 *
 *   POST /users/{mailbox}/messages   + `Prefer: IdType="ImmutableId"`
 *                                    + internetMessageHeaders X-HP-Lead
 *        → the id that SURVIVES the move to Sent Items   → store it
 *   POST /users/{mailbox}/messages/{id}/send  → 202
 *
 * THE FALLBACK, which is what a preview does today: when `graphConfigured()`
 * is false (the `CRM_GRAPH_*` values are not on Vercel yet), when the
 * `CRM_EMAIL` kill switch is the string "false", or when Graph answers with
 * something we cannot fix from here, the message goes out through
 * `lib/sendgrid.ts` with `from` AND `replyTo` set to the rep, the row records
 * `provider = 'sendgrid'` with `graph_message_id` left NULL, and the UI shows
 * `SENDGRID_FALLBACK_CHIP`. The two Graph failures that fall back:
 *   - `transient` (5xx / 429 / a network error) — brief's rule, verbatim;
 *   - `403 ErrorAccessDenied` — the Exchange ApplicationAccessPolicy does not
 *     cover this mailbox yet. That is the same "Outlook sync not connected
 *     yet" situation the chip describes, for one mailbox instead of all of
 *     them, and the guest's mail still needs to go out. It is recorded in
 *     `graph_error` so the director can see WHICH mailbox needs adding.
 * Anything else from Graph (a 400 we built wrong) marks the row `failed` and
 * surfaces — a bug of ours must not hide behind a fallback.
 *
 * ONLY THE DRAFT CREATE IS FALLBACK-ELIGIBLE, and the split is the whole point
 * of having two try blocks. Once `POST /messages` has answered 201, a message
 * EXISTS in the rep's mailbox. If the following `/send` then 429s, 503s, or
 * simply takes longer than the 20 s `AbortSignal.timeout` while Graph quietly
 * queues it, falling through to SendGrid would deliver the guest a SECOND copy
 * of the same email and leave an orphan draft in Outlook for ever. So a
 * `sendDraft` failure NEVER touches SendGrid: the row stays `pending` with the
 * Graph error, and an `email-send-retry` job re-reads the message first
 * (`getMessage`, `Prefer: IdType="ImmutableId"`) and re-issues `/send` only
 * while it is still a draft — R5's "never trust a 200, re-read" applied to
 * Graph. A pending row shows "Sending…" on the deal, not a false success.
 *
 * AFTERWARDS, once and only on a send that actually left: the `crm_activities`
 * row (`kind='email'`, keyed `(crm_email_link, <link id>)` so a retry cannot
 * double it), then `recordFirstTouch` through B3's `noteOutboundTouch`, then
 * `assigned → contacted` exactly as the prototype does (crm-shared.js:275).
 */

import { randomBytes } from "node:crypto";
import { sendEmail as sendGridEmail, type SendEmailResult } from "@/lib/sendgrid";
import { recordActivity } from "../../activities";
import { crmEmailEnabled } from "../../core/flags";
import type { CrmUser } from "../../core/types";
import { getLead, noteOutboundTouch, updateLeadFields, type LeadView } from "../../leads";
import {
  EMAIL_SEND_RETRY_KIND,
  emailSendRetryIdempotencyKey,
  shortErrorClause,
  type EmailMessageView,
  type EmailSenderView,
} from "../contracts";
import {
  insertOutboundLink,
  markLinkFailed,
  markLinkPending,
  markLinkSent,
  setLinkGraphMessageId,
  type EmailLink,
} from "../data/email-links-db";
import { CRM_EMAIL_OFF_REASON, applyReadiness, crmMessageId, resolveSender } from "./compose";
import {
  GraphError,
  X_HP_LEAD_HEADER,
  createDraft,
  graphSendReadiness,
  sendDraft,
  type GraphReadiness,
} from "./graph-client";
import { toMessageView } from "./view";

export const EMAIL_ACTIVITY_EXTERNAL_KIND = "crm_email_link";

/** `assigned` is the only status an outbound touch advances (crm-shared.js:275). */
export const STATUS_ON_FIRST_TOUCH = { from: "assigned", to: "contacted" } as const;

export class NoRecipientError extends Error {
  constructor() {
    super("no_recipient");
    this.name = "NoRecipientError";
  }
}

export interface SendCrmEmailInput {
  lead: LeadView;
  user: CrmUser;
  subject: string;
  body: string;
  /** Defaults to the lead's guest email. */
  to?: string[];
  /** Added to the sender's own CC list (the Guest Services rule). */
  cc?: string[];
  templateId?: string | null;
}

export interface SendCrmEmailResult {
  message: EmailMessageView;
  sender: EmailSenderView;
  fellBack: boolean;
  /** The leading clause only — the full text stays on the row (C2-9). */
  graphError: string | null;
  firstTouchRecorded: boolean;
  /** True when Graph took the draft but `/send` failed and a job owns it now. */
  sendPending: boolean;
}

export interface SendDeps {
  createDraft: typeof createDraft;
  sendDraft: typeof sendDraft;
  sendGrid: (opts: Parameters<typeof sendGridEmail>[0]) => Promise<SendEmailResult>;
  readiness: () => Promise<GraphReadiness>;
  emailEnabled: typeof crmEmailEnabled;
  randomToken: () => string;
  now: () => Date;
  /** Hand an accepted-but-unsent draft to `crm_jobs`. */
  enqueueRetry: (input: {
    linkId: string;
    mailbox: string;
    messageId: string;
    error: string;
  }) => Promise<void>;
}

/**
 * Imported lazily: `jobs/registry.ts` reaches back into this sub, so a static
 * `~/features/crm/jobs` import here would close a module cycle at load time.
 */
export async function enqueueSendRetry(input: {
  linkId: string;
  mailbox: string;
  messageId: string;
  error: string;
}): Promise<void> {
  const { neonJobStore } = await import("~/features/crm/jobs");
  await neonJobStore.enqueue({
    kind: EMAIL_SEND_RETRY_KIND,
    idempotencyKey: emailSendRetryIdempotencyKey(input.linkId),
    payload: {
      linkId: input.linkId,
      mailbox: input.mailbox,
      messageId: input.messageId,
      error: input.error,
    },
    createdBy: "crm-email",
  });
}

export const defaultSendDeps: SendDeps = {
  createDraft,
  sendDraft,
  sendGrid: sendGridEmail,
  readiness: () => graphSendReadiness(),
  emailEnabled: crmEmailEnabled,
  randomToken: () => randomBytes(8).toString("hex"),
  now: () => new Date(),
  enqueueRetry: enqueueSendRetry,
};

/** Graph failures that mean "use the other rail", not "we built the request wrong". */
export function shouldFallBack(err: unknown): boolean {
  if (!(err instanceof GraphError)) return false;
  if (err.transient) return true;
  return err.status === 403 && err.code === "ErrorAccessDenied";
}

/** Plain text → the minimal HTML part SendGrid needs, newlines preserved. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<div style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px">${escaped}</div>`;
}

function dedupeAddresses(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const a = raw.trim();
      const key = a.toLowerCase();
      if (!a || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

export async function sendCrmEmail(
  input: SendCrmEmailInput,
  deps: SendDeps = defaultSendDeps,
): Promise<SendCrmEmailResult> {
  const sender = applyReadiness(resolveSender(input.user), await deps.readiness());
  const to = dedupeAddresses(input.to, input.lead.guest.email ? [input.lead.guest.email] : []);
  if (to.length === 0) throw new NoRecipientError();
  const cc = dedupeAddresses(sender.cc, input.cc).filter(
    (a) => !to.some((t) => t.toLowerCase() === a.toLowerCase()),
  );
  const internetMessageId = crmMessageId(input.lead.publicId, deps.randomToken());

  // ── 1. Neon first, always (R2).
  let link: EmailLink = await insertOutboundLink({
    mailbox: sender.mailbox,
    leadId: input.lead.id,
    contactId: input.lead.contactId,
    repId: sender.repId,
    subject: input.subject,
    body: input.body,
    toEmails: to,
    ccEmails: cc,
    actorEmail: input.user.email,
    templateId: input.templateId ?? null,
    internetMessageId,
    inReplyTo: null,
  });

  // ── 2. Graph, unless the kill switch, the missing env, or a permission the
  //       tenant has not consented to says otherwise. Checking readiness up
  //       front means we do not spend a doomed round trip on every send while
  //       `Mail.ReadWrite` is outstanding.
  let graphError: string | null = null;
  let fellBack = false;
  if (!sender.graph) {
    fellBack = true;
    graphError = deps.emailEnabled() ? sender.graphReason : CRM_EMAIL_OFF_REASON;
  } else {
    // ── 2a. The draft. NOTHING has been handed to Exchange yet, so this is the
    //        only failure the other rail may answer.
    let draftId: string | null = null;
    try {
      const draft = await deps.createDraft(sender.mailbox, {
        subject: input.subject,
        text: input.body,
        to: to.map((address) => ({ address })),
        cc: cc.map((address) => ({ address })),
        internetMessageId,
        headers: { [X_HP_LEAD_HEADER]: input.lead.publicId },
      });
      draftId = draft.id;
      await setLinkGraphMessageId(link.id, draft.id, draft.conversationId ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      graphError = message;
      if (!shouldFallBack(err)) {
        const failed = await markLinkFailed(link.id, message, { graphError: message });
        if (failed) link = failed;
        await afterSend(input, link, sender, { sent: false });
        throw err;
      }
      fellBack = true;
    }

    // ── 2b. The send. A message NOW EXISTS in the rep's mailbox, so a failure
    //        here must never produce a second copy through SendGrid: park the
    //        row `pending` and let `email-send-retry` re-read before retrying.
    if (draftId) {
      try {
        await deps.sendDraft(sender.mailbox, draftId);
        const sent = await markLinkSent(link.id, "graph", { sentAt: deps.now() });
        if (sent) link = sent;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        graphError = message;
        console.error("[crm] graph send failed after the draft was accepted", {
          lead_id: input.lead.id,
          link_id: link.id,
          mailbox: sender.mailbox,
          graph_message_id: draftId,
          actor_email: input.user.email,
          error: message,
        });
        const pending = await markLinkPending(link.id, message);
        if (pending) link = pending;
        try {
          await deps.enqueueRetry({
            linkId: link.id,
            mailbox: sender.mailbox,
            messageId: draftId,
            error: message,
          });
        } catch (enqueueErr) {
          console.error("[crm] email send retry could not be enqueued", {
            link_id: link.id,
            error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
          });
        }
        await afterSend(input, link, sender, { sent: false });
        return {
          message: toMessageView(link),
          sender,
          fellBack: false,
          graphError: shortErrorClause(message),
          firstTouchRecorded: false,
          sendPending: true,
        };
      }
    }
  }

  // ── 3. The fallback rail: from AND replyTo are the rep, never noreply@.
  if (fellBack) {
    const res = await deps.sendGrid({
      to: to[0],
      cc: [...to.slice(1), ...cc],
      from: { email: sender.mailbox, name: sender.displayName },
      replyTo: sender.mailbox,
      replyToName: sender.displayName,
      subject: input.subject,
      text: input.body,
      html: textToHtml(input.body),
      categories: ["crm-email"],
    });
    if (!res.ok) {
      const message = res.error || `SendGrid ${res.status ?? "error"}`;
      const failed = await markLinkFailed(link.id, message, { graphError });
      if (failed) link = failed;
      await afterSend(input, link, sender, { sent: false });
      throw new Error(message);
    }
    const sent = await markLinkSent(link.id, "sendgrid", { graphError, sentAt: deps.now() });
    if (sent) link = sent;
  }

  const firstTouchRecorded = await afterSend(input, link, sender, { sent: true });
  return {
    message: toMessageView(link),
    sender,
    fellBack,
    graphError: shortErrorClause(graphError),
    firstTouchRecorded,
    sendPending: false,
  };
}

/**
 * The diary entries. Never throws — the message has already left (or already
 * failed); a bookkeeping error must not turn a delivered email into a 500.
 */
async function afterSend(
  input: SendCrmEmailInput,
  link: EmailLink,
  sender: EmailSenderView,
  opts: { sent: boolean },
): Promise<boolean> {
  try {
    await recordActivity({
      leadId: input.lead.id,
      contactId: input.lead.contactId,
      repId: sender.repId,
      actorEmail: input.user.email,
      kind: "email",
      direction: "out",
      occurredAt: link.sentAt ?? new Date(),
      outcome: opts.sent ? "sent" : "failed",
      subject: input.subject,
      body: input.body.slice(0, 2000),
      externalKind: EMAIL_ACTIVITY_EXTERNAL_KIND,
      externalRef: link.id,
      meta: {
        provider: link.provider,
        mailbox: sender.mailbox,
        graph_message_id: link.graphMessageId,
        cc: link.ccEmails,
        send_error: link.sendError,
      },
    });
    if (!opts.sent) return false;

    const touch = await noteOutboundTouch(
      { kind: "email", direction: "out", repId: sender.repId, occurredAt: link.sentAt },
      { id: input.lead.id, rep: input.lead.rep },
    );
    if (touch.recorded && input.lead.status === STATUS_ON_FIRST_TOUCH.from) {
      await updateLeadFields(input.lead.id, { statusId: STATUS_ON_FIRST_TOUCH.to });
    }
    return touch.recorded;
  } catch (err) {
    console.error("[crm] email bookkeeping failed", {
      lead_id: input.lead.id,
      link_id: link.id,
      actor_email: input.user.email,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Re-read a lead after a send so the caller answers with fresh status/touch. */
export function reloadLead(publicId: string): Promise<LeadView | null> {
  return getLead(publicId);
}
