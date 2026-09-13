"use client";

import { IconDatabase, IconPlayerPlay, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { MirrorStatus } from "~/features/crm/core/contracts";
import { fStamp } from "~/features/crm/core/dates";
import type { OfficeClientKey } from "~/features/crm/core/types";
import { historyKeys } from "~/features/crm/bmi/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Seg } from "../primitives/Seg";
import { ErrorState } from "../primitives/States";
import { Table } from "../primitives/Table";
import { backfillDefaults, isYmd, tenantOptions } from "./model";
import { runBackfill, runDelta } from "./queries";
import { HISTORY_TEST_IDS } from "./test-ids";

/**
 * The director's mirror control (brief §1.7: crons never run on a preview, so
 * every job is also an admin action). Starts a chunked backfill for one Office
 * tenant and span — the handler re-enqueues itself window by window — runs a
 * delta on demand, and lists the latest sync runs so "ran" is never mistaken
 * for a result. Not in the prototype; director-only.
 */
export interface MirrorCardProps {
  mirror: MirrorStatus | null;
  canEdit: boolean;
}

const TENANTS = tenantOptions();

export function MirrorCard({ mirror, canEdit }: MirrorCardProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const defaults = backfillDefaults();
  const [clientKey, setClientKey] = useState<OfficeClientKey>(
    TENANTS[0]?.clientKey ?? "headpinzftmyers",
  );
  const [from, setFrom] = useState(defaults.from);
  const [until, setUntil] = useState(defaults.until);

  const backfill = useMutation({
    mutationFn: () => runBackfill(crmFetch, { clientKey, from, until }),
    onSuccess: (data) => {
      toast(`Backfill ${data.job.status} · job ${data.job.id}`);
      void qc.invalidateQueries({ queryKey: historyKeys.all });
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const delta = useMutation({
    mutationFn: () => runDelta(crmFetch, clientKey),
    onSuccess: (data) => {
      toast(`Delta ${data.job.status} · job ${data.job.id}`);
      void qc.invalidateQueries({ queryKey: historyKeys.all });
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const busy = backfill.isPending || delta.isPending;
  const valid = isYmd(from) && isYmd(until) && from <= until;
  const runs = mirror?.runs ?? [];

  return (
    <div className="card" data-testid={HISTORY_TEST_IDS.mirror}>
      <div className="card-h">
        <h2>BMI mirror</h2>
        <div className="right xs muted">
          {mirror
            ? `${mirror.groupEvents.toLocaleString()} group events · ${mirror.projects.toLocaleString()} projects mirrored`
            : "—"}
        </div>
      </div>
      <div className="pad stack">
        <div className="hstack" style={{ flexWrap: "wrap" }}>
          <Seg
            label="Office tenant"
            value={clientKey}
            onChange={setClientKey}
            options={TENANTS.map((t) => ({ value: t.clientKey, label: t.label }))}
          />
          <label className="small muted" htmlFor={`${id}-from`}>
            From
          </label>
          <input
            id={`${id}-from`}
            className="input"
            type="date"
            style={{ width: "auto" }}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={!canEdit || busy}
          />
          <label className="small muted" htmlFor={`${id}-until`}>
            Until
          </label>
          <input
            id={`${id}-until`}
            className="input"
            type="date"
            style={{ width: "auto" }}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            disabled={!canEdit || busy}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canEdit || busy || !valid}
            onClick={() => backfill.mutate()}
          >
            <IconPlayerPlay {...ICON} /> {backfill.isPending ? "Running…" : "Run backfill"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canEdit || busy}
            onClick={() => delta.mutate()}
          >
            <IconRefresh {...ICON} /> {delta.isPending ? "Running…" : "Run delta now"}
          </button>
        </div>
        <div className="xs muted">
          One 30-day window per run; the job re-enqueues the next window itself and the cron drains
          the chain. Reads only — nothing is written to Office.
        </div>
        {backfill.isError ? <ErrorState message={errorMessage(backfill.error)} /> : null}
        {delta.isError ? <ErrorState message={errorMessage(delta.error)} /> : null}
        {backfill.data ? (
          <pre className="mono xs" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(backfill.data.result, null, 2)}
          </pre>
        ) : null}
        {runs.length > 0 ? (
          <Table
            caption="Latest mirror sync runs"
            columns={[
              { key: "when", label: "Started" },
              { key: "kind", label: "Kind" },
              { key: "tenant", label: "Tenant" },
              { key: "window", label: "Window" },
              { key: "rows", label: "Rows", num: true },
              { key: "ok", label: "Result" },
            ]}
          >
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="muted">{fStamp(r.startedAt)}</td>
                <td>{r.kind}</td>
                <td className="mono xs">{r.clientKey}</td>
                <td className="xs muted">
                  {r.windowFrom ? fStamp(r.windowFrom) : "—"} →{" "}
                  {r.windowUntil ? fStamp(r.windowUntil) : "—"}
                </td>
                <td className="num">
                  {r.rowsUpserted ?? 0}/{r.rowsSeen ?? 0}
                </td>
                <td>
                  {r.finishedAt === null ? (
                    <Chip kind="open">running</Chip>
                  ) : r.ok ? (
                    <Chip kind="won">ok</Chip>
                  ) : (
                    <span className="hstack">
                      <Chip kind="lost">failed</Chip>
                      {r.error ? <span className="xs muted">{r.error}</span> : null}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="hstack xs muted">
            <IconDatabase {...ICON} /> No sync runs yet.
          </div>
        )}
      </div>
    </div>
  );
}
