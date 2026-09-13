"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconFile, IconInfoCircle } from "@tabler/icons-react";
import {
  COLD_DECISIONS,
  COLD_DECISION_LABEL,
  COLD_FIELDS,
  COLD_FIELD_LABEL,
  COLD_MATCH_LABEL,
  COLD_MAX_BYTES,
  COLD_MAX_ROWS,
  COLD_ROWS_PER_CHUNK,
  COLD_TEST_IDS,
  coldMatchWarning,
  type ColdColumnMap,
  type ColdDecision,
  type ColdImportReport,
  type ColdListView,
  type ColdRowView,
} from "~/features/crm/cold/contracts";
import { parseCsv, previewRows, type CsvTable } from "~/features/crm/cold/csv";
import { projectRecord, suggestColumnMap, unmappedHeaders } from "~/features/crm/cold/mapping";
import { coldKeys } from "~/features/crm/cold/queries";
import { CENTRE_CODES } from "~/features/crm/core/centres";
import type { CentreCode } from "~/features/crm/core/types";
import type { PublicRep } from "~/features/crm/core/contracts";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { Meter } from "../primitives/Meter";
import { Table } from "../primitives/Table";
import { firstMatchExample, importSummary, rowTitle } from "./model";
import { postColdList, postColdListAction, postColdRows } from "./queries";

/**
 * "Import a CSV, map the columns, dial down the list" (`crm-shared.js:443`).
 *
 * FOUR STEPS, AND THE ORDER IS THE POINT:
 *
 *   read     the browser parses the file — headers, delimiter, row count
 *   upload   every record is POSTed to Neon as raw JSON, BEFORE anything is
 *            mapped or matched. This is the persist-at-capture rule (CLAUDE.md):
 *            from here on the operator can close the laptop and lose nothing,
 *            and a mis-mapped import is re-mapped rather than re-uploaded.
 *   map      the operator confirms what each column is. The defaults are a
 *            guess from the header spellings, never a schema — the owner has
 *            not told us which columns their files have (decision D9).
 *   review   every row that matched something we already have, with a per-row
 *            choice. Nothing is silently dropped and nothing is silently
 *            duplicated.
 *
 * The file never leaves the browser as a file: `COLD_ROWS_PER_CHUNK` records
 * per request keeps every POST far inside Vercel's 4.5 MB body limit, which a
 * single multipart upload of the brief's "≤ 5 MB CSV" would have exceeded.
 */

type Step = "pick" | "uploading" | "map" | "review" | "done";

export interface ImportSheetProps {
  reps: readonly PublicRep[];
  defaultOwnerRepId: string | null;
  onImported: (list: ColdListView) => void;
}

