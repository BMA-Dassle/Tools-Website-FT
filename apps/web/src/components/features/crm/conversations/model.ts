import { CRM_BASE } from "~/features/crm/core/contracts";
import {
  NO_CONSENT_MESSAGE,
  NO_DID_MESSAGE,
  type ConversationFolder,
  type ConversationSummary,
  type SendRefusal,
} from "~/features/crm/sms/types";

/**
 * The Conversations screen's pure half — every string and every decision that
 * does not need React, so it is testable without rendering anything (R12).
 *
 * COPY IS THE PROTOTYPE'S, VERBATIM (`direction-b.html:113-119`,
 * `crm-shared.js:322-331, 259-265`). Where the prototype had no state we do —
 * a refusal, a missing DID — the sentence is written once here and used by both
 * the screen and the service's error code, so what the composer promises and
 * what the service does cannot drift.
 */

/** `.slice(0, 70)` on the list row (direction-b.html:115). */
export const PREVIEW_CHARS = 70;

export function previewOf(body: string | null, max = PREVIEW_CHARS): string {
  if (!body) return "";
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The list shows a name when we have one, else the number. */
export function displayName(c: Pick<ConversationSummary, "name" | "phoneE164">): string {
  return c.name?.trim() || c.phoneE164;
}

export function conversationHref(key: string): string {
  return `${CRM_BASE}/conversations/${key}`;
}

/** "All · Unread 2 · Texts · Email" (direction-b.html:115). */
export function folderOptions(
  unread: number,
): { value: ConversationFolder; label: string; badge?: number }[] {
  return [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread", ...(unread > 0 ? { badge: unread } : {}) },
    { value: "texts", label: "Texts" },
    { value: "email", label: "Email" },
  ];
}

/**
 * `email` returned an empty array unconditionally — a placeholder from before
 * the email rail existed, left in place after it shipped. So the tab was empty
 * even once emails were being sent and recorded, and `texts` showed email-only
 * people because it did not filter at all. Both now read `channels`, which the
 * list carries per person.
 */
export function filterConversations(
  list: readonly ConversationSummary[],
  folder: ConversationFolder,
): ConversationSummary[] {
  if (folder === "unread") return list.filter((c) => c.unread > 0);
  if (folder === "email") return list.filter((c) => c.channels.includes("email"));
  if (folder === "texts") return list.filter((c) => c.channels.includes("sms"));
  return [...list];
}

/** `${guest.phone} ↔ your number ${rep.did}` (crm-shared.js:326). */
export function convFromLine(phone: string, did: string | null): string {
  return did ? `${phone} ↔ your number ${did}` : `${phone} ↔ no texting number yet`;
}

/** `Text ${guest.first} from ${rep.did}…` (crm-shared.js:331). */
export function composerPlaceholder(firstName: string | null, did: string | null): string {
  const who = firstName?.trim() || "them";
  return did ? `Text ${who} from ${did}…` : `Text ${who}…`;
}

/*
 * `fromToLine` — "From your number <did> to <phone>" (crm-shared.js:260) — is
 * DELETED, not unused.
 *
 * It was the header of the prototype's in-drawer Text sheet, and C1 does not
 * build that sheet: the deal's Text button opens this person's Conversations
 * thread instead, so there is ONE composer, one consent check and one place a
 * text is recorded rather than two of each. Keeping the string alive with only
 * its own test to read it would have made that test an assertion about a screen
 * nobody renders.
 *
 * The conversation header carries the same fact in the prototype's other
 * wording, `convFromLine` above ("<phone> ↔ your number <did>").
 *
 * HANDED TO C6: the dropped sheet also had an "Attach flyer / pricing" button
 * (crm-shared.js:263), and the Conversations composer has no attach control
 * either. The affordance belongs with the collateral library — C6 adds it to
 * `SmsComposer` when share links exist to attach.
 */

/**
 * Why the composer is closed. One sentence per refusal code — the SAME codes
 * `sms/service/send.ts` answers with, so a rep never sees a bare code and the
 * screen never invents a reason the service does not have.
 */
export const REFUSAL_MESSAGE: Record<SendRefusal, string> = {
  no_did: NO_DID_MESSAGE,
  no_consent: NO_CONSENT_MESSAGE,
  stopped: "This guest texted STOP to your number. They must text START before you can reply.",
  sms_off: "Texting is switched off right now — a director can turn it back on.",
  no_rep:
    "You are signed in as a director without a sales record, so there is no number to text from.",
  bad_number: "We do not have a mobile number for this person.",
  not_gsm7: "That message has a character we cannot send — use plain text only.",
};

export function refusalMessage(refusal: SendRefusal | null): string | null {
  return refusal ? REFUSAL_MESSAGE[refusal] : null;
}

/** A send's error code back into a sentence; anything else is shown as-is. */
export function sendErrorMessage(error: string | null): string {
  if (!error) return "";
  if (error in REFUSAL_MESSAGE) return REFUSAL_MESSAGE[error as SendRefusal];
  if (error === "suppressed") {
    return "That number has opted out of our texts, so nothing was sent.";
  }
  if (error === "not_recorded") {
    return "The message was not saved, so it was not sent. Try again.";
  }
  return `Not sent — ${error}`;
}

/** `toast("Text sent · logged on the deal")` (crm-shared.js:265), verbatim. */
export const SENT_TOAST = "Text sent · logged on the deal";
