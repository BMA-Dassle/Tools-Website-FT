"use client";

import { IconAlertTriangle, IconBolt, IconCalendarTime, IconTrash } from "@tabler/icons-react";
import {
  BUILDER_TEST_IDS,
  lineTotalCents,
  type OfficeOnlyLine,
  type QuoteLine,
} from "~/features/crm/bmi/contracts";
import { moneyExact } from "~/features/crm/core/format";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Table } from "../primitives/Table";
import { EmptyState } from "../primitives/States";
import { canForceLine, lineErrorText, linesCaption, liveLines, statusChip } from "./model";

/**
 * The quote itself — one row per `crm_quote_lines` row, with what Office made
 * of it beside each one.
 *
 * THE ROWS ARE OURS, NOT OFFICE'S. Neon is the source of truth: a line the rep
 * added is here whether or not Office ever took it, and the chip says which.
 * That is the whole point of recording the intent first — an Office outage
 * costs a retry, never the quote.
 *
 * A refused line shows OFFICE'S OWN WORDS ("Total persons (12) is higher than
 * the capacity (0) in HP Arena…"), because they name the heat and the shortfall
 * better than any sentence written over the top of them.
 */

export interface QuoteLinesProps {
  lines: QuoteLine[];
  /**
   * Product rows that are ON the Office project but were not written by the
   * CRM — almost everything, for any event booked before the CRM existed.
   *
   * Owner, 2026-09-14, on a project whose banner named two lines while the
   * table said it was empty: "wy did it not pull in items". They were being
   * computed, named in a warning, and then thrown away instead of shown.
   */
  officeOnly?: readonly OfficeOnlyLine[];
  canForce: boolean;
  busy: boolean;
  onRetry: (lineId: string) => void;
  onRemove: (lineId: string) => void;
  onSchedule: (line: QuoteLine) => void;
}

const COLUMNS = [
  { key: "product", label: "Product" },
  { key: "qty", label: "Qty", num: true },
  { key: "price", label: "Each", num: true },
  { key: "total", label: "Total", num: true },
  { key: "state", label: "In BMI" },
  { key: "actions", label: <span className="sr-only">Actions</span> },
];

export function QuoteLines({
  lines,
  officeOnly = [],
  canForce,
  busy,
  onRetry,
  onRemove,
  onSchedule,
}: QuoteLinesProps) {
  const rows = liveLines(lines);

  // Empty only when NEITHER side has anything. A project built in Office is
  // not an empty quote — saying so was the bug.
  if (rows.length === 0 && officeOnly.length === 0) {
    return (
      <EmptyState>
        Nothing on this quote yet. Add a product below, or start from a template.
      </EmptyState>
    );
  }

  return (
    <Table
      columns={COLUMNS}
      caption={linesCaption(lines)}
      testId={BUILDER_TEST_IDS.lines}
      className="builder-lines"
    >
      {rows.map((line) => {
        const chip = statusChip(line.status);
        const error = lineErrorText(line);
        const scheduled = line.scheduleBlocks.length;
        return (
          <tr key={line.id}>
            <td>
              <div className="stack" style={{ gap: 2 }}>
                <span className="strong">{line.nameOverride ?? line.productName}</span>
                {scheduled > 0 ? (
                  <span className="xs muted">
                    {scheduled === 1 ? "1 block" : `${scheduled} blocks`} scheduled
                  </span>
                ) : null}
                {error ? (
                  <span
                    className="xs"
                    style={{ color: "var(--crit-ink)" }}
                    data-testid={BUILDER_TEST_IDS.officePrompt}
                  >
                    <IconAlertTriangle {...ICON} /> {error}
                  </span>
                ) : null}
              </div>
            </td>
            <td className="num">{line.quantity}</td>
            <td className="num money">{moneyExact(line.pricePerUnitCents)}</td>
            <td className="num money">{moneyExact(lineTotalCents(line))}</td>
            <td>
              <Chip kind={chip.kind} title={chip.title}>
                {chip.label}
              </Chip>
            </td>
            <td>
              <div className="hstack" style={{ flexWrap: "nowrap", gap: 4 }}>
                {line.status === "written" ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => onSchedule(line)}
                    disabled={busy}
                    title="Put this line on heats or lanes"
                  >
                    <IconCalendarTime {...ICON} />
                    <span className="lbl">Schedule</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onRetry(line.id)}
                    disabled={busy}
                    title="Send this line to BMI again"
                  >
                    <IconBolt {...ICON} />
                    <span className="lbl">
                      {canForceLine(line, canForce) ? "Retry" : "Send to BMI"}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => onRemove(line.id)}
                  disabled={busy}
                  title="Take this line off the quote"
                >
                  <IconTrash {...ICON} />
                  <span className="sr-only">Remove {line.productName}</span>
                </button>
              </div>
            </td>
          </tr>
        );
      })}

      {/*
        OFFICE'S OWN LINES, SHOWN AS LINES.
        These are products on the project that the CRM did not write — every
        line of any event booked before the CRM existed. They used to be
        computed, named in a warning banner, and then dropped, so a fully built
        event read "Nothing on this quote yet" above a banner listing its
        contents. Owner, 2026-09-14: "wy did it not pull in items".
        READ-ONLY, deliberately. The one-writer rule is about not CLOBBERING
        Office, so showing them costs nothing and hiding them cost everything —
        but the CRM has no record of what it did not write, so it must not
        offer to retry, reschedule or delete them. The row says where it came
        from and points at Office for edits.
      */}
      {officeOnly.map((line) => {
        const name = line.name ?? `Product ${line.productId ?? "?"}`;
        return (
          <tr key={`office-${line.bmiProjectProductId}`} className="office-line">
            <td>
              {line.name ?? `Product ${line.productId ?? "?"}`}
              <span className="xs muted" style={{ display: "block" }}>
                Added in Office — edit it there
              </span>
            </td>
            <td className="num">{line.quantity ?? "—"}</td>
            <td className="num money">—</td>
            <td className="num money">
              {line.totalCents === null ? "—" : moneyExact(line.totalCents)}
            </td>
            <td>
              <Chip bmi title={`Office projectProduct ${line.bmiProjectProductId}`}>
                In BMI
              </Chip>
            </td>
            {/* No actions: the CRM did not write this line, so it must not
                offer to retry, reschedule or delete it. The cell says that
                rather than being an unexplained blank in the actions column. */}
            <td>
              <span className="sr-only">No actions — {name} was added in Office</span>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}
