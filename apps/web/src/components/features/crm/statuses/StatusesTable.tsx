"use client";

import { IconArchive, IconArrowDown, IconArrowUp, IconPencil } from "@tabler/icons-react";
import { TEST_IDS } from "~/features/crm/core/contracts";
import type { CrmStatus, StatusBmiMapRow } from "~/features/crm/core/types";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Table, type TableColumn } from "../primitives/Table";
import { mapRowFor, type ClientKeyColumn } from "./model";

/**
 * The prototype's statuses table (crm-shared.js:477): our status, what it
 * counts as, one BMI-state column per Office tenant, the SLA, plus the
 * director's controls — on-board switch, move up / down, edit, archive.
 * Presentational: every action is a callback.
 */
export interface StatusesTableProps {
  statuses: CrmStatus[];
  map: StatusBmiMapRow[];
  columns: ClientKeyColumn[];
  canEdit: boolean;
  busy: boolean;
  onEdit: (status: CrmStatus) => void;
  onToggleBoard: (status: CrmStatus) => void;
  onMove: (status: CrmStatus, dir: -1 | 1) => void;
  onArchive: (status: CrmStatus) => void;
}

export function StatusesTable({
  statuses,
  map,
  columns,
  canEdit,
  busy,
  onEdit,
  onToggleBoard,
  onMove,
  onArchive,
}: StatusesTableProps) {
  const cols: TableColumn[] = [
    { key: "status", label: "Our status" },
    { key: "kind", label: "Counts as" },
    ...columns.map((c) => ({ key: c.clientKey, label: `BMI state · ${c.label}` })),
    { key: "sla", label: "SLA" },
    { key: "board", label: "On board" },
  ];
  if (canEdit) cols.push({ key: "actions", label: <span className="sr-only">Actions</span> });

  return (
    <Table
      columns={cols}
      testId={TEST_IDS.statusesTable}
      caption="Pipeline statuses and their BMI states"
    >
      {statuses.map((s, i) => (
        <tr key={s.id}>
          <td>
            <Chip kind={s.kind} st={s.id}>
              {s.label}
            </Chip>
          </td>
          <td className="muted">{s.kind}</td>
          {columns.map((c) => {
            const row = mapRowFor(map, s.id, c.clientKey);
            return (
              <td key={c.clientKey}>
                {row ? (
                  <span title={`Office state id ${row.bmiStateId}`}>{row.bmiStateName}</span>
                ) : (
                  <Chip kind="warn">unmapped</Chip>
                )}
              </td>
            );
          })}
          <td className="muted">{s.slaLabel ?? "—"}</td>
          <td>
            <button
              type="button"
              className="toggle"
              role="switch"
              aria-checked={s.onBoard}
              aria-label={`Show ${s.label} as a board column`}
              disabled={!canEdit || busy}
              onClick={() => onToggleBoard(s)}
            />
          </td>
          {canEdit ? (
            <td>
              <span className="hstack" style={{ justifyContent: "flex-end", gap: 2 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Move ${s.label} up`}
                  disabled={busy || i === 0}
                  onClick={() => onMove(s, -1)}
                >
                  <IconArrowUp {...ICON} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Move ${s.label} down`}
                  disabled={busy || i === statuses.length - 1}
                  onClick={() => onMove(s, 1)}
                >
                  <IconArrowDown {...ICON} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Edit ${s.label}`}
                  disabled={busy}
                  onClick={() => onEdit(s)}
                >
                  <IconPencil {...ICON} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Archive ${s.label}`}
                  disabled={busy}
                  onClick={() => onArchive(s)}
                >
                  <IconArchive {...ICON} />
                </button>
              </span>
            </td>
          ) : null}
        </tr>
      ))}
    </Table>
  );
}
