"use client";

import {
  IconBolt,
  IconCheck,
  IconDots,
  IconFlag,
  IconMail,
  IconMessage,
  IconNote,
  IconPhoneIncoming,
  IconPhoneOutgoing,
  IconStack2,
  IconUsers,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { fStamp } from "~/features/crm/core/dates";
import type { CrmActivity } from "~/features/crm/core/types";
import { ICON } from "../primitives/icon-props";

/**
 * `dealTimeline` / `tlItem` (crm-shared.js:300-311): one `.tl` per activity,
 * newest first, the dot icon by kind, "Guest" / "You" by direction, the body
 * by kind (bubble for a text, subject + preview for an email, outcome for a
 * call, a line for everything else). B4 extends this with the merged view.
 */
const KIND_ICON: Record<string, ComponentType<IconProps>> = {
  sms: IconMessage,
  email: IconMail,
  note: IconNote,
  status: IconFlag,
  bmi: IconStack2,
  payment: IconCheck,
  system: IconBolt,
  assign: IconUsers,
  reachout: IconPhoneOutgoing,
};

/** The dot's glyph as an ELEMENT (never a component picked in render). */
function dotIcon(a: CrmActivity): React.ReactNode {
  if (a.kind === "call")
    return a.direction === "in" ? <IconPhoneIncoming {...ICON} /> : <IconPhoneOutgoing {...ICON} />;
  const Cmp = KIND_ICON[a.kind] ?? IconDots;
  return <Cmp {...ICON} />;
}

function who(a: CrmActivity): string {
  if (a.direction === "in") return "Guest";
  if (a.direction === "out") return "You";
  return a.actorEmail ?? "";
}

function dur(seconds: number | null): string {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function TimelineItem({ a }: { a: CrmActivity }) {
  let body: React.ReactNode;
  if (a.kind === "sms") body = <div className={`bubble ${a.direction ?? "out"}`}>{a.body}</div>;
  else if (a.kind === "email")
    body = (
      <div className="mail">
        <div className="subj">{a.subject}</div>
        {a.body ? <div className="prev">{a.body}</div> : null}
      </div>
    );
  else if (a.kind === "call")
    body = (
      <div className="txt">
        <b>{a.direction === "in" ? "Inbound" : "Outbound"} call</b>
        {a.durationSeconds != null ? ` · ${dur(a.durationSeconds)}` : ""}
        {a.outcome ? ` · ${a.outcome}` : ""}
        {a.body ? ` — ${a.body}` : ""}
      </div>
    );
  else
    body = (
      <div className={a.kind === "note" ? "txt" : "txt small"}>{a.body ?? a.subject ?? a.kind}</div>
    );

  return (
    <div className="tl" data-kind={a.kind}>
      <div className="dot">{dotIcon(a)}</div>
      <div className="body">
        <div className="who">
          <span>{who(a)}</span>
          <span>{fStamp(a.occurredAt)}</span>
        </div>
        {body}
      </div>
    </div>
  );
}

export function Timeline({ activities }: { activities: CrmActivity[] }) {
  return (
    <div className="card">
      <div className="card-h">
        <h2>Timeline</h2>
        <div className="right">
          <span className="pill">{activities.length} events</span>
        </div>
      </div>
      {activities.length === 0 ? (
        <div className="empty">Nothing logged yet.</div>
      ) : (
        <div className="timeline">
          {activities.map((a) => (
            <TimelineItem key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}
