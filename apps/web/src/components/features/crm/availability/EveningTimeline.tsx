"use client";

import { IconCheck } from "@tabler/icons-react";
import { fmtMin, pctOf } from "~/features/crm/availability";
import {
  AVAILABILITY_TEST_IDS,
  type AvailabilityBounds,
  type AvailabilityPlacement,
  type AvailabilitySection,
  type LaneOccupancy,
} from "~/features/crm/availability/contracts";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { sectionView, windowBand } from "./model";

/**
 * The evening timeline (`crm-shared.js:498-509`): one row per lane, grouped by
 * section, with labelled bars for everything QAMF knows about and a band across
 * the requested window.
 *
 * Runs of lanes that are free the WHOLE evening collapse into a single band —
 * twenty-eight identical empty rows tell a planner nothing — and "Show every
 * lane" expands the section when they want the full grid. The control is a
 * button per section, exactly as the prototype has it, so it works by keyboard
 * and reads correctly to a screen reader.
 */

export interface EveningTimelineProps {
  sections: AvailabilitySection[];
  lanes: LaneOccupancy[];
  placement: AvailabilityPlacement | null;
  need: number;
  bounds: AvailabilityBounds;
  start: number;
  dur: number;
  expanded: Record<string, boolean>;
  onToggleSection: (name: string) => void;
}

export function EveningTimeline({
  sections,
  lanes,
  placement,
  need,
  bounds,
  start,
  dur,
  expanded,
  onToggleSection,
}: EveningTimelineProps) {
  const band = windowBand(start, dur, bounds);
  return (
    <div className="gantt" data-testid={AVAILABILITY_TEST_IDS.timeline}>
      <div className="g-axis">
        <div className="g-lab" />
        <div className="g-track">
          {bounds.ticks.map((t) => (
            <span key={t} style={{ left: `${pctOf(t, bounds)}%` }}>
              {fmtMin(t).replace(":00", "")}
            </span>
          ))}
        </div>
      </div>

      <div
        className="g-win"
        style={{
          left: `calc(var(--lab) + (100% - var(--lab)) * ${band.left / 100})`,
          width: `calc((100% - var(--lab)) * ${band.width / 100})`,
        }}
      />

      {sections.map((section) => {
        const view = sectionView({
          section,
          lanes,
          placement,
          need,
          bounds,
          expanded: expanded[section.name] === true,
        });
        const isExpanded = expanded[section.name] === true;
        return (
          <div className="g-sec" key={section.name}>
            <div className="g-sec-h">
              <b>{view.name}</b>
              <span className="muted small">{view.rangeLabel}</span>
              <Chip kind={view.chipKind}>
                {view.free} of {view.total} free in the window
              </Chip>
              {view.contiguous ? (
                <span className="xs muted">contiguous: {view.contiguous}</span>
              ) : null}
            </div>

            {view.rows.map((row) =>
              row.type === "lane" ? (
                <div className={`g-row${row.picked ? " picked" : ""}`} key={`lane-${row.lane}`}>
                  <div className="g-lab">
                    {row.lane}
                    {row.picked ? (
                      <span className="g-pick">
                        <IconCheck {...ICON} />
                      </span>
                    ) : null}
                  </div>
                  <div className="g-track">
                    {row.bars.map((bar) => (
                      <div
                        key={`${bar.start}-${bar.end}-${bar.label}`}
                        className={`g-block ${bar.kind}`}
                        style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                        title={bar.title}
                      >
                        <span>{bar.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="g-row free" key={`free-${row.lanes[0]}`}>
                  <div className="g-lab">
                    {row.lanes.length === 1
                      ? row.lanes[0]
                      : `${row.lanes[0]}–${row.lanes[row.lanes.length - 1]}`}
                  </div>
                  <div className="g-track free-track">
                    <span>{row.label}</span>
                  </div>
                </div>
              ),
            )}

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={isExpanded}
              onClick={() => onToggleSection(section.name)}
            >
              {isExpanded ? "Collapse free lanes" : "Show every lane"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
