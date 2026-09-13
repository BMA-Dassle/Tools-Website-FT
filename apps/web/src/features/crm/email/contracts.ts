/**
 * The email sub's WIRE SHAPES — what `/api/admin/crm/email**` answers and the
 * composer / thread render. Same rule as `leads/contracts.ts`: CLIENT-SAFE
 * (type-only imports, no Node, no Neon), ids are strings.
 */

import type { ApiOk } from "../core/contracts";
import type { Direction } from "../core/types";

/** 'graph' = sent from the rep's own mailbox; 'sendgrid' = the fallback rail. */
export type EmailProvider = "graph" | "sendgrid";

export type EmailSendStatus = "pending" | "sent" | "failed" | "received";

/** How an inbound message found its lead — the order `service/match.ts` tries. */
export type EmailMatchedBy = "from" | "in-reply-to" | "x-hp-lead" | "composer" | null;

export interface EmailMessageView {
  id: string;
  mailbox: string;
  graphMessageId: string | null;
  leadId: string | null;
  repId: string | null;
  direction: Direction;
  subject: string | null;
  /** The body we composed (outbound) or Graph's `bodyPreview` (inbound, D6). */
  preview: string | null;
  fromEmail: string | null;
  toEmails: string[];
  ccEmails: string[];
  /** ISO instant; `sent_at` when we have it, else the row's `created_at`. */
  at: string;
  sendStatus: EmailSendStatus;
  provider: EmailProvider | null;
  sendError: string | null;
  matchedBy: EmailMatchedBy;
  /** Outlook deep link (`webLink`) when Graph gave us one. */
  webLink: string | null;
}

/** One `crm_templates` row of `kind='email'`, merged for THIS lead. */
export interface EmailTemplateView {
  id: string;
  name: string;
  subject: string;
  body: string;
}

/**
 * Who the message goes out as. `mailbox` is the Graph sender; `cc` is the
 * acting user's own address when they are working the Guest Services bucket
 * (owner decision, brief §5.7b) and empty otherwise.
 */
export interface EmailSenderView {
  mailbox: string;
  displayName: string;
  repId: string | null;
  repSlug: string | null;
  cc: string[];
  /** True when the send will go out through Graph rather than SendGrid. */
  graph: boolean;
  /**
   * Why it will not, in words a director can act on (a missing Graph
   * permission, the kill switch, env not on this deployment). Null when the
   * message really is going out from the rep's own mailbox.
   */
  graphReason: string | null;
}

/**
 * The chip the composer and every SendGrid-sent card show, verbatim. Shown
 * whenever a message went out on the fallback rail, and on the composer
 * before sending when Graph is not configured yet.
 */
export const SENDGRID_FALLBACK_CHIP = "Sent via SendGrid — Outlook sync not connected yet";

/** Prototype copy, crm-shared.js:273. */
export const GRAPH_COMPOSER_FOOTNOTE =
  "Sent from your mailbox through Microsoft Graph. Replies land in Outlook and link back here automatically.";

/** GET /email?leadId=… — the composer's context plus this lead's messages. */
export type EmailContextResponse = ApiOk<{
  sender: EmailSenderView;
  to: string[];
  templates: EmailTemplateView[];
  messages: EmailMessageView[];
  nextCursor: string | null;
}>;

/** POST /email — send. */
export interface EmailSendBody {
  leadId: string;
  subject: string;
  body: string;
  to?: string[];
  cc?: string[];
  templateId?: string | null;
}

export type EmailSendResponse = ApiOk<{
  message: EmailMessageView;
  /** True when the message went out on the SendGrid fallback rail. */
  fellBack: boolean;
  /** Graph's complaint when we fell back because of it; null otherwise. */
  graphError: string | null;
  firstTouchRecorded: boolean;
}>;

export interface EmailThreadView {
  leadId: string;
  leadPublicId: string | null;
  guestName: string | null;
  guestEmail: string | null;
  lastAt: string;
  count: number;
  last: EmailMessageView;
}

/** GET /email/threads — one row per lead, newest first. */
export type EmailThreadsResponse = ApiOk<{
  threads: EmailThreadView[];
  nextCursor: string | null;
}>;

export const EMAIL_TEST_IDS = {
  thread: "crm-email-thread",
  composer: "crm-email-composer",
  sheet: "crm-email-sheet",
  card: (id: string) => "crm-email-card-" + id,
  fallbackChip: "crm-email-fallback-chip",
} as const;
