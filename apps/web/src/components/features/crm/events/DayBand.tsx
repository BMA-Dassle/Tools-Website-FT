"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import {
  EVENT_TEST_IDS,
  type EventDayBand,
  type EventRowView,
} from "~/features/crm/events/contracts";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { EventRow } from "./EventRow";
import { bandMoney, bandSummary, bandTitle } from "./model";

/**
 * One day of the board (`crm-events.js:250`): a card whose header is the day,
 * the event count, the persons and `collected / booked`, and whose body is the
 * rows. A day BMI could not be read says so — an empty band and "no group
 * events" would be a lie.
 */
export interface DayBandProps {
  band: EventDayBand;
  todayYmd: string;
  /** Opens the event; the screen creates the lead behind the scenes. */
  onOpenEvent: (row: EventRowView) => void;
  /** Opens the same deal on the Contract tab, from the row's money pill. */
  onOpenContract: (row: EventRowView) => void;
  /** Passed straight through: only the "All" board prints a centre. */
  showCentre?: boolean;
}

export function DayBand({ band, todayYmd, onOpenEvent, onOpenContract, showCentre }: DayBandProps) {
  return (
    <div className="card" data-testid={EVENT_TEST_IDS.band(band.date)}>
      <div className="card-h" style={{ padding: "10px 16px" }}>
        <h2 style={{ fontSize: 13 }}>{bandTitle(band)}</h2>
        <div className="right xs muted">
          {bandSummary(band)}
          {band.events.length > 0 && !band.error ? (
            <>
              {" · "}
              <span className="mono">{bandMoney(band)}</span>
            </>
          ) : null}
        </div>
      </div>
      {band.error ? (
        <div className="pad">
          <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
            BMI could not be read for this day — {band.error}
          </Banner>
        </div>
      ) : null}
      {band.events.length > 0 ? (
        <div className="list">
          {band.events.map((row) => (
            <EventRow
              key={row.projectId}
              row={row}
              todayYmd={todayYmd}
              onOpenEvent={onOpenEvent}
              onOpenContract={onOpenContract}
              showCentre={showCentre}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