export function ImportSheet({ reps, defaultOwnerRepId, onImported }: ImportSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>("pick");
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ownerRepId, setOwnerRepId] = useState<string | null>(defaultOwnerRepId);
  const [centre, setCentre] = useState<CentreCode | "">("");
  const [hasHeaderRow, setHasHeaderRow] = useState(true);
  const [text, setText] = useState<string | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [map, setMap] = useState<ColdColumnMap>({});
  const [list, setList] = useState<ColdListView | null>(null);
  const [report, setReport] = useState<ColdImportReport | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ColdDecision>>({});
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

  const preview = useMemo(() => (table ? previewRows(table, 4) : []), [table]);
  const unmapped = useMemo(() => (table ? unmappedHeaders(table.headers, map) : []), [table, map]);

  /** Re-read the file when the operator says the first row is data, not headers. */
  const reparse = useCallback((raw: string, headerRow: boolean) => {
    const parsed = parseCsv(raw, { hasHeaderRow: headerRow, maxRows: COLD_MAX_ROWS });
    setTable(parsed);
    setMap(suggestColumnMap(parsed.headers));
    return parsed;
  }, []);

  async function onFile(file: File | null) {
    setError(null);
    if (!file) return;
    if (file.size > COLD_MAX_BYTES) {
      setError(`That file is ${Math.round(file.size / 1024 / 1024)} MB. The limit is 5 MB.`);
      return;
    }
    const raw = await file.text();
    const parsed = reparse(raw, hasHeaderRow);
    setText(raw);
    setFileName(file.name);
    if (!name.trim()) setName(file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " "));
    if (parsed.records.length === 0) {
      setError("That file has no rows in it.");
    } else if (parsed.truncated) {
      setError(`Only the first ${COLD_MAX_ROWS.toLocaleString()} rows will be imported.`);
    }
  }

  /** Create the list, then post every record before anything else happens. */
  async function upload() {
    if (!table || table.records.length === 0) return;
    setBusy(true);
    setError(null);
    setStep("uploading");
    cancelled.current = false;
    try {
      const created = await postColdList(crmFetch, {
        action: "create",
        name: name.trim() || fileName || "Cold list",
        ownerRepId,
        centre: centre === "" ? null : centre,
        sourceFilename: fileName,
        headers: table.headers,
        parseMeta: table.meta,
        columnMap: map,
      });
      setList(created.list);

      for (let i = 0; i < table.records.length; i += COLD_ROWS_PER_CHUNK) {
        if (cancelled.current) return;
        const chunk = table.records.slice(i, i + COLD_ROWS_PER_CHUNK);
        await postColdRows(crmFetch, created.list.id, { records: chunk });
        setSent(i + chunk.length);
      }
      await apply(created.list.id, map);
      setStep("map");
    } catch (err) {
      setError(errorMessage(err));
      setStep(list ? "map" : "pick");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: coldKeys.all });
    }
  }

  /** Project the stored records through the map and de-duplicate. Re-runnable. */
  async function apply(listId: string, columnMap: ColdColumnMap) {
    const res = await postColdListAction(crmFetch, listId, { action: "map", columnMap });
    setList(res.list);
    setReport(res.report);
    setDecisions(Object.fromEntries(res.report.matches.map((m) => [m.id, m.decision])));
    return res.report;
  }

  async function remap() {
    if (!list) return;
    setBusy(true);
    setError(null);
    try {
      await apply(list.id, map);
      toast("Columns applied");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!list) return;
    setBusy(true);
    setError(null);
    try {
      const res = await postColdListAction(crmFetch, list.id, {
        action: "commit",
        decisions: Object.entries(decisions).map(([rowId, decision]) => ({ rowId, decision })),
      });
      setList(res.list);
      setReport(res.report);
      setStep("done");
      toast(`Imported ${res.imported} rows · ${res.linked} linked · ${res.skipped} skipped`);
      void qc.invalidateQueries({ queryKey: coldKeys.all });
      onImported(res.list);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function setAll(decision: ColdDecision) {
    if (!report) return;
    setDecisions(Object.fromEntries(report.matches.map((m) => [m.id, decision])));
  }

  const total = table?.records.length ?? 0;

  return (
    <div data-testid={COLD_TEST_IDS.importSheet}>
      {error ? (
        <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
          {error}
        </Banner>
      ) : null}

      {step === "pick" ? (
        <>
          <div className="field">
            <label htmlFor="cold-file">File</label>
            <input
              id="cold-file"
              className="input"
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />
          </div>
          {table ? (
            <Banner tone="info" icon={<IconFile {...ICON} />}>
              {fileName} · {total.toLocaleString()} {total === 1 ? "row" : "rows"} ·{" "}
              {table.headers.length} columns
              {table.meta.blankRows ? ` · ${table.meta.blankRows} blank skipped` : ""}
              {table.meta.raggedRows ? ` · ${table.meta.raggedRows} short of a column` : ""}
              {table.meta.delimiter !== "," ? ` · ${delimiterName(table.meta.delimiter)}` : ""}
            </Banner>
          ) : null}
          <div className="field">
            <label htmlFor="cold-name">List name</label>
            <input
              id="cold-name"
              className="input"
              value={name}
              maxLength={160}
              placeholder="Fort Myers Chamber — Tech & Professional"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="cold-owner">Assign list to</label>
              <select
                id="cold-owner"
                className="select"
                value={ownerRepId ?? ""}
                onChange={(e) => setOwnerRepId(e.target.value || null)}
              >
                <option value="">Nobody yet</option>
                {reps.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cold-centre">Centre</label>
              <select
                id="cold-centre"
                className="select"
                value={centre}
                onChange={(e) => setCentre((e.target.value || "") as CentreCode | "")}
              >
                <option value="">Any</option>
                {CENTRE_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="cold-header-row">The first row is</label>
            <select
              id="cold-header-row"
              className="select"
              value={hasHeaderRow ? "headers" : "data"}
              onChange={(e) => {
                const isHeader = e.target.value === "headers";
                setHasHeaderRow(isHeader);
                if (text) reparse(text, isHeader);
              }}
            >
              <option value="headers">Column headings</option>
              <option value="data">Already data</option>
            </select>
          </div>
          <div className="foot" style={{ position: "static", padding: 0 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!table || total === 0 || busy}
              onClick={() => void upload()}
            >
              Upload {total ? `${total.toLocaleString()} rows` : "file"}
            </button>
          </div>
          <p className="muted xs">
            Every row is saved to our database first, before any column is mapped and before
            anything is matched. Nothing is sent anywhere else.
          </p>
        </>
      ) : null}

      {step === "uploading" ? (
        <div className="stack">
          <div className="eyebrow">Saving every row</div>
          <Meter pct={total ? (sent / total) * 100 : 0} label="Upload progress" />
          <div className="muted small">
            {sent.toLocaleString()} of {total.toLocaleString()} rows saved
          </div>
        </div>
      ) : null}

      {(step === "map" || step === "review" || step === "done") && table ? (
        <div data-testid={COLD_TEST_IDS.mapStep}>
          <div className="eyebrow">Map columns</div>
          <div className="grid grid-2">
            {COLD_FIELDS.map((field) => (
              <div className="field" key={field}>
                <label htmlFor={`cold-map-${field}`}>{COLD_FIELD_LABEL[field]}</label>
                <select
                  id={`cold-map-${field}`}
                  className="select"
                  value={map[field] ?? ""}
                  onChange={(e) => setMap({ ...map, [field]: e.target.value || null })}
                >
                  <option value="">(skip)</option>
                  {table.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {unmapped.length ? (
            <p className="muted xs">
              Not imported into a column of its own: {unmapped.join(", ")}. Every cell is kept on
              the row either way.
            </p>
          ) : null}

          <div className="eyebrow">What that gives us</div>
          <Table
            caption="The first rows as they will be stored"
            columns={[
              { key: "company", label: "Company" },
              { key: "contact", label: "Contact" },
              { key: "phone", label: "Phone" },
              { key: "email", label: "Email" },
            ]}
          >
            {preview.map((rec) => {
              const p = projectRecord(rec.values, map);
              return (
                <tr key={rec.index}>
                  <td className="strong">{p.company ?? "—"}</td>
                  <td>{p.contactName ?? "—"}</td>
                  <td>
                    {p.phoneE164 ?? (
                      <span className="muted" title={p.phoneRaw ?? undefined}>
                        {p.phoneRaw ? `${p.phoneRaw} (cannot dial)` : "—"}
                      </span>
                    )}
                  </td>
                  <td>{p.email ?? "—"}</td>
                </tr>
              );
            })}
          </Table>

          {step === "map" ? (
            <div className="foot" style={{ position: "static", padding: 0 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => void remap()}>
                Apply columns
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !report}
                onClick={() => setStep("review")}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {(step === "review" || step === "done") && report ? (
        <ReviewStep
          report={report}
          decisions={decisions}
          onDecision={(rowId, decision) => setDecisions({ ...decisions, [rowId]: decision })}
          onAll={setAll}
          readOnly={step === "done"}
        />
      ) : null}

      {step === "review" ? (
        <div className="foot" style={{ position: "static", padding: 0 }}>
          <button type="button" className="btn" disabled={busy} onClick={() => setStep("map")}>
            Back to columns
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void commit()}
          >
            Import
          </button>
        </div>
      ) : null}

      {step === "done" && list ? (
        <Banner tone="good" icon={<IconInfoCircle {...ICON} />}>
          {list.name} is ready to dial — {list.stats.rows} rows, {list.stats.dialable} with a
          number.
        </Banner>
      ) : null}
    </div>
  );
}

function delimiterName(d: string): string {
  if (d === ";") return "semicolon-separated";
  if (d === "\t") return "tab-separated";
  if (d === "|") return "pipe-separated";
  return "comma-separated";
}

/**
 * The review table: every row that matched something, with what it matched and
 * what will happen to it. The prototype's banner promised "they will be
 * linked, not duplicated" — this is that promise made changeable.
 */
function ReviewStep({
  report,
  decisions,
  onDecision,
  onAll,
  readOnly,
}: {
  report: ColdImportReport;
  decisions: Record<string, ColdDecision>;
  onDecision: (rowId: string, decision: ColdDecision) => void;
  onAll: (decision: ColdDecision) => void;
  readOnly: boolean;
}) {
  return (
    <div data-testid={COLD_TEST_IDS.reviewStep}>
      <div className="eyebrow">Before we import</div>
      {importSummary(report).map((line) => (
        <p className="muted small" key={line}>
          {line}
        </p>
      ))}
      {report.matches.length ? (
        <>
          <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
            {coldMatchWarning(report.matched, firstMatchExample(report))}
          </Banner>
          {readOnly ? null : (
            <div className="hstack" style={{ gap: 8, marginBottom: 8 }}>
              {COLD_DECISIONS.map((d) => (
                <button key={d} type="button" className="btn btn-sm" onClick={() => onAll(d)}>
                  {COLD_DECISION_LABEL[d]} · all
                </button>
              ))}
            </div>
          )}
          <Table
            caption="Rows that match something we already have"
            columns={[
              { key: "row", label: "Row" },
              { key: "what", label: "From the file" },
              { key: "matched", label: "Matched" },
              { key: "decision", label: "What to do" },
            ]}
          >
            {report.matches.map((m) => (
              <MatchRow
                key={m.id}
                row={m}
                decision={decisions[m.id] ?? m.decision}
                onDecision={onDecision}
                readOnly={readOnly}
              />
            ))}
          </Table>
        </>
      ) : (
        <Banner tone="good" icon={<IconInfoCircle {...ICON} />}>
          {coldMatchWarning(0, null)}
        </Banner>
      )}
    </div>
  );
}

function MatchRow({
  row,
  decision,
  onDecision,
  readOnly,
}: {
  row: ColdRowView;
  decision: ColdDecision;
  onDecision: (rowId: string, decision: ColdDecision) => void;
  readOnly: boolean;
}) {
  return (
    <tr>
      <td className="muted">{row.rowIndex}</td>
      <td className="strong">
        {rowTitle(row)}
        {row.phoneE164 ? <div className="muted xs">{row.phoneE164}</div> : null}
      </td>
      <td>
        {row.matchedBy ? COLD_MATCH_LABEL[row.matchedBy] : "—"}
        {row.accountName ? <div className="muted xs">{row.accountName}</div> : null}
      </td>
      <td>
        {readOnly ? (
          COLD_DECISION_LABEL[decision]
        ) : (
          <>
            <label className="sr-only" htmlFor={`cold-decision-${row.id}`}>
              What to do with row {row.rowIndex}
            </label>
            <select
              id={`cold-decision-${row.id}`}
              className="select"
              value={decision}
              onChange={(e) => onDecision(row.id, e.target.value as ColdDecision)}
            >
              {COLD_DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {COLD_DECISION_LABEL[d]}
                </option>
              ))}
            </select>
          </>
        )}
      </td>
    </tr>
  );
}
