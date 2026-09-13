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
}: DealHeaderProps) {
  const d = daysOutOf(lead, now);
  const chip = bmiChip(lead);
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
        <h2>{leadTitle(lead)}</h2>
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
          {chip.kind === "bmi" ? (
            <Chip bmi title={chip.title}>
              {chip.label}
            </Chip>
          ) : (
            <Chip kind={chip.kind} title={chip.title}>
              {chip.label}
            </Chip>
          )}
          {lead.bmi.projectNumber ? <Pill>{lead.bmi.projectNumber}</Pill> : null}
          {rb.kind === "waiting" ? (
            <Timer tone={rb.tone} icon={<IconClock {...ICON} />}>
              no touch · {formatMinutes(rb.minutes)}
            </Timer>
          ) : rb.kind === "touched" ? (
            <Timer tone={rb.tone} icon={<IconBolt {...ICON} />}>
              first touch {formatMinutes(rb.minutes)}
            </Timer>
          ) : null}
          <Avatar
            initials={
              lead.repName
                ? lead.repName
                    .split(/\s+/)
                    .map((p) => p[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()
                : undefined
            }
            repSlug={lead.repSlug}
            name={lead.repName ?? undefined}
            sm
          />
          <Pill centre={lead.centre}>{centreShort(lead.centre)}</Pill>
        </div>
      </div>
      <div className="val">
        <div className="n">{lead.valueCents ? money(lead.valueCents) : "—"}</div>
        <div className="s">
          {lead.valueCents ? "quoted" : "no quote yet"} ·{" "}
          <b style={{ color: d <= 14 ? "var(--warn-ink)" : "inherit" }}>{d} days out</b>
        </div>
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
