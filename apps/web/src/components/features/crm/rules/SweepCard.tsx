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
import { Pill } from "../primitives/Pill";
import { ErrorState, LoadingState } from "../primitives/States";
import { fetchSettings, postSetting, runJob, settingsKeys } from "../statuses/queries";
import { delayOptions } from "./model";

/**
 * "Sweep" (crm-shared.js:463), rewritten as what it now is: a SAFETY NET.
 *
 * The prototype's card offered "Auto-assign after" and "Outside business
 * hours: Hold until 9 AM", because the sweep WAS the assignment rail. It is
 * not any more — the rules assign every lead the moment it is captured, at
 * all hours (owner, 2026-09-13 14:50) — so the second select is gone with the
 * setting behind it, and the first is relabelled for the only job the sweep
 * still has: retrying the leads that arrived unassigned because no rule could
 * name a rep, because the Office responsible sync failed, or because
 * `CRM_AUTO_ASSIGN` was off at the time.
 *
 * The delay select writes `crm_settings.sweep` through `POST /settings`
 * (director) the moment it changes; the sweep job reads the same row.
 * "Notify" is the prototype's fixed line — the Teams/push fan-out is B3 / C9.
 * "Run sweep now" runs the `assign-sweep` job inline (the preview smoke, since
 * crons never fire there) and reports what it decided and applied.
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
          ? `Sweep: ${r.candidates} left unassigned · ${r.decisions.filter((d) => d.rep).length} the rules can place · picked up ${r.applied}`
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
      toast("Saved · applies to the next sweep");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const sweep = settingsQ.data?.settings.sweep ?? null;
  const busy = save.isPending;

  return (
    <div className="card" data-testid={RULES_TEST_IDS.sweep}>
      <div className="card-h">
        <h2>Sweep</h2>
        <div className="right">
          <Pill>Safety net</Pill>
        </div>
      </div>
      <div className="pad stack small">
        <div className="muted">
          Not a delay. The rules assign every lead the moment it arrives, at any hour — the sweep
          only picks up the ones that were left unassigned: no rule could name a rep, the BMI
          responsible write failed, or auto-assign was switched off when they came in. Leads held
          for someone are never touched by it.
        </div>
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
                Retry a lead left unassigned after
              </label>
              <select
                id={`${ids}-delay`}
                className="select"
                style={{ width: "auto" }}
                value={String(sweep.delayMinutes)}
                disabled={!canEdit || busy}
                onChange={(e) => save.mutate({ delayMinutes: Number(e.target.value) })}
              >
                {delayOptions(sweep.delayMinutes).map((o) => (
                  <option key={o.value} value={String(o.value)}>
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
                      {lastSweep.candidates} left unassigned · picked up {lastSweep.applied} ·{" "}
                      {lastSweep.reason}
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
