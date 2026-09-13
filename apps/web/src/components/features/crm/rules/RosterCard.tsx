"use client";

import { IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobsRunBody } from "~/features/crm/core/contracts";
import {
  RULES_TEST_IDS,
  type RosterPostBody,
  type RosterRowWire,
} from "~/features/crm/rules/contracts";
import { rulesKeys } from "~/features/crm/rules/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Table } from "../primitives/Table";
import { runJob } from "../statuses/queries";
import { fetchRoster, postRoster } from "./queries";

/**
 * "Roster today · Sat Sep 12" (crm-shared.js:454): Person · Today · Tomorrow ·
 * Status now · Override, from `crm_shifts`. Honest about its source: the
 * "from 7shifts" pill shows only once something has been mirrored; before that
 * the card says "No shifts mirrored yet" — and the off-today switch works
 * either way, because it is a manual row, not a 7shifts one. Refresh runs the
 * `sevenshifts-mirror` job inline (director) and reports what it did.
 */
export function RosterCard({ canEdit }: { canEdit: boolean }) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();

  const rosterQ = useQuery({
    queryKey: rulesKeys.roster(),
    queryFn: () => fetchRoster(crmFetch),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const override = useMutation({
    mutationFn: (body: RosterPostBody) => postRoster(crmFetch, body),
    onSuccess: (data, body) => {
      qc.setQueryData(rulesKeys.roster(), data);
      void qc.invalidateQueries({ queryKey: rulesKeys.all });
      const row = data.rows.find((r) => r.rep.id === body.repId);
      toast(`${row?.rep.firstName ?? "Rep"} marked ${body.off ? "off" : "available"} today`);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const refresh = useMutation({
    mutationFn: (body: JobsRunBody) => runJob(crmFetch, body),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: rulesKeys.all });
      if (data.job.status === "done") toast("Roster refreshed from 7shifts");
      else toast(data.job.lastError ?? `Job ${data.job.kind} → ${data.job.status}`, "crit");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const data = rosterQ.data;
  const busy = override.isPending || refresh.isPending;

  return (
    <div className="card" data-testid={RULES_TEST_IDS.roster}>
      <div className="card-h">
        <h2>Roster today{data ? ` · ${data.dateLabel}` : ""}</h2>
        <div className="right">
          {data?.mirrored ? <Pill>from 7shifts</Pill> : null}
          {canEdit ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !data}
              onClick={() => refresh.mutate({ kind: "sevenshifts-mirror" })}
            >
              <IconRefresh {...ICON} /> {refresh.isPending ? "Refreshing…" : "Refresh"}
            </button>
          ) : null}
        </div>
      </div>
      {rosterQ.isPending ? <LoadingState label="Loading the roster…" /> : null}
      {rosterQ.isError ? (
        <div className="pad">
          <ErrorState
            message={errorMessage(rosterQ.error)}
            onRetry={() => void rosterQ.refetch()}
          />
        </div>
      ) : null}
      {data && !data.mirrored ? (
        <div
          className="pad xs muted"
          data-testid={RULES_TEST_IDS.rosterEmpty}
          style={{ paddingBottom: 0 }}
        >
          No shifts mirrored yet
          {data.sevenShiftsConfigured
            ? " — Refresh pulls today and tomorrow from 7shifts."
            : " — SEVEN_SHIFTS_API_TOKEN is not set; the off-today switch still works."}
        </div>
      ) : null}
      {data && data.rows.length === 0 ? <EmptyState>No reps on the roster yet.</EmptyState> : null}
      {data && data.rows.length > 0 ? (
        <Table
          columns={[
            { key: "person", label: "Person" },
            { key: "today", label: "Today" },
            { key: "tomorrow", label: "Tomorrow" },
            { key: "status", label: "Status now" },
            { key: "override", label: "Override" },
          ]}
          caption={`Roster for ${data.dateLabel}`}
        >
          {data.rows.map((row) => (
            <RosterRow
              key={row.rep.id}
              row={row}
              canEdit={canEdit}
              busy={busy}
              onToggle={(off) => override.mutate({ repId: row.rep.id, off })}
            />
          ))}
        </Table>
      ) : null}
      {data?.lastSyncedAt ? (
        <div className="pad xs muted" style={{ paddingTop: 8 }}>
          last mirrored{" "}
          {new Date(data.lastSyncedAt).toLocaleString("en-US", { timeZone: "America/New_York" })}
        </div>
      ) : null}
    </div>
  );
}

function StatusCell({ status }: { status: RosterRowWire["status"] }) {
  if (status.kind === "off") return <Chip kind="lost">{status.label}</Chip>;
  if (status.kind === "on") return <Chip kind="won">{status.label}</Chip>;
  return <Pill>{status.label}</Pill>;
}

function RosterRow({
  row,
  canEdit,
  busy,
  onToggle,
}: {
  row: RosterRowWire;
  canEdit: boolean;
  busy: boolean;
  onToggle: (off: boolean) => void;
}) {
  return (
    <tr>
      <td>
        <span className="hstack">
          <Avatar initials={row.rep.initials} repSlug={row.rep.slug} name={row.rep.displayName} />
          {row.rep.displayName}
        </span>
      </td>
      <td>{row.today ? row.today.label : <span className="muted">—</span>}</td>
      <td>{row.tomorrow ? row.tomorrow.label : <span className="muted">—</span>}</td>
      <td>
        <StatusCell status={row.status} />
      </td>
      <td>
        <span className="hstack">
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={row.offToday}
            aria-label={`Mark ${row.rep.firstName} off today`}
            data-testid={RULES_TEST_IDS.offToggle(row.rep.id)}
            disabled={!canEdit || busy}
            onClick={() => onToggle(!row.offToday)}
          />
          <span className="xs muted">off today</span>
        </span>
      </td>
    </tr>
  );
}
