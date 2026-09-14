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
import { bmiChip, bmiChipIsRedundant, cardUrgency, dueLabel, isOpen, leadTitle } from "./model";
import { useRouter } from "next/navigation";
import { conversationKeyFor } from "../deal/actions";

/**
 * The board card (`kcard`, direction-b.html): title + value, date · guests ·
 * centre, the due timer while open, and the footer with the assignee, the BMI
 * chip and the hover rail (Call · Text · Email).
 *
 * THE RAIL STAYS INSIDE THE CRM. It used to hand off to the device — `tel:`,
 * `sms:`, `mailto:` — which was right before C1/C2/C3 existed and was left in
 * place after they shipped, so pressing Text or Email on a board card opened
 * the phone's own apps and nothing was ever logged against the deal. Owner,
 * 2026-09-14: "why are the email and sms buttons opening up 3rd party apps on
 * pipline page when we have our own internal".
 *
 * Text and Email go to the person's Conversations thread — one composer, one
 * consent check, one place the message is recorded. Call opens the deal, where
 * the Call sheet and its disposition live. `tel:` survives for Call on a phone
 * only as the dialer fallback inside that sheet, not as the button itself.
 *
 * Opening the deal: `onOpen` (the screens open the drawer over their board)
 * or, without it, a link to the full deal page.
 *
 * THE WHOLE CARD OPENS THE DEAL. Owner, 2026-09-13: "Anywhere in all this
 * stuff I should be able to click anywhee on the lead tile to bring up event."
 * It used to open only from the title, which is a ~120px target on a card that
 * looks clickable everywhere. This is ONE card shared by My Day, the queue and
 * the pipeline board, so fixing it here fixes all three.
 *
 * The title control keeps being a real <button> (or <Link>) named by the title
 * text — `.card-open` in crm.css stretches its ::after over the card. It is not
 * a <div onClick> (the a11y gate rejects those) and the card is not itself a
 * <button>, because Assign / Call / Text / Change status live inside it and
 * nesting buttons is invalid HTML. Those controls sit a layer above the
 * overlay, so their clicks land on them and never on the card.
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
  const router = useRouter();
  // Through the ROUTER, never `location.assign`: these are CRM paths now, and a
  // page load would throw away the cache, re-mint the API token, re-run the SSO
  // gate and close the board the rep is standing on.
  const go = (to: string | null) => {
    if (to) router.push(to);
  };
  const urgency = cardUrgency(lead, status, now);
  const due = lead.nextAction && isOpen(status) ? dueLabel(lead.nextAction.due, now) : null;
  /**
   * The BMI chip only when Office DISAGREES with the column this card is in.
   * A chip reading "BMI · Pending Quote" under a "Pending Quote" header is a
   * line of nothing, repeated down twenty cards; suppressing the agreeing case
   * is what makes the disagreeing one visible. Owner, 2026-09-14: "I still
   * think you can do better with these tiles."
   */
  const chip = bmiChipIsRedundant(lead, status?.label) ? null : bmiChip(lead);
  const conversationHref = conversationKeyFor(lead);
  const cls = ["kcard", `c-${lead.centre}`, urgency, quiet ? "quiet" : ""]
    .filter(Boolean)
    .join(" ");
  const title = leadTitle(lead);
  const href = `${CRM_BASE}/deal/${lead.publicId}`;
  const dealHref = href;

  return (
    <div className={cls} data-testid={LEAD_TEST_IDS.leadCard(lead.publicId)}>
      <div className="t">
        {onOpen ? (
          <button
            type="button"
            className="card-open"
            title={`Open ${title}`}
            onClick={() => onOpen(lead.publicId)}
          >
            {title}
          </button>
        ) : (
          <Link className="card-open" href={href} title={`Open ${title}`}>
            {title}
          </Link>
        )}
        {lead.valueCents ? <span className="money muted">{moneyK(lead.valueCents)}</span> : null}
      </div>
      {/* Date and headcount only. The centre pill used to sit here and was the
          widest thing on the row, so on any card with a longer date it wrapped
          to a second line and the cards in a column stopped lining up. It has
          moved to the footer, beside the assignee — which is where "who and
          where" belongs anyway. */}
      <div className="m">
        <span>{fDate(lead.eventDate)}</span>
        <span>{lead.guests} guests</span>
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
        <Pill centre={lead.centre}>{centreShort(lead.centre)}</Pill>
        {chip === null ? null : chip.kind === "bmi" ? (
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
              title={lead.guest.phone ? "Open the deal to call" : "No phone on file"}
              disabled={!lead.guest.phone}
              onClick={() => go(dealHref)}
            >
              <IconPhone {...ICON} />
            </button>
            <button
              type="button"
              aria-label="Text"
              title={conversationHref ? "Text from your own number" : "No phone on file"}
              disabled={!conversationHref}
              onClick={() => go(conversationHref)}
            >
              <IconMessage {...ICON} />
            </button>
            <button
              type="button"
              aria-label="Email"
              title={lead.guest.email ? "Email from your Outlook" : "No email on file"}
              disabled={!lead.guest.email || !conversationHref}
              onClick={() => go(conversationHref ? `${conversationHref}?tab=email` : null)}
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
