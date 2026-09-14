"use client";

import { IconChevronDown, IconMail } from "@tabler/icons-react";
import { useState } from "react";
import type { EmailMessageView, EmailSenderView } from "~/features/crm/email/contracts";
import { EMAIL_TEST_IDS } from "~/features/crm/email/contracts";
import { fStamp } from "~/features/crm/core/dates";
import type { LeadView } from "~/features/crm/leads/contracts";
import { Avatar } from "../../primitives/Avatar";
import { Chip } from "../../primitives/Chip";
import { EmptyState } from "../../primitives/States";
import { ICON } from "../../primitives/icon-props";
import {
  cardFootnote,
  emptyThreadCopy,
  initialsFor,
  sendStateChip,
  oneLinePreview,
  sortNewestFirst,
  splitQuoted,
  whoLine,
} from "./model";

/**
 * The Email half of a lead's conversation — the prototype's `tab === "email"`
 * branch (crm-shared.js:327), one `.mailcard` per message, newest first, with
 * the empty state's own illustration and copy.
 *
 * The card's "Outlook ↗" is a REAL link when Graph gave us a `webLink`, and is
 * simply absent otherwise (a SendGrid-sent message is not in anyone's Sent
 * Items, so a button that pretended to open it would lie). The prototype's
 * `data-act="toast" "Opening in Outlook"` was the mock standing in for this.
 *
 * COLLAPSED BY DEFAULT, newest open. Owner, 2026-09-14: "think there is a
 * beter layout of this screen espcailly when you start getting alot of emails
 * back and forth" — every message rendered at full height, so with a dozen of
 * them the reply box was below the fold and the thread was a wall.
 *
 * A collapsed card is who, when, and the first line they actually wrote; the
 * newest stays open because it is the one being replied to. Expanding is a
 * click on the card's own header, which is the target a thumb reaches for
 * anyway.
 *
 * `EmailSheet` still owns the data and the composer; the only state here is
 * which cards a reader has opened.
 */
export interface EmailThreadProps {
  lead: LeadView;
  sender: EmailSenderView;
  messages: readonly EmailMessageView[];
  repInitials: string;
  repSlug: string | null;
  /** Reply pre-fills the composer with `RE: <subject>`. */
  onReply?: (msg: EmailMessageView) => void;
}

export function EmailThread({
  lead,
  sender,
  messages,
  repInitials,
  repSlug,
  onReply,
}: EmailThreadProps) {
  const ordered = sortNewestFirst(messages);
  /**
   * Which cards the reader has opened. The NEWEST is open without being in
   * here — it is the message being replied to, and making somebody click to
   * read the thing they just came to read would be its own annoyance.
   */
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [showQuoted, setShowQuoted] = useState<Record<string, boolean>>({});
  const newestId = ordered[0]?.id ?? null;
  const isOpen = (id: string) => opened[id] ?? id === newestId;

  if (ordered.length === 0) {
    return (
      <div className="thread" style={{ gap: 10 }} data-testid={EMAIL_TEST_IDS.thread}>
        <EmptyState
          icon={
            <svg className="ill" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
              <rect x="10" y="18" width="44" height="30" rx="6" fill="var(--accent-soft)" />
              <path d="M12 22l20 14 20-14" stroke="var(--accent)" strokeWidth="2.5" fill="none" />
            </svg>
          }
        >
          {emptyThreadCopy(lead)}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="thread" style={{ gap: 10 }} data-testid={EMAIL_TEST_IDS.thread}>
      {ordered.map((msg) => {
        const out = msg.direction === "out";
        const chip = sendStateChip(msg);
        const open = isOpen(msg.id);
        const body = splitQuoted(msg.preview);
        const quotedOpen = showQuoted[msg.id] ?? false;
        return (
          <div
            key={msg.id}
            className={`mailcard ${msg.direction}`}
            data-testid={EMAIL_TEST_IDS.card(msg.id)}
          >
            {/* THE HEADER IS THE TOGGLE — a whole-width target, which is what
                a thumb reaches for, and it carries the state so a screen reader
                is told the card can open. It is a <button> rather than a div
                with a click, because the a11y gate is right to refuse those. */}
            <button
              type="button"
              className="mc-h mc-toggle"
              aria-expanded={open}
              onClick={() => setOpened((o) => ({ ...o, [msg.id]: !open }))}
            >
              <Avatar
                sm
                initials={initialsFor(msg, lead, repInitials)}
                repSlug={out ? repSlug : null}
                name={out ? sender.displayName : `${lead.guest.first} ${lead.guest.last}`.trim()}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  className="strong small"
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {msg.subject ?? "(no subject)"}
                </div>
                <div className="xs muted">
                  {whoLine(msg, lead)} · {fStamp(msg.at)}
                </div>
                {/* Closed, the card still says what the message WAS — the first
                    line they actually wrote, with the quoted trail stripped.
                    A collapsed row that showed only a subject would make
                    somebody open every card to find the one they wanted. */}
                {open ? null : <div className="mc-peek">{oneLinePreview(msg.preview)}</div>}
              </div>
              <IconChevronDown {...ICON} className={`icon mc-chev${open ? " up" : ""}`} />
            </button>

            {open ? (
              <>
                <div className="small mc-body">{body.visible}</div>
                {body.quoted ? (
                  <div className="mc-quoted">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      aria-expanded={quotedOpen}
                      onClick={() => setShowQuoted((q) => ({ ...q, [msg.id]: !quotedOpen }))}
                    >
                      {quotedOpen ? "Hide quoted text" : "Show quoted text"}
                    </button>
                    {quotedOpen ? (
                      <div className="small mc-body mc-trail">{body.quoted}</div>
                    ) : null}
                  </div>
                ) : null}
                <div className="hstack" style={{ marginTop: 8 }}>
                  {onReply ? (
                    <button type="button" className="btn btn-sm" onClick={() => onReply(msg)}>
                      <IconMail {...ICON} /> Reply
                    </button>
                  ) : null}
                  {msg.webLink ? (
                    <a
                      className="btn btn-ghost btn-sm"
                      href={msg.webLink}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Outlook ↗
                    </a>
                  ) : null}
                  {chip ? (
                    <Chip kind={chip.tone === "crit" ? "lost" : "open"}>{chip.text}</Chip>
                  ) : (
                    <span className="xs muted">{cardFootnote(msg, lead)}</span>
                  )}
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default EmailThread;
