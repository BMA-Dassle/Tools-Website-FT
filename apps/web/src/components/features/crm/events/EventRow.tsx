"use client";

import { IconPlus } from "@tabler/icons-react";
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
 * A row with a CRM lead opens the deal drawer on the EVENT tab — the same
 * drawer the pipeline and the queue open. A row without one is a legacy
 * booking: it stays read-only and offers "Create lead from event" instead of
 * pretending there is a deal behind it.
 */
export interface EventRowProps {
  row: EventRowView;
  todayYmd: string;
  onOpenDeal: (publicId: string) => void;
  onCreateLead: (row: EventRowView) => void;
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

export function EventRow({ row, todayYmd, onOpenDeal, onCreateLead }: EventRowProps) {
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

  if (row.lead) {
    return (
      <button
        type="button"
        className={["row", "evrow", tint].filter(Boolean).join(" ")}
        style={ROW_BUTTON}
        data-testid={EVENT_TEST_IDS.row(row.projectId)}
        onClick={() => onOpenDeal(row.lead!.publicId)}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      className={["row", "evrow", tint].filter(Boolean).join(" ")}
      style={{ cursor: "default" }}
      data-testid={EVENT_TEST_IDS.row(row.projectId)}
    >
      {body}
      <div className="right" style={{ gridColumn: "1 / -1" }}>
        <button type="button" className="btn btn-sm" onClick={() => onCreateLead(row)}>
          <IconPlus {...ICON} /> Create lead from event
        </button>
      </div>
    </div>
  );
}
