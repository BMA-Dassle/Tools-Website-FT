"use client";

import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { CrmStatus } from "~/features/crm/core/types";
import { LEAD_TEST_IDS, type DirectorMyDay } from "~/features/crm/leads/contracts";
import { Avatar } from "../primitives/Avatar";
import { Tile } from "../primitives/Tile";
import { LeadCard } from "../leads/LeadCard";

/**
 * `directorToday()` (direction-b.html): the tiles — Unassigned (a link to the
 * queue with the sweep countdown), Overdue across team, Contracts out — and
 * one lane per selling rep with their next five due items as cards with the
 * hover rails.
 *
 * "Booked vs LY" needs the KPI PR's numbers. It ships as an empty, labelled
 * tile rather than being dropped, so a director can tell "not built yet" from
 * "nothing to show" — the same honest degradation as the queue's
 * "No auto-pick yet".
 */
const BOOKED_VS_LY_PENDING = "Arrives with the KPI PR";
export interface DirectorTodayScreenProps {
  view: DirectorMyDay;
  now: Date;
  statuses: Map<string, CrmStatus>;
  onOpen: (publicId: string) => void;
}

export function DirectorTodayScreen({ view, now, statuses, onOpen }: DirectorTodayScreenProps) {
  return (
    <div className="stack" style={{ gap: 16 }} data-testid={LEAD_TEST_IDS.myDay}>
      <div>
        <h2 style={{ fontSize: 18, margin: 0 }}>{view.greeting}</h2>
        <div className="sub muted small">{view.dateLabel} · the team&apos;s board</div>
      </div>
      <div className="grid grid-4">
        <Link href={`${CRM_BASE}/queue`} className="tile" style={{ textDecoration: "none" }}>
          <span className="label">Unassigned</span>
          <span
            className="value"
            style={{ color: view.tiles.unassigned ? "var(--crit-ink)" : undefined }}
          >
            {view.tiles.unassigned}
          </span>
          <span className="xs muted">
            {view.autoAssignInMinutes != null
              ? `auto-assign in ${view.autoAssignInMinutes} min`
              : "nothing waiting"}
          </span>
        </Link>
        <Tile label="Overdue across team" value={view.tiles.overdueTeam} />
        <Tile label="Contracts out" value={view.tiles.contractsOut} />
        <div className="tile" data-testid={LEAD_TEST_IDS.directorBookedVsLy}>
          <span className="label">Booked vs LY</span>
          <span className="value muted">—</span>
          <span className="xs muted">{BOOKED_VS_LY_PENDING}</span>
        </div>
      </div>
      <div className="swim">
        {view.lanes.map((lane) => (
          <div key={lane.rep.id} data-testid={LEAD_TEST_IDS.directorLane(lane.rep.slug)}>
            <div className="lane-h">
              <Avatar
                initials={lane.rep.initials}
                repSlug={lane.rep.slug}
                name={lane.rep.displayName}
                sm
              />
              {lane.rep.displayName}
              <span className="muted small">· {lane.overdue} overdue</span>
            </div>
            <div className="board lane-board">
              {lane.due.length === 0 ? (
                <div className="empty">Clear</div>
              ) : (
                lane.due.map((l) => (
                  <LeadCard
                    key={l.id}
                    lead={l}
                    status={statuses.get(l.status)}
                    now={now}
                    onOpen={onOpen}
                    hideRep
                  />
                ))
              )}
            </div>
          </div>
        ))}
        {view.lanes.length === 0 ? (
          <div className="empty">No selling reps on the roster yet.</div>
        ) : null}
      </div>
    </div>
  );
}
