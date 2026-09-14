"use client";

import {
  IconBolt,
  IconBuilding,
  IconChevronDown,
  IconClock,
  IconRefresh,
  IconStack2,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fTime } from "~/features/crm/core/dates";
import { money } from "~/features/crm/core/format";
import type { CrmStatus } from "~/features/crm/core/types";
import {
  EVENT_TYPE_LABEL,
  LEAD_SOURCE_LABEL,
  LEAD_TEST_IDS,
  NEEDS_EMAIL_OR_TIME,
  type LeadView,
} from "~/features/crm/leads/contracts";
import { requestedPlannerLabel } from "~/features/crm/leads/planners";
import { responseBadge } from "~/features/crm/leads/response-badge";
import { initialsOf } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { DateBlock } from "../primitives/DateBlock";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { Timer, formatMinutes } from "../primitives/Timer";
import { centreShort } from "../leads/LeadCard";
import { TypeGlyph } from "../leads/TypeGlyph";
import {
  STEPS,
  bmiChip,
  bmiChipIsRedundant,
  daysOutOf,
  leadName,
  leadTitle,
  stepIndex,
  typeIcon,
} from "../leads/model";

const CENTRE_NAME: Record<LeadView["centre"], string> = {
  HPFM: "HeadPinz Fort Myers",
  FT: "FastTrax Fort Myers",
  HPN: "HeadPinz Naples",
};

/**
 * `dealHeader(l)` (crm-shared.js:291): the hero — date block, title, facts,
 * the status / BMI / ref / response strip, the value and days out, the
 * director's Reassign, the BMI action, and the stepper.
 *
 * The status chip is a BUTTON (crm-shared.js:295 `data-act="status"`): it
 * opens the same sheet the board's cards do, so a lead can be moved from the
 * deal without going back to the board — and without a drag (R13).
 */
export interface DealHeaderProps {
  /**
   * Drop what the surrounding chrome already says. True in the drawer, whose
   * own header carries the guest's name.
   */
  compact?: boolean;
  lead: LeadView;
  status: CrmStatus | undefined;
  now: Date;
  isDirector: boolean;
  onReassign: () => void;
  /** Open the "Change status" sheet. */
  onChangeStatus: () => void;
  /** Open the edit sheet; `thenMint` = "Complete to create in BMI". */
  onEdit: (thenMint: boolean) => void;
  onMint: () => void;
  minting: boolean;
}

