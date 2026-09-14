"use client";

import { EVENT_TEST_IDS, type EventRowView } from "~/features/crm/events/contracts";
import { moneyExact, pct } from "~/features/crm/core/format";
import { Chip } from "../primitives/Chip";
import { Meter } from "../primitives/Meter";
import { ICON } from "../primitives/icon-props";
import { PILL_TITLE, eventMetaParts, rowTint } from "./model";

/**
 * One `.row.evrow` on the Events board (`crm-events.js:251`): the BMI number,
 * the title and host, the meta line, then the money pill, the BMI state chip
 * and the collected/booked meter.
 *
 * EVERY row opens the deal drawer on the EVENT tab — the same drawer the
 * pipeline and the queue open — whether or not a `crm_leads` row exists yet.
 *
 * It used to have two shapes: clickable when a lead existed, and otherwise a
 * dead row with a "Create lead from event" button. That was backwards. No BMI
 * event has a lead until it is adopted, and the Event tab reads BMI directly,
 * so the row can show the booking perfectly well with no lead anywhere. Asking
 * a planner to create a sales lead in order to look at an event that already
 * exists is a question the screen should answer for itself, which is what
 * `onOpenEvent` now does.
 */
export interface EventRowProps {
  row: EventRowView;
  todayYmd: string;
  /** Opens the event. Creates the lead behind the scenes when there is none. */
  onOpenEvent: (row: EventRowView) => void;
}

/** `.row` is a grid; a <button> needs the UA's own chrome taken off it. */
const ROW_BUTTON: React.CSSProperties = {
  font: "inherit",
  color: "inherit",
  background: "none",
  border: 0,
  textAlign: "left",
  width: "100%",
  display: "grid",
};

export function EventRow({ row, todayYmd, onOpenEvent }: EventRowProps) {
  const tint = rowTint(row, todayYmd);
  const meta = eventMetaParts(row);
  const collectedPct = pct(row.collectedCents, row.totalCents);

  const body = (
    <>
      <span className="mono xs muted" style={{ width: 56 }}>
        {row.number || "—"}
      </span>
      <div>
        <div className="title">
          {row.title || row.personName || "Untitled event"}
          {row.personName && row.personName !== row.title ? (
            <span className="muted small">· {row.personName}</span>
          ) : null}
          {row.cancelled ? <Chip kind="lost">Cancelled</Chip> : null}
        </div>
        <div className="meta">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      </div>
      <div className="right">
        <Chip
          kind={row.pill.chip ?? undefined}
          bmi={row.pill.chip === null}
          title={row.pill.gfStatus ? undefined : (PILL_TITLE[row.pill.kind] ?? undefined)}
        >
          {row.pill.label}
        </Chip>
        {row.stateName ? (
          <Chip bmi title="BMI state">
            {row.stateName}
          </Chip>
        ) : null}
        {row.contract ? (
          <span style={{ width: 72 }}>
            <Meter
              pct={collectedPct}
              label={`${moneyExact(row.contract.collectedCents)} collected of ${moneyExact(
                row.contract.totalCents,
              )}`}
            />
          </span>
        ) : null}
      </div>
    </>
  );

  // EVERY row is clickable and every row opens the event. There is no second
  // shape for "no lead yet" — the screen creates one behind the scenes. See the
  // comment on `openEvent` in EventsScreen.tsx for why.
  return (
    <button
      type="button"
      className={["row", "evrow", tint].filter(Boolean).join(" ")}
      style={ROW_BUTTON}
      data-testid={EVENT_TEST_IDS.row(row.projectId)}
      onClick={() => onOpenEvent(row)}
      title={`Open ${row.number || "this event"}`}
    >
      {body}
    </button>
  );
}
