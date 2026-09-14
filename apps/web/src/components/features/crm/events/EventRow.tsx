"use client";

import { EVENT_TEST_IDS, type EventRowView } from "~/features/crm/events/contracts";
import { moneyExact, pct } from "~/features/crm/core/format";
import { Chip } from "../primitives/Chip";
import { Meter } from "../primitives/Meter";
import { Pill } from "../primitives/Pill";
import { centreShort } from "../leads/LeadCard";
import { PILL_TITLE, contractJumpTitle, eventMetaParts, rowTint } from "./model";

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
 *
 * THE MONEY PILL IS THE CONTRACT. Owner, 2026-09-13: "Contracts should be more
 * intergrated to events." The pill already said where the contract stands —
 * PAID · DEPOSIT · UNSIGNED · its GF status · "no contract" — but it was a dead
 * label, so the only way from an event to its contract was to remember the
 * event number and go and search the Contracts board for it. It is now the jump:
 * same drawer, Contract tab. When there is no contract there is nothing to open
 * and the pill stays a plain chip that says so.
 *
 * The row is no longer itself a <button> — it carries one now, and a button
 * inside a button is invalid HTML. The title is the real control and
 * `.card-open` stretches it over the row, so clicking anywhere still opens the
 * event and the pill still opens the contract.
 */
export interface EventRowProps {
  row: EventRowView;
  todayYmd: string;
  /** Opens the event. Creates the lead behind the scenes when there is none. */
  onOpenEvent: (row: EventRowView) => void;
  /** Opens the same deal on the Contract tab. Only called when `row.contract`. */
  onOpenContract: (row: EventRowView) => void;
  /**
   * Print the row's centre. True only on the "All" board — on a board already
   * filtered to one centre, repeating its name down every row is noise.
   * Owner, 2026-09-14: "Do we add a small pill with the lcoation when in 'all'
   * mode?"
   */
  showCentre?: boolean;
}

export function EventRow({
  row,
  todayYmd,
  onOpenEvent,
  onOpenContract,
  showCentre,
}: EventRowProps) {
  const tint = rowTint(row, todayYmd);
  const meta = eventMetaParts(row);
  const collectedPct = pct(row.collectedCents, row.totalCents);
  const title = row.title || row.personName || "Untitled event";
  // Inside the jump button the help text rides on the BUTTON's tooltip, so a
  // chip nested in it does not carry a second, competing `title`.
  const pillHelp = row.pill.gfStatus ? undefined : (PILL_TITLE[row.pill.kind] ?? undefined);

  const pill = (
    <Chip
      kind={row.pill.chip ?? undefined}
      bmi={row.pill.chip === null}
      title={row.contract ? undefined : pillHelp}
    >
      {row.pill.label}
    </Chip>
  );

  return (
    <div
      className={["row", "evrow", "row-click", tint].filter(Boolean).join(" ")}
      data-testid={EVENT_TEST_IDS.row(row.projectId)}
    >
      <span className="mono xs muted" style={{ width: 56 }}>
        {row.number || "—"}
      </span>
      <div>
        <div className="title">
          {/* The row's primary action. `.card-open` covers the whole row. */}
          <button
            type="button"
            className="card-open"
            onClick={() => onOpenEvent(row)}
            title={`Open ${row.number || "this event"}`}
          >
            {title}
          </button>
          {row.personName && row.personName !== row.title ? (
            <span className="muted small">· {row.personName}</span>
          ) : null}
          {row.cancelled ? <Chip kind="lost">Cancelled</Chip> : null}
        </div>
        <div className="meta">
          {/* First on the line, because on a mixed board "where" is the thing
              that sorts one row from the next. */}
          {showCentre ? <Pill centre={row.centre}>{centreShort(row.centre)}</Pill> : null}
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      </div>
      <div className="right">
        {row.contract ? (
          <button
            type="button"
            className="chip-button"
            data-testid={EVENT_TEST_IDS.contractJump(row.projectId)}
            onClick={() => onOpenContract(row)}
            title={contractJumpTitle(row)}
          >
            {pill}
          </button>
        ) : (
          pill
        )}
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
    </div>
  );
}
