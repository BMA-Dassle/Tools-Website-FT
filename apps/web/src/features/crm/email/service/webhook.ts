/**
 * What `/api/crm/graph-webhook` does with what Graph posts. The route is a
 * thin shell; the order of operations lives here because the order is the
 * security property.
 *
 *   1. **The handshake wins over everything.** Graph creates a subscription by
 *      calling the URL with `?validationToken=…` and waiting, synchronously,
 *      for that exact string back as `text/plain`. It happens BEFORE any
 *      `clientState` exists, so it cannot be authenticated and must not be.
 *      Answer it first, answer it fast, and answer nothing else.
 *   2. **`clientState` decides whether we look at a notification at all.**
 *      Graph echoes the secret we gave it at creation; we compare it against
 *      `crm_graph_subscriptions.client_state` FOR THAT SUBSCRIPTION ID. A
 *      notification with no `clientState`, an unknown `subscriptionId`, or a
 *      mismatch is DROPPED with a log line and never reaches `getMessage` —
 *      the route still answers 202, because arguing with a spoofer is how you
 *      tell them they found something. (The portal's own webhook skips this
 *      check; ours does not — brief §1.11 / portal T19.)
 *   3. **Process before responding.** Vercel kills the function the moment it
 *      responds, so a "fire and forget" fetch after `return` never runs. Graph
 *      allows 30 s; we fetch, match and store inside the request, and a
 *      failure enqueues `graph-fetch-message` rather than being lost.
 *
 * A duplicate notification (Graph retries) is harmless: the insert is
 * `ON CONFLICT (mailbox, graph_message_id) DO NOTHING`, so the second delivery
 * writes no row and records no activity.
 */

import { recordActivity } from "../../activities";
import { getLead, listLeads } from "../../leads";
import type { EmailMatchedBy } from "../contracts";
import {
  findLinkByInternetMessageId,
  findSubscriptionById,
  insertGraphLinkOnce,
  type EmailLink,
  type GraphSubscriptionRow,
} from "../data/email-links-db";
import { getMessage, type GraphMessage } from "./graph-client";
import {
  addressOf,
  addressesOf,
  counterpartyOf,
  directionOf,
  emailKeyOf,
  firstMessageId,
  headerValue,
  matchMessage,
  occurredAtOf,
  previewOf,
  IN_REPLY_TO_HEADER,
  type MatchDeps,
  type MatchedLead,
} from "./match";

export const EMAIL_ACTIVITY_EXTERNAL_KIND = "crm_email_link";

/** One entry of Graph's `{ value: [...] }` notification envelope. */
export interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string; "@odata.id"?: string };
  tenantId?: string;
}

export interface GraphNotificationBody {
  value?: GraphNotification[];
}

/** `Users/<oid>/Messages/<id>` or `/users/<upn>/messages/<id>` → the pieces. */
export function parseResource(resource: string | undefined): {
  mailbox: string | null;
  messageId: string | null;
} {
  if (!resource) return { mailbox: null, messageId: null };
  const m = /users\/([^/]+)\/(?:mailfolders\/[^/]+\/)?messages\/([^/?]+)/i.exec(resource);
  if (!m) return { mailbox: null, messageId: null };
  return { mailbox: decodeURIComponent(m[1]), messageId: decodeURIComponent(m[2]) };
}

export type NotificationOutcome =
  | { status: "dropped"; reason: "no_client_state" | "unknown_subscription" | "state_mismatch" }
  | { status: "ignored"; reason: "no_resource" | "no_match" | "duplicate" }
  | { status: "linked"; linkId: string; leadId: string | null; matchedBy: EmailMatchedBy }
  | { status: "failed"; error: string };

export interface WebhookDeps {
  findSubscription: (id: string) => Promise<GraphSubscriptionRow | null>;
  fetchMessage: (mailbox: string, messageId: string) => Promise<GraphMessage>;
  statesMatch: (expected: string, actual: string | null | undefined) => boolean;
  onFetchFailure?: (mailbox: string, messageId: string, error: string) => Promise<void>;
}

/**
 * The one place a notification is allowed through. Returns `dropped` WITHOUT
 * touching Graph when the state does not check out.
 */
export async function handleNotification(
  note: GraphNotification,
  deps: WebhookDeps,
): Promise<NotificationOutcome> {
  if (!note.clientState) {
    console.warn("[crm] graph webhook dropped", { reason: "no_client_state" });
    return { status: "dropped", reason: "no_client_state" };
  }
  const sub = note.subscriptionId ? await deps.findSubscription(note.subscriptionId) : null;
  if (!sub) {
    console.warn("[crm] graph webhook dropped", {
      reason: "unknown_subscription",
      subscription_id: note.subscriptionId ?? null,
    });
    return { status: "dropped", reason: "unknown_subscription" };
  }
  if (!deps.statesMatch(sub.clientState, note.clientState)) {
    console.warn("[crm] graph webhook dropped", {
      reason: "state_mismatch",
      subscription_id: note.subscriptionId ?? null,
      mailbox: sub.mailbox,
    });
    return { status: "dropped", reason: "state_mismatch" };
  }

  const fromResource = parseResource(note.resource);
  // THE SUBSCRIPTION ROW WINS ON THE MAILBOX. Graph's `resource` names the
  // mailbox by DIRECTORY OID (`Users/8ee44408-…/Messages/AAMk…`), not by SMTP
  // address. Taking it from there would store a GUID in `crm_email_links
  // .mailbox` and — far worse — make `directionOf` compare an email address
  // with a GUID, so every Sent Items copy would be filed as INBOUND and
  // matched against the rep's own address. `sub.mailbox` is the address WE
  // minted the subscription for; the resource is only ever used for the id.
  const mailbox = sub.mailbox || fromResource.mailbox;
  const messageId = fromResource.messageId ?? note.resourceData?.id ?? null;
  if (!mailbox || !messageId) return { status: "ignored", reason: "no_resource" };

  try {
    const msg = await deps.fetchMessage(mailbox, messageId);
    return await linkGraphMessage(mailbox, msg);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[crm] graph message fetch failed", { mailbox, message_id: messageId, error });
    await deps.onFetchFailure?.(mailbox, messageId, error);
    return { status: "failed", error };
  }
}

