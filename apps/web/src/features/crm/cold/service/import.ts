/**
 * Importing a cold list: stage → map → review → commit.
 *
 * WHY FOUR STEPS AND NOT ONE. The owner has not told us which columns their
 * files have (decision D9), so the operator must see the columns before the
 * import means anything. But CLAUDE.md's hard rule is that data a person gives
 * us is persisted at capture, not after the rest of the flow succeeds — so the
 * staging step writes EVERY record to `crm_cold_rows.raw` before the mapping
 * screen is even drawn. Consequences worth having:
 *
 *   - closing the browser mid-mapping loses nothing; the list is there, staged;
 *   - a mis-mapped import is RE-mapped from the stored raw records instead of
 *     being re-uploaded, and the columns the operator skipped are still on file;
 *   - de-duplication reads our own database only, so nothing here depends on
 *     an external call that could fail and take the file with it.
 *
 * NO BMI PROJECT IS MINTED HERE. A cold row is a PROSPECT; the mint happens
 * when a rep converts one on real interest (`service/dispositions.ts`), which
 * is where the assignment rules run too.
 */

import { writeAudit } from "~/features/crm/core/data/audit-db";
import { accountNameKey } from "~/features/crm/leads";
import type { CentreCode, CrmUser } from "../../core/types";
import {
  COLD_MAP_PAGE,
  COLD_MAX_ROWS,
  type ColdColumnMap,
  type ColdDecision,
  type ColdImportReport,
  type ColdListView,
  type ColdParseMeta,
} from "../contracts";
import { ColdSeenKeys, matchKeysFor, verdictFor } from "../dedupe";
import { projectRecord } from "../mapping";
import { getColdList, insertColdList, refreshColdRowCount, updateColdList } from "../data/lists-db";
import {
  applyColdProjections,
  coldRowTotals,
  commitColdRows,
  findColdCandidates,
  insertColdRows,
  listColdMatches,
  listColdRawRecords,
  setColdRowDecision,
  type ColdRawRecord,
  type ColdRowProjectionPatch,
} from "../data/rows-db";

export class ColdListNotFoundError extends Error {
  constructor(readonly listId: string) {
    super("cold_list_not_found");
    this.name = "ColdListNotFoundError";
  }
}

export class ColdListFullError extends Error {
  constructor() {
    super("cold_list_full");
    this.name = "ColdListFullError";
  }
}

export interface CreateColdListInput {
  name: string;
  ownerRepId: string | null;
  centre: CentreCode | null;
  sourceFilename: string | null;
  headers: string[];
  parseMeta: ColdParseMeta | null;
  columnMap: ColdColumnMap | null;
}

/** Step 1 — the list row, before a single record is posted. */
export async function createColdList(
  input: CreateColdListInput,
  user: CrmUser,
): Promise<ColdListView> {
  const id = await insertColdList({
    name: input.name.trim() || input.sourceFilename || "Cold list",
    ownerRepId: input.ownerRepId,
    centre: input.centre,
    sourceFilename: input.sourceFilename,
    headers: input.headers,
    parseMeta: input.parseMeta,
    columnMap: input.columnMap,
    importedBy: user.email,
  });
  await writeAudit({
    entity: "cold_list",
    entityId: id,
    action: "create",
    actorEmail: user.email,
    after: {
      name: input.name,
      sourceFilename: input.sourceFilename,
      headers: input.headers.length,
      centre: input.centre,
    },
  });
  const list = await getColdList(id);
  if (!list) throw new ColdListNotFoundError(id);
  return list;
}

/** Step 2 — one chunk of raw records. Nothing else happens to them yet. */
export async function appendColdRows(
  listId: string,
  records: readonly ColdRawRecord[],
  user: CrmUser,
): Promise<{ inserted: number; rowCount: number }> {
  const list = await getColdList(listId);
  if (!list) throw new ColdListNotFoundError(listId);
  const highest = records.reduce((m, r) => Math.max(m, r.index), 0);
  if (highest > COLD_MAX_ROWS) throw new ColdListFullError();
  const inserted = await insertColdRows(listId, records);
  const rowCount = await refreshColdRowCount(listId);
  if (inserted > 0) {
    console.info("[crm] cold rows staged", {
      list_id: listId,
      inserted,
      row_count: rowCount,
      actor_email: user.email,
    });
  }
  return { inserted, rowCount };
}

