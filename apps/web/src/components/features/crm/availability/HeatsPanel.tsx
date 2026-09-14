"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import { AVAILABILITY_TEST_IDS, type HeatsResponse } from "~/features/crm/availability/contracts";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { EmptyState } from "../primitives/States";
import { heatsPanelState } from "./model";

/**
 * FastTrax karting (`crm-shared.js:534`, the builder's heat grid), read-only.
 *
 * FastTrax has no bowling grid in QAMF at all, so the lane engine has nothing
 * to say about it; capacity lives in Office's `dayPlanner` as 12-minute heats.
 * This panel shows what is free and which run of back-to-back heats would take
 * the party. It does not book one — that is the builder's job (C5), and Office
 * refuses an overbooking with a 403 that C5 renders as "heat full" rather than
 * an error.
 */

export interface HeatsPanelProps {
  data: HeatsResponse;
  onSelectResource: (resourceId: string) => void;
}

function heatClass(freePlaces: number, capacity: number): string {
  if (freePlaces <= 0) return "full";
  return freePlaces < Math.max(1, Math.round(capacity / 2)) ? "low" : "ok";
}

export function HeatsPanel({ data, onSelectResource }: HeatsPanelProps) {
  const selected = data.resources.find((r) => r.resourceId === data.selectedResourceId) ?? null;
  const runStarts = new Set((data.firstRun ?? []).map((b) => b.start));
  // An Office outage is NOT "the centre has published no day planner". The
  // route took care to produce an honest sentence; say it, and keep the empty
  // state for a read that genuinely came back with no heats.
  const state = heatsPanelState(data);

  return (
    <div className="card" data-testid={AVAILABILITY_TEST_IDS.heats}>
      <div className="card-h">
        <h2>Heats</h2>
        <div className="right">
          {selected ? <span className="pill">capacity {selected.capacity}</span> : null}
        </div>
      </div>

      <div className="pad stack">
        {state === "unavailable" ? (
          <Banner tone="crit" icon={<IconAlertTriangle {...ICON} />}>
            {data.error}
          </Banner>
        ) : null}

        {data.resources.length > 1 ? (
          <div className="field avail-field">
            <label htmlFor="avail-resource">Resource</label>
            <select
              id="avail-resource"
              className="select"
              style={{ width: "auto" }}
              value={data.selectedResourceId ?? ""}
              onChange={(e) => onSelectResource(e.target.value)}
            >
              {data.resources.map((r) => (
                <option key={r.resourceId} value={r.resourceId}>
                  {r.resourceName}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {selected && selected.capacity > 0 ? (
          <div className="small muted">
            {data.guests} racers need {data.heatsNeeded} heats of {selected.capacity}. The first run
            of back-to-back heats with room for them is highlighted.
          </div>
        ) : null}

        {data.firstRun && data.firstRun.length > 0 ? (
          <div className="hstack">
            <Chip kind="won">
              Fits from {data.firstRun[0].label} · {data.firstRun.length} heats
            </Chip>
          </div>
        ) : selected ? (
          <div className="hstack">
            <Chip kind="warn">No run of back-to-back heats has room for {data.guests} racers</Chip>
          </div>
        ) : null}

        {state === "grid" && selected ? (
          <div className="heatgrid">
            {selected.blocks.map((b) => (
              <div
                key={b.start}
                className={`heat ${heatClass(b.freePlaces, b.capacity)}${runStarts.has(b.start) ? " pick" : ""}`}
              >
                <b>{b.label}</b>
                <small>
                  {b.freePlaces === 0 ? "Full" : `${b.freePlaces} of ${b.capacity} free`}
                </small>
                <span className="cap">
                  <i
                    style={{
                      width: `${b.capacity > 0 ? Math.round((b.freePlaces / b.capacity) * 100) : 0}%`,
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
        ) : state === "empty" ? (
          <EmptyState>
            No heats are published for this day yet. Check the center&rsquo;s Office day planner.
          </EmptyState>
        ) : null}

        {state === "unavailable" ? null : (
          <div className="xs muted">
            Availability from Office dayPlanner (live). Full heats are greyed; Office refuses
            overbooking with a 403 and the CRM shows it as &ldquo;heat full&rdquo; rather than an
            error.
          </div>
        )}
      </div>
    </div>
  );
}
