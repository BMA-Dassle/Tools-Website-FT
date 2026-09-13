"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ACTIVITY_TEST_IDS,
  SNOOZE_PRESETS,
  type SnoozePresetId,
} from "~/features/crm/activities/contracts";
import { activitiesKeys } from "~/features/crm/activities/queries";
import { fStamp } from "~/features/crm/core/dates";
import type { LeadView } from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { pipelineKeys } from "~/features/crm/statuses/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { postActivity } from "./queries";

/**
 * "Snooze follow-up" (crm-shared.js:278) — the prototype's four buttons, with
 * its labels, landing at 9 AM Eastern. The server computes the instant (a real
 * next-Monday, not the prototype's hard-coded +2 days) so the answer does not
 * depend on the rep's laptop clock, and the toast repeats what it chose.
 */
export interface SnoozeSheetProps {
  lead: LeadView;
  onDone: () => void;
  onCancel: () => void;
}

export function SnoozeSheet({ lead, onDone, onCancel }: SnoozeSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<SnoozePresetId | null>(null);

  const snooze = useMutation({
    mutationFn: (preset: SnoozePresetId) =>
      postActivity(crmFetch, lead.publicId, { kind: "snooze", preset }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      void qc.invalidateQueries({ queryKey: pipelineKeys.all });
      void qc.invalidateQueries({ queryKey: activitiesKeys.timeline(lead.publicId) });
      const due = r.lead.nextAction?.due;
      toast(due ? `Snoozed to ${fStamp(due)}` : "Follow-up snoozed");
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
    onSettled: () => setPending(null),
  });

  return (
    <div className="stack" data-testid={ACTIVITY_TEST_IDS.snoozeSheet}>
      <div className="grid grid-2">
        {SNOOZE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn"
            disabled={snooze.isPending}
            onClick={() => {
              setPending(p.id);
              snooze.mutate(p.id);
            }}
          >
            {pending === p.id && snooze.isPending ? "Snoozing…" : p.label}
          </button>
        ))}
      </div>
      <div className="xs muted">
        Each lands at 9 AM Eastern. The follow-up keeps its label; only the time moves.
      </div>
      <div className="hstack">
        <button type="button" className="btn" onClick={onCancel} disabled={snooze.isPending}>
          Cancel
        </button>
      </div>
    </div>
  );
}
