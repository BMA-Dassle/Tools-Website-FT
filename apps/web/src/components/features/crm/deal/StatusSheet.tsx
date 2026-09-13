"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { centreByCode } from "~/features/crm/core/centres";
import type { LeadView } from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { PIPELINE_TEST_IDS } from "~/features/crm/statuses/contracts";
import { pipelineKeys } from "~/features/crm/statuses/queries";
import { transitionToastFor } from "~/features/crm/statuses/service/bmi-state";
import { activitiesKeys } from "~/features/crm/activities/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Chip } from "../primitives/Chip";
import { LoadingState } from "../primitives/States";
import { statusOptions } from "../pipeline/model";
import { fetchStatuses, statusesKeys } from "../statuses/queries";
import { postLeadStatus } from "./queries";

/**
 * "Change status" (crm-shared.js:280) — one row per status, each stating what
 * it will do in Office FOR THIS LEAD'S CENTRE before it is pressed.
 *
 * The prototype promised "Writes BMI state X" unconditionally. That sentence
 * is only true when the status has a `crm_status_bmi_map` row for the tenant,
 * and on day one most do not (the New Lead / Contacted / Quote ids are unknown
 * per centre until a director confirms them on Statuses & BMI). So each row
 * says which of the three things will actually happen — write, move the CRM
 * only, or "set from the Contract tab" for a built-in state — and the toast
 * afterwards repeats what DID happen.
 *
 * A lost status asks for a reason before it will commit. Nobody has to explain
 * a win.
 */
export interface StatusSheetProps {
  lead: LeadView;
  onDone: () => void;
  onCancel: () => void;
}

export function StatusSheet({ lead, onDone, onCancel }: StatusSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const [lostReason, setLostReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const q = useQuery({
    queryKey: statusesKeys.list(),
    queryFn: () => fetchStatuses(crmFetch),
    staleTime: 5 * 60_000,
  });

  const move = useMutation({
    mutationFn: (statusId: string) =>
      postLeadStatus(crmFetch, lead.publicId, {
        statusId,
        lostReason: lostReason.trim() || null,
        note: null,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      void qc.invalidateQueries({ queryKey: pipelineKeys.all });
      void qc.invalidateQueries({ queryKey: activitiesKeys.timeline(lead.publicId) });
      const t = transitionToastFor(r.status.label, r.bmi);
      toast(t.text, t.kind);
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
    onSettled: () => setPending(null),
  });

  if (q.isPending) return <LoadingState label="Loading statuses…" />;

  const clientKey = centreByCode(lead.centre).clientKey;
  const options = statusOptions(q.data?.statuses ?? [], lead, q.data?.map ?? [], clientKey);
  const needsReason = (id: string) =>
    options.find((o) => o.status.id === id)?.status.kind === "lost" && !lostReason.trim();

  return (
    <div className="stack" data-testid={PIPELINE_TEST_IDS.statusSheet}>
      <div className="field">
        <label htmlFor="crm-lost-reason">Reason (required to mark a lead lost)</label>
        <input
          id="crm-lost-reason"
          className="input"
          value={lostReason}
          placeholder="Booked elsewhere · price · date unavailable"
          onChange={(e) => setLostReason(e.target.value)}
        />
      </div>
      <div className="stack">
        {options.map((o) => {
          const blocked = o.current || move.isPending || needsReason(o.status.id);
          return (
            <button
              key={o.status.id}
              type="button"
              className={o.current ? "opt pick" : "opt"}
              disabled={blocked}
              aria-current={o.current ? "true" : undefined}
              title={
                o.current
                  ? "Already in this status"
                  : needsReason(o.status.id)
                    ? "Give a reason first"
                    : undefined
              }
              onClick={() => {
                setPending(o.status.id);
                move.mutate(o.status.id);
              }}
            >
              <Chip kind={o.status.kind} st={o.status.id}>
                {o.status.label}
              </Chip>
              <div className="why">{o.why}</div>
              <span className="xs muted">
                {pending === o.status.id && move.isPending ? "Saving…" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <div className="hstack">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
