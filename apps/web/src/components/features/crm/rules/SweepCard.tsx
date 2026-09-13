"use client";

import { IconPlayerPlay } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import type { JobsRunBody, SettingsPostBody } from "~/features/crm/core/contracts";
import type { SweepSetting } from "~/features/crm/core/types";
import { RULES_TEST_IDS, type SweepResult } from "~/features/crm/rules/contracts";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { ErrorState, LoadingState } from "../primitives/States";
import { fetchSettings, postSetting, runJob, settingsKeys } from "../statuses/queries";
import { AFTER_HOURS_OPTIONS, delayOptions } from "./model";

/**
 * "Sweep" (crm-shared.js:463): Auto-assign after · Outside business hours ·
 * Notify. The two selects write `crm_settings.sweep` through
 * `POST /settings` (director) the moment they change; the sweep job reads the
 * same row. "Notify" is the prototype's fixed line — the Teams/push fan-out
 * arrives with B3 / C9. "Run sweep now" runs the `assign-sweep` job inline —
 * the preview smoke, since crons never fire there — and shows what it decided
 * (`applied` stays 0 until B3 lands the assign rail).
 */
function isSweepResult(v: unknown): v is SweepResult {
  return !!v && typeof v === "object" && Array.isArray((v as SweepResult).decisions);
}

export function SweepCard({ canEdit }: { canEdit: boolean }) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const ids = useId();

  const settingsQ = useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => fetchSettings(crmFetch),
  });

  const sweepRun = useMutation({
    mutationFn: (body: JobsRunBody) => runJob(crmFetch, body),
    onSuccess: (data) => {
      if (data.job.status !== "done") {
        toast(data.job.lastError ?? `Job ${data.job.kind} → ${data.job.status}`, "crit");
        return;
      }
      const r = data.result;
      toast(
        isSweepResult(r)
          ? `Sweep: ${r.candidates} waiting · ${r.decisions.filter((d) => d.rep).length} would assign · applied ${r.applied}`
          : "Sweep ran",
      );
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });
  const lastSweep = isSweepResult(sweepRun.data?.result) ? sweepRun.data!.result : null;

  const save = useMutation({
    mutationFn: (value: SweepSetting) => {
      const body: SettingsPostBody = { key: "sweep", value };
      return postSetting(crmFetch, body);
    },
    onSuccess: (data) => {
      qc.setQueryData(settingsKeys.all, data);
      toast("Rules saved · applies to the next lead");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const sweep = settingsQ.data?.settings.sweep ?? null;
  const busy = save.isPending;

  return (
    <div className="card" data-testid={RULES_TEST_IDS.sweep}>
      <div className="card-h">
        <h2>Sweep</h2>
      </div>
      <div className="pad stack small">
        {settingsQ.isPending ? <LoadingState label="Loading the sweep settings…" /> : null}
        {settingsQ.isError ? (
          <ErrorState
            message={errorMessage(settingsQ.error)}
            onRetry={() => void settingsQ.refetch()}
          />
        ) : null}
        {sweep ? (
          <>
            <div className="hstack between">
              <label className="muted" htmlFor={`${ids}-delay`}>
                Auto-assign after
              </label>
              <select
                id={`${ids}-delay`}
                className="select"
                style={{ width: "auto" }}
                value={String(sweep.delayMinutes)}
                disabled={!canEdit || busy}
                onChange={(e) =>
                  save.mutate({
                    delayMinutes: Number(e.target.value),
                    afterHours: sweep.afterHours,
                  })
                }
              >
                {delayOptions(sweep.delayMinutes).map((o) => (
                  <option key={o.value} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="hstack between">
              <label className="muted" htmlFor={`${ids}-after`}>
                Outside business hours
              </label>
              <select
                id={`${ids}-after`}
                className="select"
                style={{ width: "auto" }}
                value={sweep.afterHours}
                disabled={!canEdit || busy}
                onChange={(e) =>
                  save.mutate({
                    delayMinutes: sweep.delayMinutes,
                    afterHours: e.target.value as SweepSetting["afterHours"],
                  })
                }
              >
                {AFTER_HOURS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="hstack between">
              <span className="muted">Notify</span>
              <span>Jacob (Teams) · rep (Teams + push)</span>
            </div>
            {canEdit ? (
              <div className="hstack between">
                <span className="muted">Last sweep</span>
                <span className="hstack">
                  {lastSweep ? (
                    <span className="xs muted">
                      {lastSweep.candidates} waiting · applied {lastSweep.applied}
                      {lastSweep.held ? " · held" : ""} · {lastSweep.reason}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={sweepRun.isPending}
                    onClick={() => sweepRun.mutate({ kind: "assign-sweep" })}
                  >
                    <IconPlayerPlay {...ICON} /> {sweepRun.isPending ? "Running…" : "Run sweep now"}
                  </button>
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
