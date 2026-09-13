"use client";

import type { ContractRow as Row } from "~/features/crm/contracts/contracts";
import { CONTRACT_TEST_IDS } from "~/features/crm/contracts/contracts";
import { money } from "~/features/crm/core/format";
import { GF_STATUS_META } from "~/features/crm/core/types";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { DateBlock } from "../primitives/DateBlock";
import { depositCell, rowMeta } from "./model";

/**
 * One `<tr>` of the contracts table (crm-events.js:222), plus the week band
 * the prototype inserts ahead of the first row of each week.
 *
 * THE WHOLE ROW OPENS THE CONTRACT. The prototype made the row clickable with
 * `data-act`; a `<tr class="click">` with an onClick is invisible to a keyboard
 * and to a screen reader, so the Event cell carries a real button that the row
 * simply forwards to — the pointer behaviour is identical, and Tab / Enter now
 * work.
 */
export interface ContractRowProps {
  row: Row;
  weekHeader: string | null;
  columns: number;
  onOpen: (row: Row) => void;
  /** Shown only for a director on a `pending_approval` row. */
  onApprove: ((row: Row) => void) | null;
}

export function ContractTableRow({
  row,
  weekHeader,
  columns,
  onOpen,
  onApprove,
}: ContractRowProps) {
  const meta = GF_STATUS_META[row.status];
  const deposit = depositCell(row);
  const crit = row.reasons.some((r) => r.k === "crit");
  const key = row.shortId ?? row.quoteId;

  return (
    <>
      {weekHeader ? (
        <tr className="wk">
          <td colSpan={columns}>{weekHeader}</td>
        </tr>
      ) : null}
      <tr data-testid={CONTRACT_TEST_IDS.row(key)}>
        <td>
          <div className="hstack" style={{ gap: 8 }}>
            <DateBlock date={row.eventDate} daysOut={row.daysOut} />
            <div>
              <button type="button" className="link-cell strong" onClick={() => onOpen(row)}>
                {row.title}
              </button>
              <div className="xs muted">{rowMeta(row)}</div>
            </div>
          </div>
        </td>
        <td>
          <div>{row.guestName}</div>
          {row.guestPhone ? <div className="xs muted">{row.guestPhone}</div> : null}
        </td>
        <td>
          <Chip kind={meta.kind} title={meta.help}>
            {meta.label}
          </Chip>
          {row.reasons.length ? (
            <div
              className="xs"
              style={{ marginTop: 3, color: crit ? "var(--crit-ink)" : "var(--warn-ink)" }}
            >
              {row.reasons.map((r) => r.t).join(" · ")}
            </div>
          ) : null}
        </td>
        <td className="num">{money(row.totalCents)}</td>
        <td className="num" style={deposit.paid ? { color: "var(--good-ink)" } : undefined}>
          {deposit.text}
        </td>
        <td
          className="num"
          style={{ color: row.balanceCents ? "var(--warn-ink)" : "var(--good-ink)" }}
        >
          {money(row.balanceCents)}
        </td>
        <td>
          {row.rep ? (
            <Avatar initials={row.rep.initials} repSlug={row.rep.slug} name={row.rep.displayName} />
          ) : (
            <span className="xs muted">{row.plannerName ?? "—"}</span>
          )}
        </td>
        <td>
          <span className="hstack" style={{ justifyContent: "flex-end" }}>
            {onApprove && row.status === "pending_approval" ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => onApprove(row)}
              >
                Approve
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={() => onOpen(row)}>
              View
            </button>
          </span>
        </td>
      </tr>
    </>
  );
}
