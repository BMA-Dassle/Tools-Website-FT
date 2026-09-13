"use client";

import { IconMessage } from "@tabler/icons-react";
import Link from "next/link";
import { fStamp } from "~/features/crm/core/dates";
import type { ConversationSummary } from "~/features/crm/sms/types";
import { Avatar } from "../primitives/Avatar";
import { ICON } from "../primitives/icon-props";
import { conversationHref, displayName, previewOf } from "./model";

/**
 * The person list (direction-b.html:115): avatar, name, unread badge, the
 * caption, a one-line preview of the last message and its timestamp.
 *
 * The avatar is the REP's, tinted by slug — that is what the prototype shows,
 * and on a director's team-wide view it is the only thing that says whose
 * conversation this is. A person who has texted two reps shows the first.
 *
 * Hook-free on purpose (R12): the screen owns the queries, this walks the array.
 */
export function ThreadList({
  conversations,
  activeKey,
}: {
  conversations: readonly ConversationSummary[];
  activeKey: string | null;
}) {
  return (
    <div className="list">
      {conversations.map((c) => (
        <Link
          key={c.key}
          className={`row${c.key === activeKey ? " active" : ""}`}
          href={conversationHref(c.key)}
          aria-current={c.key === activeKey ? "page" : undefined}
        >
          <Avatar
            initials={initialsFor(c)}
            repSlug={c.repSlugs[0] ?? null}
            name={c.repSlugs[0] ? `Texting with ${c.repSlugs[0]}` : undefined}
            sm
          />
          <div>
            <div className="title">
              {displayName(c)} {c.unread > 0 ? <span className="badge">{c.unread}</span> : null}
              {c.leadTitle && c.leadTitle !== displayName(c) ? (
                <span className="muted small"> · {c.leadTitle}</span>
              ) : null}
            </div>
            <div className="meta">
              {/* The icon is the CHANNEL, as in the prototype — every row here
                  is a text until C2 folds email into the same list. */}
              <span style={{ whiteSpace: "normal" }}>
                <IconMessage {...ICON} /> {previewOf(c.lastBody)}
              </span>
              {c.stopped ? <span className="pill">STOP</span> : null}
            </div>
          </div>
          <div className="right">
            <span className="xs muted">{c.lastMessageAt ? fStamp(c.lastMessageAt) : ""}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** The guest's initials, else a question mark (never the rep's). */
function initialsFor(c: ConversationSummary): string {
  const name = c.name?.trim();
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}
