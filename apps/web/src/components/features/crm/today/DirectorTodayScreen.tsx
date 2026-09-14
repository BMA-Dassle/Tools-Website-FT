"use client";

import Link from "next/link";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { CrmStatus } from "~/features/crm/core/types";
import { LEAD_TEST_IDS, type DirectorMyDay } from "~/features/crm/leads/contracts";
import { Avatar } from "../primitives/Avatar";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
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
          {/* The rules assign at capture, so this tile counts what they parked. */}
          <span className="xs muted">
            {view.tiles.unassigned ? "waiting for a decision" : "nothing parked"}
          </span>
        </Link>
        {/* Every tile goes somewhere. A figure a director cannot follow to the
            rows behind it is a dead end (owner: "why can't I click contracts
            out and other tiles"). */}
        <Tile
          label="Overdue across team"
          value={view.tiles.overdueTeam}
          actionLabel="Open the pipeline, overdue first"
          onClick={() => router.push(`${CRM_BASE}/pipeline?overdue=1`)}
        />
        <Tile
          label="Contracts out"
          value={view.tiles.contractsOut}
          actionLabel="Open contracts that are out and unsigned"
          onClick={() => router.push(`${CRM_BASE}/contracts?status=contract_sent&win=90`)}
        />
        <Tile
          label="Booked vs LY"
          value="—"
          sub={BOOKED_VS_LY_PENDING}
          className="tile-muted-value"
          actionLabel="Open the KPI dashboard"
          onClick={() => router.push(`${CRM_BASE}/kpi`)}
        />
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