export function DealHeader({
  lead,
  status,
  now,
  isDirector,
  onReassign,
  onChangeStatus,
  onEdit,
  onMint,
  minting,
  compact,
}: DealHeaderProps) {
  const d = daysOutOf(lead, now);
  const chip = bmiChipIsRedundant(lead, status?.label) ? null : bmiChip(lead);
  const rb = responseBadge(lead, now);
  const ix = stepIndex(lead.status);
  const builder = `${CRM_BASE}/builder/${lead.publicId}`;

  let bmiAction: React.ReactNode;
  if (lead.bmi.projectId) {
    bmiAction = (
      <Link className="btn btn-sm btn-primary" href={builder}>
        <IconStack2 {...ICON} /> Edit in BMI
      </Link>
    );
  } else if (lead.isProspect) {
    bmiAction = (
      <Link className="btn btn-sm btn-primary" href={builder}>
        <IconStack2 {...ICON} /> Convert to lead (creates BMI project)
      </Link>
    );
  } else if (lead.mintStatus === "none" && lead.mintError === NEEDS_EMAIL_OR_TIME) {
    bmiAction = (
      <button type="button" className="btn btn-sm btn-primary" onClick={() => onEdit(true)}>
        <IconStack2 {...ICON} /> Complete to create in BMI
      </button>
    );
  } else if (lead.mintStatus === "pending") {
    bmiAction = (
      <button type="button" className="btn btn-sm" disabled>
        <IconRefresh {...ICON} /> Creating in BMI…
      </button>
    );
  } else {
    bmiAction = (
      <button type="button" className="btn btn-sm btn-primary" onClick={onMint} disabled={minting}>
        <IconRefresh {...ICON} /> {minting ? "Retrying…" : "Retry BMI"}
      </button>
    );
  }

  return (
    <div className="hero" data-testid={LEAD_TEST_IDS.dealHeader}>
      <DateBlock date={lead.eventDate} lg daysOut={d} />
      <div style={{ flex: 1, minWidth: 220 }}>
        {/* The DRAWER already carries the guest's name in its own header, two
            inches above this one. Printing it twice is a whole row of the
            phone's screen spent saying nothing new — part of what the owner
            meant by "Hate this layout" and by the header being seven stacked
            rows where the prototype's is three. On the full page there is no
            other title, so it stays. */}
        {compact ? null : <h2>{leadTitle(lead)}</h2>}
        <div className="facts">
          {lead.guest.company ? (
            <span>
              <IconUser {...ICON} />
              <b>{leadName(lead)}</b>
            </span>
          ) : null}
          <span>
            <IconClock {...ICON} />
            <b>
              {lead.eventTime ? fTime(`${lead.eventDate}T${lead.eventTime}:00`) : "time not set"}
            </b>
          </span>
          <span>
            <IconUsers {...ICON} />
            <b>{lead.guests}</b> guests
          </span>
          <span>
            <IconBuilding {...ICON} />
            {CENTRE_NAME[lead.centre]}
          </span>
          <span>
            <TypeGlyph name={typeIcon(lead.type)} />
            {EVENT_TYPE_LABEL[lead.type]}
            {lead.type === "birthday" && lead.kids ? " (kids)" : ""}
          </span>
          <Pill>{LEAD_SOURCE_LABEL[lead.source]}</Pill>
          {/* B7 — carried whether or not the rules honoured it, so the planner
              reading the deal knows who the guest expected to hear from. */}
          {lead.requestedRep ? (
            <Pill
              title={
                lead.repSlug === lead.requestedRep.slug
                  ? "The guest asked for this planner on the web form."
                  : "The guest asked for this planner on the web form; a routing rule sent it elsewhere."
              }
            >
              {requestedPlannerLabel(lead.requestedRep.firstName)}
            </Pill>
          ) : null}
        </div>
        <div className="hstack" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-sm"
            aria-label={`Change status — currently ${status?.label ?? lead.status}`}
            onClick={onChangeStatus}
          >
            {status ? (
              <Chip kind={status.kind} st={status.id}>
                {status.label}
              </Chip>
            ) : (
              <Chip kind="open">{lead.status}</Chip>
            )}
            <IconChevronDown {...ICON} />
          </button>
          {/* Only when Office DISAGREES with our status. "BMI · Pending Quote"
              beside a status chip that already says Quote sent is a second
              chip carrying no second fact, and it was one of seven competing
              on this line. Owner, 2026-09-14: "Fix icons and such", "no
              hierarchy — the eye has nowhere to land first." */}
          {chip === null ? null : chip.kind === "bmi" ? (
            <Chip bmi title={chip.title}>
              {chip.label}
            </Chip>
          ) : (
            <Chip kind={chip.kind} title={chip.title}>
              {chip.label}
            </Chip>
          )}
          {lead.bmi.projectNumber ? (
            <span className="ref-num" title="BMI Office reference">
              {lead.bmi.projectNumber}
            </span>
          ) : null}
          {rb.kind === "waiting" ? (
            <Timer tone={rb.tone} icon={<IconClock {...ICON} />}>
              no touch · {formatMinutes(rb.minutes)}
            </Timer>
          ) : rb.kind === "touched" ? (
            <Timer tone={rb.tone} icon={<IconBolt {...ICON} />}>
              first touch {formatMinutes(rb.minutes)}
            </Timer>
          ) : null}
          {/* WHO OWNS IT, in words. `Avatar` falls back to a bare "?" with no
              initials, and on an unassigned deal that put an undecodable
              question mark between the project number and the centre — owner,
              2026-09-14: "A bare circular '?' avatar sits between the project
              number and the centre chip". An unowned deal is a fact worth
              stating plainly, and it is the one a director acts on. */}
          {lead.repName ? (
            <span className="owner-chip" title={`Owned by ${lead.repName}`}>
              <Avatar
                initials={initialsOf(lead.repName)}
                repSlug={lead.repSlug}
                name={lead.repName}
                sm
              />
              <span>{lead.repName}</span>
            </span>
          ) : (
            <Chip kind="warn" title="Nobody owns this deal yet">
              Unassigned
            </Chip>
          )}
          <Pill centre={lead.centre}>{centreShort(lead.centre)}</Pill>
        </div>
      </div>
      <div className="val">
        {/* THE HERO NUMBER IS NEVER AN EM DASH.
            It used to read "—" in the largest type on the screen with "no quote
            yet · 5 days out" beneath it — the biggest thing on the card
            carrying no information at all (owner, 2026-09-14). When there is
            money, the money leads. When there is not, the thing a planner
            actually wants is how long they have, so the countdown leads and the
            missing quote becomes the caption. */}
        {lead.valueCents ? (
          <>
            <div className="n">{money(lead.valueCents)}</div>
            <div className="s">
              quoted ·{" "}
              <b style={{ color: d <= 14 ? "var(--warn-ink)" : "inherit" }}>{d} days out</b>
            </div>
          </>
        ) : (
          <>
            <div className="n" style={{ color: d <= 14 ? "var(--warn-ink)" : undefined }}>
              {d} {d === 1 ? "day" : "days"}
            </div>
            <div className="s">out · no quote yet</div>
          </>
        )}
        <div className="hstack" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          {isDirector ? (
            <button type="button" className="btn btn-sm" onClick={onReassign}>
              <IconUsers {...ICON} /> {lead.rep ? "Reassign" : "Assign"}
            </button>
          ) : null}
          {bmiAction}
        </div>
      </div>
      <div className="stepper">
        {STEPS.map(([id, label], i) => (
          <div
            key={id}
            className={[
              "st",
              ix < 0 ? (i === 0 ? "lost" : "") : i < ix ? "done" : i === ix ? "cur" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <i />
            <span>{ix < 0 && i === 0 ? (status?.label ?? lead.status) : label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
