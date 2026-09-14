"use client";

import { IconEdit, IconExternalLink, IconLink, IconStack2 } from "@tabler/icons-react";
import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDate, fStamp } from "~/features/crm/core/dates";
import { centreByCode } from "~/features/crm/core/centres";
import { dealLinks } from "~/features/crm/deals/links";
import { LEAD_SOURCE_LABEL, type LeadView } from "~/features/crm/leads/contracts";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Kv } from "../primitives/Kv";
import { bmiChip, leadName } from "../leads/model";
import type { LeadDetail } from "./tabs";

const PREFERS: Record<string, string> = { text: "Text", call: "Call", email: "Email" };
const REASON: Record<string, string> = {
  manual: "by hand",
  reassign: "reassigned",
  rule: "by rule",
  auto: "by the sweep",
  release: "released to the queue",
};

/**
 * `dealRail(l)` (crm-shared.js:312): Contact, the BMI project, the hand-offs
 * (with their BMI responsible sync), and the links to the availability grid
 * and the builder. The products table, the mini availability and the
 * collateral picks come with B1 / C4 / C6 and are not imitated here.
 */
export interface DealRailProps {
  detail: LeadDetail;
  onEdit: (thenMint: boolean) => void;
}

export function DealRail({ detail, onEdit }: DealRailProps) {
  const { lead, assignments } = detail;
  const chip = bmiChip(lead);
  return (
    <>
      <div className="card">
        <div className="card-h">
          <h2>Contact</h2>
          <div className="right">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Edit contact"
              onClick={() => onEdit(false)}
            >
              <IconEdit {...ICON} />
            </button>
          </div>
        </div>
        <div className="pad">
          <Kv
            rows={[
              { key: "name", label: "Name", value: leadName(lead) },
              {
                key: "phone",
                label: "Phone",
                value: lead.guest.phone ? (
                  <a href={`tel:${lead.guest.phone}`} className="strong">
                    {lead.guest.phone}
                  </a>
                ) : (
                  "—"
                ),
              },
              {
                key: "email",
                label: "Email",
                value: lead.guest.email ? (
                  <a href={`mailto:${lead.guest.email}`}>{lead.guest.email}</a>
                ) : (
                  "—"
                ),
              },
              ...(lead.guest.company
                ? [{ key: "biz", label: "Business", value: lead.guest.company }]
                : []),
              {
                key: "prefers",
                label: "Prefers",
                value: lead.guest.prefers ? PREFERS[lead.guest.prefers] : "—",
              },
              { key: "source", label: "Source", value: LEAD_SOURCE_LABEL[lead.source] },
            ]}
          />
        </div>
      </div>

      <DealLinksCard lead={lead} />

      <div className="card">
        <div className="card-h">
          <h2>
            {lead.bmi.projectNumber ? `BMI project ${lead.bmi.projectNumber}` : "BMI project"}
          </h2>
          <div className="right">
            {lead.bmi.projectId ? (
              <Link className="btn btn-sm" href={`${CRM_BASE}/builder/${lead.publicId}`}>
                <IconStack2 {...ICON} /> Edit
              </Link>
            ) : null}
          </div>
        </div>
        <div className="pad stack">
          <div className="hstack">
            {chip.kind === "bmi" ? (
              <Chip bmi title={chip.title}>
                {chip.label}
              </Chip>
            ) : (
              <Chip kind={chip.kind} title={chip.title}>
                {chip.label}
              </Chip>
            )}
            {lead.mintStatus === "failed" && lead.mintError ? (
              <span className="xs" style={{ color: "var(--crit-ink)" }}>
                {lead.mintError}
              </span>
            ) : null}
          </div>
          {lead.bmi.projectId ? (
            <Kv
              rows={[
                {
                  key: "id",
                  label: "Project id",
                  value: <span className="mono">{lead.bmi.projectId}</span>,
                },
                ...(lead.bmi.personId
                  ? [
                      {
                        key: "pid",
                        label: "Person id",
                        value: <span className="mono">{lead.bmi.personId}</span>,
                      },
                    ]
                  : []),
                {
                  key: "sync",
                  label: "Synced",
                  value: lead.bmi.syncedAt ? fStamp(lead.bmi.syncedAt) : "—",
                },
              ]}
            />
          ) : lead.mintStatus === "none" && !lead.isProspect ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onEdit(true)}>
              Complete to create in BMI
            </button>
          ) : (
            <div className="muted small">No project yet.</div>
          )}
          <div className="xs muted">
            Products and schedules from Office arrive with the BMI mirror.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Hand-offs</h2>
          <div className="right">
            <span className="pill">{assignments.length}</span>
          </div>
        </div>
        <div className="list">
          {assignments.length === 0 ? (
            <div className="empty">Not assigned yet — waiting in the queue.</div>
          ) : (
            assignments.map((a) => (
              <div key={a.id} className="row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
                <Avatar
                  initials={
                    a.toRepName
                      ? a.toRepName
                          .split(/\s+/)
                          .map((p) => p[0])
                          .join("")
                          .slice(0, 2)
                          .toUpperCase()
                      : undefined
                  }
                  repSlug={a.toRepSlug}
                  name={a.toRepName ?? undefined}
                  sm
                />
                <div>
                  <div className="title">
                    {a.toRepName ?? "Queue"}{" "}
                    <span className="muted small">· {REASON[a.reason] ?? a.reason}</span>
                  </div>
                  <div className="meta">
                    <span>{fStamp(a.createdAt)}</span>
                    <span>{a.actorEmail}</span>
                    {a.note ? <span>“{a.note}”</span> : null}
                  </div>
                </div>
                <div className="right">
                  {a.toRepId ? (
                    a.bmiResponsibleSyncedAt ? (
                      <Chip
                        bmi
                        title={`Office responsible verified ${fStamp(a.bmiResponsibleSyncedAt)}`}
                      >
                        BMI · responsible
                      </Chip>
                    ) : (
                      <Chip kind="warn" title="The Office responsible has not been updated yet">
                        BMI · pending
                      </Chip>
                    )
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Availability · {fDate(lead.eventDate)}</h2>
          <div className="right">
            <Link className="btn btn-sm" href={`${CRM_BASE}/availability/${lead.publicId}`}>
              Full grid
            </Link>
          </div>
        </div>
        <div className="pad xs muted">
          Live lanes and heats from QAMF and Office open on the full grid.
        </div>
      </div>
    </>
  );
}

/**
 * Every page a planner might need to open FOR a guest.
 *
 * Owner, 2026-09-13: "We should have links to customer confirmation page,
 * waiver page for customer, latest contract, contract history, etc. etc."
 * Each of these already existed and was already linked from some email; what
 * was missing was anywhere in the CRM that gathered them.
 *
 * Copy, don't just open: a planner needs the URL to paste into a text far more
 * often than they need to look at the page themselves. `navigator.clipboard`
 * is not available on an insecure origin or in some embedded browsers, so the
 * link stays an ordinary anchor and copying is the extra, not the only, way.
 */
function DealLinksCard({ lead }: { lead: LeadView }) {
  const links = dealLinks({
    publicId: lead.publicId,
    centre: lead.centre,
    contract: lead.contract,
    bmiProjectId: lead.bmi.projectId,
    locationId: centreByCode(lead.centre).locationId,
  });
  return (
    <div className="card">
      <div className="card-h">
        <h2>Links</h2>
      </div>
      <div className="pad">
        <ul className="link-list">
          {links.map((l) => (
            <li key={l.id}>
              <Link
                className="ll-a"
                href={l.href}
                {...(l.audience === "guest" ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {l.audience === "guest" ? <IconExternalLink {...ICON} /> : <IconLink {...ICON} />}
                <span className="ll-t">{l.label}</span>
              </Link>
              <div className="ll-h">{l.hint}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
