"use client";

import { CENTRE_LIST } from "~/features/crm/core/centres";
import type { CentreCode } from "~/features/crm/core/types";
import { AVAILABILITY_TEST_IDS } from "~/features/crm/availability/contracts";
import { DURATIONS } from "~/features/crm/availability/schemas";
import { Pill } from "../primitives/Pill";
import { durationLabel, startOptions } from "./model";
import type { DayBounds } from "~/features/crm/availability/pure";

/**
 * The request bar (`crm-shared.js:512-514`): start, length, and the lane count
 * the party size implies. Centre and date join them here because this screen
 * is also reachable WITHOUT a lead — a planner asking "what has Fort Myers got
 * a week on Saturday" needs to say which Saturday and which centre.
 *
 * Every control writes straight to the URL through the screen's `onChange`, so
 * the bar has no state of its own and a pasted link reproduces it exactly.
 */

export interface RequestBarProps {
  centre: CentreCode;
  date: string;
  start: number;
  dur: number;
  guests: number;
  need: number;
  bounds: DayBounds;
  busy: boolean;
  onChange: (patch: {
    centre?: CentreCode;
    date?: string;
    start?: number;
    dur?: number;
    guests?: number;
  }) => void;
}

export function RequestBar({
  centre,
  date,
  start,
  dur,
  guests,
  need,
  bounds,
  busy,
  onChange,
}: RequestBarProps) {
  const starts = startOptions(bounds);
  return (
    <div
      className="pad avail-request"
      data-testid={AVAILABILITY_TEST_IDS.requestBar}
      aria-busy={busy}
    >
      <span className="eyebrow">Request</span>

      <div className="field avail-field">
        <label htmlFor="avail-centre">Center</label>
        <select
          id="avail-centre"
          className="select"
          style={{ width: "auto" }}
          value={centre}
          onChange={(e) => onChange({ centre: e.target.value as CentreCode })}
        >
          {CENTRE_LIST.map((c) => (
            <option key={c.code} value={c.code}>
              {c.short}
            </option>
          ))}
        </select>
      </div>

      <div className="field avail-field">
        <label htmlFor="avail-date">Date</label>
        <input
          id="avail-date"
          className="input"
          style={{ width: "auto" }}
          type="date"
          value={date}
          onChange={(e) => onChange({ date: e.target.value })}
        />
      </div>

      <div className="field avail-field">
        <label htmlFor="avail-start">Start</label>
        <select
          id="avail-start"
          className="select"
          style={{ width: "auto" }}
          value={start}
          onChange={(e) => onChange({ start: Number(e.target.value) })}
        >
          {starts.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field avail-field">
        <label htmlFor="avail-dur">Length</label>
        <select
          id="avail-dur"
          className="select"
          style={{ width: "auto" }}
          value={dur}
          onChange={(e) => onChange({ dur: Number(e.target.value) })}
        >
          {DURATIONS.map((d) => (
            <option key={d} value={d}>
              {durationLabel(d)}
            </option>
          ))}
        </select>
      </div>

      <div className="field avail-field">
        <label htmlFor="avail-guests">Guests</label>
        <input
          id="avail-guests"
          className="input tabular"
          style={{ width: 90 }}
          type="number"
          min={1}
          max={2000}
          value={guests}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n > 0) onChange({ guests: Math.floor(n) });
          }}
        />
      </div>

      {/* Read-only: a <label> here would have no control to name. */}
      <div className="field avail-field">
        <span className="avail-caption">Lanes</span>
        <Pill>
          {need} for {guests} guests (6 per lane)
        </Pill>
      </div>
    </div>
  );
}
