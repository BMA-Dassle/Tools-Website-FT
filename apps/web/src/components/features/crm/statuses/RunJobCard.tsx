"use client";

import { IconPlayerPlay } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { TEST_IDS, type JobsRunBody } from "~/features/crm/core/contracts";
import type { JobKind } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { ErrorState } from "../primitives/States";
import { runJob } from "./queries";

/**
 * "Run job" — the PR1 smoke control (brief §3.9: crons never run on a
 * preview, so every job is runnable from an admin action). `noop` proves the
 * chain end to end and echoes `actor_email`; `seed` re-runs the idempotent
 * seed and returns its counts. The result JSON is shown verbatim.
 */
const RUNNABLE: { kind: JobKind; label: string; help: string }[] = [
  {
    kind: "noop",
    label: "noop",
    help: "Proves the route, the session and the audit row; returns actor_email.",
  },
  {
    kind: "seed",
    label: "seed",
    help: "Runs the idempotent seed (reps, statuses, rules, templates, settings).",
  },
];

export function RunJobCard({ canEdit }: { canEdit: boolean }) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const id = useId();
  const [kind, setKind] = useState<JobKind>("noop");

  const run = useMutation({
    mutationFn: (body: JobsRunBody) => runJob(crmFetch, body),
    onSuccess: (data) => toast(`Job ${data.job.kind} → ${data.job.status}`),
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const help = RUNNABLE.find((r) => r.kind === kind)?.help ?? "";

  return (
    <div className="card" data-testid={TEST_IDS.runJob}>
      <div className="card-h">
        <h2>Run job</h2>
        <div className="right xs muted">inline · the same handler the cron drains</div>
      </div>
      <div className="pad stack">
        <div className="hstack">
          <label className="small muted" htmlFor={`${id}-kind`}>
            Kind
          </label>
          <select
            id={`${id}-kind`}
            className="select"
            style={{ width: "auto" }}
            value={kind}
            onChange={(e) => setKind(e.target.value as JobKind)}
            disabled={!canEdit || run.isPending}
          >
            {RUNNABLE.map((r) => (
              <option key={r.kind} value={r.kind}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canEdit || run.isPending}
            onClick={() => run.mutate({ kind })}
          >
            <IconPlayerPlay {...ICON} /> {run.isPending ? "Running…" : "Run"}
          </button>
          <span className="xs muted">{help}</span>
        </div>
        {run.isError ? <ErrorState message={errorMessage(run.error)} /> : null}
        {run.data ? (
          <div className="stack">
            <div className="hstack small">
              <span className="muted">Job {run.data.job.id}</span>
              <Chip
                kind={
                  run.data.job.status === "done"
                    ? "won"
                    : run.data.job.status === "failed"
                      ? "lost"
                      : "open"
                }
              >
                {run.data.job.status}
              </Chip>
              {run.data.job.lastError ? (
                <span style={{ color: "var(--crit-ink)" }}>{run.data.job.lastError}</span>
              ) : null}
            </div>
            <pre className="mono" data-testid={TEST_IDS.runJobResult}>
              {JSON.stringify(run.data.result, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
