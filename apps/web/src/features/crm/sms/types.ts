/**
 * The SMS sub's wire vocabulary — what `/api/admin/crm/sms/**` and
 * `/api/admin/crm/templates` return, and what the Conversations screen renders.
 *
 * CLIENT-SAFE: type-only imports from core, no Node, no Neon. Components import
 * this file by path; `core/types.ts` stays untouched (append-only shared file —
 * the SMS shapes are the sub's own, so they live here).
 *
 * Ids are strings on the wire (Neon bigints as text; Vox ids as given).
 */

import type { Direction, LeadSource } from "../core/types";

/** `crm_sms_threads` — one (rep DID, guest number) pair. */
export interface SmsThread {
  id: string;
  repId: string | null;
  repDid: string;
  guestE164: string;
  contactId: string | null;
  leadId: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  readAt: string | null;
  unreadCount: number;
  /** Set when the guest texted STOP to this rep DID; cleared on START. */
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SmsSendStatus = "pending" | "sent" | "failed" | "suppressed" | "received";
export const SMS_SEND_STATUSES = [
  "pending",
  "sent",
  "failed",
  "suppressed",
  "received",
] as const satisfies readonly SmsSendStatus[];

/** A real text, or a system line the thread shows (STOP / START). */
export type SmsMessageKind = "sms" | "system";

export interface SmsMessage {
  id: string;
  threadId: string;
  leadId: string | null;
  direction: Direction;
  kind: SmsMessageKind;
  body: string;
  /** The DID the message actually left from — differs from the rep DID on a fallback send. */
  sentFrom: string | null;
  provider: string | null;
  providerMessageId: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
  sendStatus: SmsSendStatus;
  fallbackDid: boolean;
  templateId: string | null;
  actorEmail: string | null;
  occurredAt: string;
}

/**
 * Why a text may or may not be sent to this person (brief R8, consent basis per
 * lead source):
 *   inbound      they texted us first — always fine to reply
 *   enquiry      they gave us this number for THIS enquiry (web/phone/walkin/referral lead)
 *   no_consent   a cold / historical prospect with no inbound message → Call / Email only
 *   no_did       the signed-in person has no texting number (`crm_reps.vox_did` NULL)
 *   stopped      the guest texted STOP to this rep's number
 *   sms_off      the `CRM_SMS` kill switch is set to "false"
 *   no_rep       the signed-in person has no `crm_reps` row (a director who never sells)
 *   bad_number   the destination is not a phone number we can canonicalise
 *   not_gsm7     the body still carries a non-GSM-7 character after normalising
 */
export type ConsentBasis = "inbound" | "enquiry";
export type SendRefusal =
  | "no_consent"
  | "no_did"
  | "stopped"
  | "sms_off"
  | "no_rep"
  | "bad_number"
  | "not_gsm7";

export interface ConsentVerdict {
  allowed: boolean;
  basis: ConsentBasis | null;
  refusal: SendRefusal | null;
}

/** The lead fields consent and merge need. */
export interface LinkedLead {
  id: string;
  publicId: string;
  source: LeadSource | string;
  isProspect: boolean;
  assignedRepId: string | null;
  centre: string;
  eventDate: string;
  eventType: string;
  guests: number;
  statusId: string;
}

export interface LinkedContact {
  id: string;
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  accountName: string | null;
}

/** Just enough of a rep to draw their avatar (`repAvatar`, crm-shared.js:205). */
export interface ConversationRep {
  slug: string;
  initials: string;
  name: string;
}

/**
 * One entry of the Conversations list — ONE PERSON, however many rep threads
 * they have (the owner's rule: one entry per person, Text and Email tabs).
 *
 * `key` is the URL segment and is PATH-SAFE by construction: `c-<contactId>`
 * when we know the person, `p-<digits>` when all we have is a number.
 */
export interface ConversationSummary {
  key: string;
  contactId: string | null;
  /** "Dana Whitfield", or null when the number is unknown to us. */
  name: string | null;
  phoneE164: string;
  leadId: string | null;
  leadPublicId: string | null;
  leadStatus: string | null;
  /** "Lee Health · 60 guests · Sat, Oct 17" style caption; null without a lead. */
  leadTitle: string | null;
  /**
   * The reps whose DIDs this person has texted with, newest thread first.
   * Carries initials and name as well as the slug because the list row AND the
   * conversation header both draw `repAvatar(l.rep)` (crm-shared.js:205), and
   * on a director's team-wide view that avatar is the only thing that says
   * whose conversation this is.
   */
  reps: ConversationRep[];
  threadIds: string[];
  lastMessageAt: string | null;
  lastBody: string | null;
  lastDirection: Direction | null;
  unread: number;
  stopped: boolean;
  /**
   * Which channels this person has actually used, newest activity first.
   *
   * The screen is one entry per PERSON with Texts and Email tabs, but the list
   * was built from `crm_sms_threads` alone — so a guest who had been emailed
   * and never texted appeared nowhere, and the Email tab filtered a list that
   * could only contain texts. Owner, 2026-09-14: "why nothing showing under
   * conversasions", over a screen with two sent emails and no SMS at all.
   */
  channels: ConversationChannel[];
  /** The latest email, when there is one — `lastMessageAt` is the later of the two. */
  lastEmailAt: string | null;
  emailCount: number;
}

export type ConversationChannel = "sms" | "email";

export interface ConversationDetail {
  summary: ConversationSummary;
  messages: SmsMessage[];
  nextCursor: string | null;
  /** The signed-in rep's own texting number (never another rep's). */
  myDid: string | null;
  /** Which of this person's threads is the signed-in rep's, if any. */
  myThreadId: string | null;
  consent: ConsentVerdict;
  contact: LinkedContact | null;
  lead: LinkedLead | null;
}

/**
 * WHOSE CONVERSATIONS — three states, deliberately not two.
 *
 *   team   a director who asked for the team (`all=1`) — no rep filter
 *   rep    this rep's own threads
 *   none   signed in with a sales role but NO `crm_reps` row — sees nothing
 *
 * `none` exists because a bare `repId: null` used to mean BOTH "director, show
 * everything" and "we could not find a rep row", and `core/identity.ts:70-78`
 * degrades `rep` to `null` on purpose when the roster lookup throws. One
 * transient Neon error would otherwise promote an ordinary rep to a team-wide
 * reader who also zeroed their colleagues' unread counts. A person we cannot
 * identify gets the empty view, never the widest one.
 */
export type ConversationScope =
  | { kind: "team" }
  | { kind: "rep"; repId: string }
  | { kind: "none" };

export type ConversationFolder = "all" | "unread" | "texts" | "email";
export const CONVERSATION_FOLDERS = [
  "all",
  "unread",
  "texts",
  "email",
] as const satisfies readonly ConversationFolder[];

export interface CrmTemplate {
  id: string;
  kind: "sms" | "email";
  name: string;
  subject: string | null;
  body: string;
  mergeFields: string[];
  centre: string | null;
  position: number;
  archivedAt: string | null;
}

/** A template merged for one person: the rendered body and what could not be filled. */
export interface RenderedTemplate extends CrmTemplate {
  rendered: string;
  renderedSubject: string | null;
  missing: string[];
}

export interface SendSmsResult {
  ok: boolean;
  message: SmsMessage | null;
  threadId: string | null;
  /** A `SendRefusal` code, a Vox error, or null on success. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Route bodies / responses
// ---------------------------------------------------------------------------

export interface ThreadsListResponse {
  ok: true;
  conversations: ConversationSummary[];
  nextCursor: string | null;
  unread: number;
  /** The signed-in rep's texting number; null is the "ask the director" banner. */
  myDid: string | null;
  /** False when `CRM_SMS=false` — the kill switch, so the screen can say so. */
  smsEnabled: boolean;
}

export interface ThreadDetailResponse extends ConversationDetail {
  ok: true;
}

export interface ThreadSendResponse {
  ok: true;
  key: string;
  result: SendSmsResult;
}

export interface ThreadReadResponse {
  ok: true;
  key: string;
  unread: number;
}

export interface UnreadResponse {
  ok: true;
  n: number;
}

export interface TemplatesResponse {
  ok: true;
  templates: RenderedTemplate[];
}

export interface TemplateInput {
  id?: string;
  kind: "sms" | "email";
  name: string;
  subject?: string | null;
  body: string;
  centre?: string | null;
  position?: number;
}

// ---------------------------------------------------------------------------
// DOM test ids
// ---------------------------------------------------------------------------

export const SMS_TEST_IDS = {
  conversations: "crm-conversations",
  threadList: "crm-thread-list",
  threadView: "crm-thread-view",
  composer: "crm-sms-composer",
  noDid: "crm-sms-no-did",
  noConsent: "crm-sms-no-consent",
  templatePicker: "crm-template-picker",
  convTab: (id: string) => "crm-conv-tab-" + id,
} as const;

/**
 * The banner and the refusal share ONE string, so what the composer says and
 * what the service answers can never drift (owner item D5: no rep has a DID).
 */
export const NO_DID_MESSAGE = "No texting number assigned to you yet — ask the director";

/** What the Conversations list says when a cold row may not be texted. */
export const NO_CONSENT_MESSAGE =
  "This number was not given to us for an enquiry — Call or Email only until they text us first";