/** B3's readers, shaped for `matchMessage`. No stubs — these are the real ones. */
export const neonMatchDeps: MatchDeps = {
  leadsByGuestEmail: async (email) => {
    const page = await listLeads({ q: email, limit: 25 });
    return page.leads.map(toMatchedLead);
  },
  linkByInternetMessageId: async (imid) => {
    const link = await findLinkByInternetMessageId(imid);
    return link ? { leadId: link.leadId } : null;
  },
  leadByRef: async (ref) => {
    const lead = await getLead(ref);
    return lead ? toMatchedLead(lead) : null;
  },
};

/**
 * `LeadView` → the five fields the matcher reads. `statusKindOpen` is derived
 * from the CLOSED statuses rather than a join: the seeded terminal ids are
 * `lost` and `noresp`, everything else is still being worked.
 */
export const CLOSED_STATUS_IDS: readonly string[] = ["lost", "noresp"];

export function toMatchedLead(lead: {
  id: string;
  publicId: string;
  contactId: string | null;
  rep: string | null;
  status: string;
  archivedAt: string | null;
  guest: { email: string | null };
}): MatchedLead {
  return {
    id: lead.id,
    publicId: lead.publicId,
    contactId: lead.contactId,
    assignedRepId: lead.rep,
    guestEmail: lead.guest.email,
    statusKindOpen: !CLOSED_STATUS_IDS.includes(lead.status),
    archived: lead.archivedAt != null,
  };
}

/**
 * Store one fetched Graph message against its lead, once. Shared by the
 * webhook and the `graph-fetch-message` job, so a replay and a retry produce
 * exactly the same row.
 */
export async function linkGraphMessage(
  mailbox: string,
  msg: GraphMessage,
  matchDeps: MatchDeps = neonMatchDeps,
): Promise<NotificationOutcome> {
  const direction = directionOf(msg, mailbox);
  const { lead, matchedBy } = await matchMessage(msg, mailbox, matchDeps);
  const link = await insertGraphLinkOnce({
    mailbox: mailbox.toLowerCase(),
    graphMessageId: msg.id,
    conversationId: msg.conversationId ?? null,
    internetMessageId: msg.internetMessageId ?? null,
    inReplyTo: firstMessageId(headerValue(msg, IN_REPLY_TO_HEADER)),
    leadId: lead?.id ?? null,
    contactId: lead?.contactId ?? null,
    repId: lead?.assignedRepId ?? null,
    direction,
    subject: msg.subject ?? null,
    preview: previewOf(msg),
    fromEmail: addressOf(msg.from ?? msg.sender),
    toEmails: addressesOf(msg.toRecipients),
    ccEmails: addressesOf(msg.ccRecipients),
    sentAt: occurredAtOf(msg),
    matchedBy,
    webLink: msg.webLink ?? null,
  });
  if (!link) return { status: "ignored", reason: "duplicate" };
  if (!lead) {
    // Kept as an unmatched row on purpose: the director's "unknown senders"
    // view (C3's tray pattern) reads them, and a later contact edit can claim
    // it. Nothing is thrown away because we could not guess a lead.
    return { status: "ignored", reason: "no_match" };
  }
  await recordEmailActivity(link, lead, msg, mailbox);
  return { status: "linked", linkId: link.id, leadId: lead.id, matchedBy };
}

async function recordEmailActivity(
  link: EmailLink,
  lead: MatchedLead,
  msg: GraphMessage,
  mailbox: string,
): Promise<void> {
  try {
    await recordActivity({
      leadId: lead.id,
      contactId: lead.contactId,
      repId: lead.assignedRepId,
      actorEmail: null,
      kind: "email",
      direction: link.direction,
      occurredAt: link.sentAt ?? new Date(),
      outcome: "received",
      subject: link.subject,
      body: link.preview,
      externalKind: EMAIL_ACTIVITY_EXTERNAL_KIND,
      externalRef: link.id,
      meta: {
        provider: "graph",
        mailbox: emailKeyOf(mailbox),
        graph_message_id: link.graphMessageId,
        matched_by: link.matchedBy,
        counterparty: counterpartyOf(msg, mailbox),
        web_link: link.webLink,
      },
    });
  } catch (err) {
    console.error("[crm] inbound email activity failed", {
      lead_id: lead.id,
      link_id: link.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const defaultWebhookDeps: Omit<WebhookDeps, "statesMatch"> = {
  findSubscription: findSubscriptionById,
  fetchMessage: getMessage,
};
