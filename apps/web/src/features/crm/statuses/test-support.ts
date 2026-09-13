/**
 * Status fixtures — the ten seeded rows (`core/seed.ts` STATUS_SEED, itself
 * `crm-data.js:44-55`) as `CrmStatus` objects, with the five off-board ids the
 * seed marks. Test-only; the index does not export it.
 */

import type { CrmStatus, StatusKind } from "../core/types";

function st(
  id: string,
  label: string,
  kind: StatusKind,
  position: number,
  onBoard: boolean,
): CrmStatus {
  return {
    id,
    label,
    kind,
    position,
    slaLabel: null,
    slaHours: null,
    onBoard,
    archivedAt: null,
  };
}

/** The seeded ten, in seed order; `onBoard` false for new/deposit/confirmed/lost/noresp. */
export const STATUSES: CrmStatus[] = [
  st("new", "New", "open", 1, false),
  st("assigned", "Assigned", "open", 2, true),
  st("contacted", "Contacted", "open", 3, true),
  st("waiting", "Waiting on guest", "open", 4, true),
  st("quote", "Quote sent", "open", 5, true),
  st("contract", "Contract sent", "open", 6, true),
  st("deposit", "Deposit paid", "won", 7, false),
  st("confirmed", "Confirmed", "won", 8, false),
  st("lost", "Lost", "lost", 9, false),
  st("noresp", "No response", "lost", 10, false),
];

export const STATUS_BY_ID = new Map(STATUSES.map((s) => [s.id, s]));

export function statusById(id: string): CrmStatus {
  const s = STATUS_BY_ID.get(id);
  if (!s) throw new Error(`no seeded status ${id}`);
  return s;
}
