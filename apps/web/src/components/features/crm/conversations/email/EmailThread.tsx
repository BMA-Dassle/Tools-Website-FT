"use client";

import { IconMail } from "@tabler/icons-react";
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
  sortNewestFirst,
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
 * Presentational and hook-free: `EmailSheet` owns the data and the composer.
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
        return (
          <div
            key={msg.id}
            className={`mailcard ${msg.direction}`}
            data-testid={EMAIL_TEST_IDS.card(msg.id)}
          >
            <div className="mc-h">
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
              </div>
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
            </div>
            <div className="small" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
              {msg.preview ?? ""}
            </div>
            <div className="hstack" style={{ marginTop: 8 }}>
              {onReply ? (
                <button type="button" className="btn btn-sm" onClick={() => onReply(msg)}>
                  <IconMail {...ICON} /> Reply
                </button>
              ) : null}
              {chip ? (
                <Chip kind={chip.tone === "crit" ? "lost" : "open"}>{chip.text}</Chip>
              ) : (
                <span className="xs muted">{cardFootnote(msg, lead)}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default EmailThread;