/**
 * Step 3 — project every stored record through the map and de-duplicate.
 *
 * Runs in pages so one statement covers 500 rows rather than one row, and so
 * the candidate lookup is one query per page. Re-runnable: the operator can
 * change the map and press Apply again, and every row is recomputed from the
 * raw record it has always had.
 */
export async function mapColdList(
  listId: string,
  columnMap: ColdColumnMap,
  user: CrmUser,
): Promise<{ list: ColdListView; report: ColdImportReport }> {
  const existing = await getColdList(listId);
  if (!existing) throw new ColdListNotFoundError(listId);

  const seen = new ColdSeenKeys();
  let after = 0;
  for (;;) {
    const page = await listColdRawRecords(listId, after, COLD_MAP_PAGE);
    if (page.length === 0) break;
    after = page[page.length - 1]?.rowIndex ?? after;

    const projected = page.map((row) => {
      const projection = projectRecord(row.raw, columnMap);
      const nameKey = projection.company ? accountNameKey(projection.company) : null;
      return { row, projection, keys: matchKeysFor(projection, nameKey || null) };
    });

    const candidates = await findColdCandidates({
      bmiPersonIds: unique(projected.map((p) => p.keys.bmiPersonId)),
      phones: unique(projected.map((p) => p.keys.phoneE164)),
      emails: unique(projected.map((p) => p.keys.emailKey)),
      nameKeys: unique(projected.map((p) => p.keys.nameKey)),
    });

    const patches: ColdRowProjectionPatch[] = projected.map(({ row, projection, keys }) => {
      const duplicate = seen.add(keys);
      const verdict = verdictFor(keys, candidates, duplicate);
      return {
        id: row.id,
        company: projection.company,
        contactName: projection.contactName,
        phoneE164: projection.phoneE164,
        phoneRaw: projection.phoneRaw,
        email: projection.email,
        emailKey: projection.emailKey,
        city: projection.city,
        notes: projection.notes,
        bmiPersonId: projection.bmiPersonId,
        accountId: verdict.match?.accountId ?? null,
        contactId: verdict.match?.contactId ?? null,
        matchedBy: verdict.matchedBy,
        decision: verdict.decision,
      };
    });
    await applyColdProjections(patches);
    if (page.length < COLD_MAP_PAGE) break;
  }

  const list = (await updateColdList(listId, { columnMap })) ?? existing;
  const report = await buildReport(listId);
  await writeAudit({
    entity: "cold_list",
    entityId: listId,
    action: "map",
    actorEmail: user.email,
    after: { columnMap, rows: report.rows, matched: report.matched },
  });
  return { list, report };
}

/**
 * Step 4 — the operator's decisions, then commit.
 *
 * Rows they chose to skip become `skipped` (kept, never deleted — the file is
 * ours and a skip is reversible); everything else becomes `ready` and appears
 * on the dialling list.
 */
export async function commitColdList(
  listId: string,
  decisions: readonly { rowId: string; decision: ColdDecision }[],
  user: CrmUser,
): Promise<{
  list: ColdListView;
  report: ColdImportReport;
  imported: number;
  linked: number;
  skipped: number;
}> {
  const existing = await getColdList(listId);
  if (!existing) throw new ColdListNotFoundError(listId);
  for (const d of decisions) await setColdRowDecision(d.rowId, d.decision);

  const counts = await commitColdRows(listId);
  await refreshColdRowCount(listId);
  const list = (await updateColdList(listId, { status: "ready" })) ?? existing;
  const report = await buildReport(listId);
  await writeAudit({
    entity: "cold_list",
    entityId: listId,
    action: "commit",
    actorEmail: user.email,
    after: { ...counts, decisions: decisions.length },
  });
  console.info("[crm] cold list committed", {
    list_id: listId,
    actor_email: user.email,
    ...counts,
  });
  return { list, report, ...counts };
}

export async function buildReport(listId: string): Promise<ColdImportReport> {
  const totals = await coldRowTotals(listId);
  const matches = await listColdMatches(listId);
  return {
    rows: totals.rows,
    undialable: totals.undialable,
    withPhone: totals.withPhone,
    withEmail: totals.withEmail,
    matched: totals.matched,
    duplicatesInFile: totals.duplicatesInFile,
    unreachable: totals.unreachable,
    matches,
  };
}

/** Non-null, de-duplicated, order preserved. */
export function unique(values: readonly (string | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
