"use client";

import { IconCalendarEvent } from "@tabler/icons-react";
import Link from "next/link";
import type { ContractRow as Row } from "~/features/crm/contracts/contracts";
import { CONTRACT_TEST_IDS } from "~/features/crm/contracts/contracts";
import { money } from "~/features/crm/core/format";
import { eventDayHref } from "~/features/crm/core/nav";
import { GF_STATUS_META } from "~/features/crm/core/types";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { DateBlock } from "../primitives/DateBlock";
import { ICON } from "../primitives/icon-props";
import { contractRowMeta, depositCell, eventJumpTitle } from "./model";

/**
 * One `<tr>` of the contracts table (crm-events.js:222), plus the week band
 * the prototype inserts ahead of the first row of each week.
 *
 * THE WHOLE ROW OPENS THE CONTRACT. The prototype made the row clickable with
 * `data-act`; a `<tr class="click">` with an onClick is invisible to a keyboard
 * and to a screen reader, so the Event cell carries a real button that the row
 * simply forwards to — the pointer behaviour is identical, and Tab / Enter now
 * work.
 *
 * AND THE ROW REACHES THE EVENT. Owner, 2026-09-13: "Contracts should be more
 * intergrated to events." A contract IS an event, seen from the money side, and
 * the one question this board could not answer was "what day is this, and what
 * else is on that day?" The Event control opens the Events board on the day the
 * event happens, where the same booking appears as a row — and from there its
 * money pill comes straight back here. Two lenses on one record, one click
 * apart in both directions.
 *
 * It is a LINK, not a drawer: most group-event contracts predate the CRM and
 * have no lead to open, and the Events board reads BMI directly, so it can show
 * them all. Rows whose centre or date the database cannot name get a disabled
 * control that says so rather than a link to an arbitrary day.
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
  const eventHref = eventDayHref(row);

  return (
    <>
      {weekHeader ? (
        <tr className="wk">
          <td colSpan={columns}>{weekHeader}</td>
        </tr>
      ) : null}
      {/* The row forwards to the same button the Event cell carries, so the
          pointer behaviour the prototype had is back WITHOUT making the row
          itself the control — a `<tr onClick>` is invisible to a keyboard and
          to a screen reader. Documented here since B5 and never actually
          wired; owner, 2026-09-14: "whole row should be clickable".

          A click that started on something interactive is left alone, or the
          Event / View / Approve buttons and the guest's phone link would all
          also open the contract. `closest` rather than a target check, because
          the press usually lands on the icon or the label inside the button. */}
      <tr
        data-testid={CONTRACT_TEST_IDS.row(key)}
        className="click"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
          onOpen(row);
        }}
      >
        <td>
          <div className="hstack" style={{ gap: 8 }}>
            <DateBlock date={row.eventDate} daysOut={row.daysOut} />
            <div>
              <button type="button" className="link-cell strong" onClick={() => onOpen(row)}>
                {row.title}
              </button>
              {/* The event DATE in words beside the block (owner, 2026-09-14:
                  "Contracts page needs event date"). The `DateBlock` shows it
                  as a stamp, which reads at a glance on a full-width table and
                  disappears the moment the row is narrow; spelling it out here
                  means the day survives every width and never has to be
                  inferred from a three-letter month. */}
              <div className="xs muted">{contractRowMeta(row)}</div>
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
            {eventHref ? (
              <Link
                className="btn btn-sm"
                href={eventHref}
                title={eventJumpTitle(row)}
                aria-label={eventJumpTitle(row)}
                data-testid={CONTRACT_TEST_IDS.eventJump(key)}
              >
                <IconCalendarEvent {...ICON} /> <span className="lbl">Event</span>
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                disabled
                title={eventJumpTitle(row)}
                aria-label={eventJumpTitle(row)}
              >
                <IconCalendarEvent {...ICON} /> <span className="lbl">Event</span>
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => onOpen(row)}>
              View
            </button>
          </span>
        </td>
      </tr>
    </>
  );
}
