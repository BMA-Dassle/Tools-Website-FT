"use client";

import { IconClock, IconMail, IconMessage, IconPhone } from "@tabler/icons-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDate } from "~/features/crm/core/dates";
import { moneyK } from "~/features/crm/core/format";
import type { CrmStatus } from "~/features/crm/core/types";
import { LEAD_TEST_IDS, type LeadView } from "~/features/crm/leads/contracts";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { Timer } from "../primitives/Timer";
import { bmiChip, cardUrgency, contactHrefs, dueLabel, isOpen, leadTitle } from "./model";

/**
 * The board card (`kcard`, direction-b.html): title + value, date · guests ·
 * centre, the due timer while open, and the footer with the assignee, the BMI
 * chip and the hover rail (Call · Text · Email). The rail's buttons open the
 * phone's dialer / messages / mail through `tel:` / `sms:` / `mailto:` — the
 * 3CX, Vox and Graph channels (C3 / C1 / C2) replace them in place.
 *
 * Opening the deal: `onOpen` (the screens open the drawer over their board)
 * or, without it, a link to the full deal page.
 */
export interface LeadCardProps {
  lead: LeadView;
  status?: CrmStatus;
  now: Date;
  onOpen?: (publicId: string) => void;
  /** Hide the assignee avatar (a column already grouped by rep). */
  hideRep?: boolean;
  /** Extra meta line under the title (the queue's "assigned 4 min ago" strip). */
  extraMeta?: ReactNode;
  /** Replaces the rail (the queue's Assign button). */
  footer?: ReactNode;
  quiet?: boolean;
}

function go(href: string | null) {
  if (href && typeof window !== "undefined") window.location.assign(href);
}

export function LeadCard({
  lead,
  status,
  now,
  onOpen,
  hideRep,
  extraMeta,
  footer,
  quiet,
}: LeadCardProps) {
  const urgency = cardUrgency(lead, status, now);
  const due = lead.nextAction && isOpen(status) ? dueLabel(lead.nextAction.due, now) : null;
  const chip = bmiChip(lead);
  const hrefs = contactHrefs(lead);
  const cls = ["kcard", `c-${lead.centre}`, urgency, quiet ? "quiet" : ""]
    .filter(Boolean)
    .join(" ");
  const title = leadTitle(lead);
  const href = `${CRM_BASE}/deal/${lead.publicId}`;

  return (
    <div className={cls} data-testid={LEAD_TEST_IDS.leadCard(lead.publicId)}>
      <div className="t">
        {onOpen ? (
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              padding: 0,
              border: 0,
              background: "none",
              font: "inherit",
              textAlign: "left",
            }}
            onClick={() => onOpen(lead.publicId)}
          >
            {title}
          </button>
        ) : (
          <Link href={href}>{title}</Link>
        )}
        {lead.valueCents ? <span className="money muted">{moneyK(lead.valueCents)}</span> : null}
      </div>
      <div className="m">
        <span>{fDate(lead.eventDate)}</span>
        <span>{lead.guests} guests</span>
        <Pill centre={lead.centre}>{centreShort(lead.centre)}</Pill>
      </div>
      {extraMeta ? <div className="m">{extraMeta}</div> : null}
      {due ? (
        <div className="m">
          <Timer tone={due.k} icon={<IconClock {...ICON} />}>
            {due.t}
          </Timer>
        </div>
      ) : null}
      <div className="f">
        {hideRep ? null : (
          <Avatar
            initials={lead.rep ? initialsOf(lead.repName) : undefined}
            repSlug={lead.repSlug}
            name={lead.repName ?? undefined}
            sm
          />
        )}
        {chip.kind === "bmi" ? (
          <Chip bmi title={chip.title}>
            {chip.label}
          </Chip>
        ) : (
          <Chip kind={chip.kind} title={chip.title}>
            {chip.label}
          </Chip>
        )}
        <span style={{ flex: 1 }} />
        {footer ?? (
          <div className="rail">
            <button
              type="button"
              aria-label="Call"
              disabled={!hrefs.tel}
              onClick={() => go(hrefs.tel)}
            >
              <IconPhone {...ICON} />
            </button>
            <button
              type="button"
              aria-label="Text"
              disabled={!hrefs.sms}
              onClick={() => go(hrefs.sms)}
            >
              <IconMessage {...ICON} />
            </button>
            <button
              type="button"
              aria-label="Email"
              disabled={!hrefs.mailto}
              onClick={() => go(hrefs.mailto)}
            >
              <IconMail {...ICON} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** `centreTag(id)` labels (crm-data.js:11-15). */
export function centreShort(code: LeadView["centre"]): string {
  return code === "HPFM" ? "HP Fort Myers" : code === "FT" ? "FastTrax" : "HP Naples";
}

function initialsOf(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
