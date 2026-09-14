/**
 * Pure helpers behind the Email tab. Everything the prototype computes inline
 * in `threadBody` (crm-shared.js:322-328) lives here so a unit test can assert
 * the copy and the ordering without rendering anything (R12).
 */

import {
  SENDGRID_FALLBACK_CHIP,
  type EmailMessageView,
  type EmailSenderView,
} from "~/features/crm/email/contracts";
import type { LeadView } from "~/features/crm/leads/contracts";

/** Newest first — the prototype's `mail` sort (crm-shared.js:325). */
export function sortNewestFirst(messages: readonly EmailMessageView[]): EmailMessageView[] {
  return [...messages].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** `KK` for the rep, the guest's own initials inbound (crm-shared.js:327). */
export function initialsFor(msg: EmailMessageView, lead: LeadView, repInitials: string): string {
  if (msg.direction === "out") return repInitials;
  const first = lead.guest.first?.[0] ?? "";
  const last = lead.guest.last?.[0] ?? "";
  return (first + last).toUpperCase() || "?";
}

/** `You → dana@example.com` / `Dana Acme → you`, verbatim (crm-shared.js:327). */
export function whoLine(msg: EmailMessageView, lead: LeadView): string {
  if (msg.direction === "out") {
    const to = msg.toEmails[0] ?? lead.guest.email ?? "";
    return `You → ${to}`;
  }
  const name = `${lead.guest.first} ${lead.guest.last}`.trim() || (msg.fromEmail ?? "");
  return `${name} → you`;
}

/**
 * The footnote under each card. The prototype has two (crm-shared.js:327);
 * a SendGrid-sent message gets the chip copy instead, because "Sent from your
 * mailbox via the CRM" would be a lie — it went out through SendGrid with the
 * rep's address as `from`, and it is not in their Sent Items.
 */
export function cardFootnote(msg: EmailMessageView, lead: LeadView): string {
  if (msg.direction === "in") {
    return `Landed in your Outlook inbox · linked by ${msg.fromEmail ?? lead.guest.email ?? ""}`;
  }
  if (msg.provider === "sendgrid") return SENDGRID_FALLBACK_CHIP;
  return "Sent from your mailbox via the CRM";
}

/** `No email with Dana yet.` (crm-shared.js:327, verbatim). */
export function emptyThreadCopy(lead: LeadView): string {
  return `No email with ${lead.guest.first || "them"} yet.`;
}

/**
 * `New email from kelsea@headpinz.com` (crm-shared.js:328, verbatim).
 *
 * NOT called from this sub, on purpose: it is the label on the Conversations
 * screen's "new email" button, and C1 owns that screen. It lives here with its
 * test so the copy is pinned before the screen that renders it exists.
 */
export function composerButtonCopy(sender: EmailSenderView): string {
  return `New email from ${sender.mailbox}`;
}

/** `dana@example.com ↔ kelsea@headpinz.com` (crm-shared.js:326, verbatim). */
export function convFromLine(lead: LeadView, sender: EmailSenderView): string {
  return `${lead.guest.email ?? ""} ↔ ${sender.mailbox}`;
}

/** Shown in place of the Graph footnote while the fallback rail is the live one. */
export function composerFootnoteFor(sender: EmailSenderView, graphFootnote: string): string {
  return sender.graph ? graphFootnote : SENDGRID_FALLBACK_CHIP;
}

export type SendStateTone = "ok" | "warn" | "crit";

/** The chip a card carries: nothing on a clean Graph send. */
export function sendStateChip(msg: EmailMessageView): { text: string; tone: SendStateTone } | null {
  if (msg.sendStatus === "failed") {
    return { text: msg.sendError ? `Not sent — ${msg.sendError}` : "Not sent", tone: "crit" };
  }
  if (msg.sendStatus === "pending") return { text: "Sending…", tone: "warn" };
  if (msg.direction === "out" && msg.provider === "sendgrid") {
    return { text: SENDGRID_FALLBACK_CHIP, tone: "warn" };
  }
  return null;
}

/**
 * Split a body into what is NEW and what is the quoted trail beneath it.
 *
 * Owner, 2026-09-14: "think there is a beter layout of this screen espcailly
 * when you start getting alot of emails back and forth… quoted trails folded
 * behind a 'show quoted text' control."
 *
 * On the fifth reply the quoted trail is four-fifths of the message and the
 * only part nobody needs — it is the four messages already on screen above it,
 * again. Folding it is what makes a long thread readable.
 *
 * TWO MARKERS, both conservative:
 *   - the first line that begins with ">" (every client's quote prefix), or
 *   - an attribution line: "On <date>, <somebody> wrote:", which Outlook,
 *     Gmail and Apple Mail all emit in some form.
 *
 * Whichever comes FIRST wins, and everything from there down is the trail.
 * Deliberately not clever: a false positive hides something somebody wrote, so
 * the control says how much is hidden and one click brings it all back.
 * Nothing is ever discarded.
 */
export interface SplitBody {
  visible: string;
  /** Null when there is no trail — the common case on a first message. */
  quoted: string | null;
}

const QUOTE_ATTRIBUTION = /^\s*On\b.*\bwrote:\s*$/;

export function splitQuoted(body: string | null | undefined): SplitBody {
  if (!body) return { visible: "", quoted: null };
  const lines = body.split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith(">") || QUOTE_ATTRIBUTION.test(line)) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return { visible: body, quoted: null };
  const visible = lines.slice(0, cut).join("\n").trimEnd();
  const quoted = lines.slice(cut).join("\n").trimEnd();
  // A message that is ONLY a quote has nothing to fold away — folding it would
  // leave an empty card.
  if (!visible) return { visible: body, quoted: null };
  return { visible, quoted: quoted || null };
}

/**
 * One line of a message, for a collapsed card: the first thing somebody wrote,
 * with the quoted trail and blank lines gone.
 */
export function oneLinePreview(body: string | null | undefined, max = 120): string {
  const { visible } = splitQuoted(body);
  const line = visible
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
