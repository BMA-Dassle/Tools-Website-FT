import type { CentreSummary, OfficeStateProposal } from "~/features/crm/core/contracts";
import type { CentreCode, CrmStatus, StatusBmiMapRow } from "~/features/crm/core/types";

/**
 * Pure helpers behind the Statuses screen — the part a test can hold.
 */

/** Live statuses in board order. */
export function activeStatuses(statuses: readonly CrmStatus[]): CrmStatus[] {
  return statuses.filter((s) => !s.archivedAt).sort((a, b) => a.position - b.position);
}

export function archivedCount(statuses: readonly CrmStatus[]): number {
  return statuses.filter((s) => !!s.archivedAt).length;
}

export interface ClientKeyColumn {
  clientKey: string;
  /** "HP Fort Myers · FastTrax" — the centres that share the Office tenant. */
  label: string;
  codes: CentreCode[];
}

/**
 * One column per Office tenant, in centre order: FT shares HPFM's server, so
 * the prototype's "BMI state · Fort Myers" / "· Naples" columns come out of
 * the centres list rather than being typed twice.
 */
export function clientKeyColumns(centres: readonly CentreSummary[]): ClientKeyColumn[] {
  const out: ClientKeyColumn[] = [];
  for (const c of centres) {
    const col = out.find((x) => x.clientKey === c.clientKey);
    if (col) {
      col.codes.push(c.code);
      col.label = `${col.label} · ${c.short}`;
    } else {
      out.push({ clientKey: c.clientKey, label: c.short, codes: [c.code] });
    }
  }
  return out;
}

export function mapRowFor(
  map: readonly StatusBmiMapRow[],
  statusId: string,
  clientKey: string,
): StatusBmiMapRow | undefined {
  return map.find((m) => m.statusId === statusId && m.clientKey === clientKey);
}

export function proposalFor(
  proposals: readonly OfficeStateProposal[],
  statusId: string,
): OfficeStateProposal | undefined {
  return proposals.find((p) => p.statusId === statusId);
}

/** Move `id` one step; returns the same array when it cannot move. */
export function moveId(ids: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const next = [...ids];
  [next[i], next[j]] = [next[j] as string, next[i] as string];
  return next;
}

/** The centre the map editor starts on: the URL's, if it is one we sell at. */
export function initialCentre(
  query: Record<string, string>,
  centres: readonly CentreSummary[],
): CentreCode | null {
  const wanted = query.centre;
  const hit = centres.find((c) => c.code === wanted);
  if (hit) return hit.code;
  return centres[0]?.code ?? null;
}

/** A slug for a new status id: "Waiting on guest" → "waiting-on-guest". */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
