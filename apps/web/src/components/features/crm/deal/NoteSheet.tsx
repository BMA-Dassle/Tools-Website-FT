"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ACTIVITY_TEST_IDS } from "~/features/crm/activities/contracts";
import { activitiesKeys } from "~/features/crm/activities/queries";
import type { LeadView } from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { postActivity } from "./queries";

/**
 * "Add note" (crm-shared.js:276). The placeholder is the prototype's, verbatim
 * — "Private to the sales team. Never written to BMI." — and the service keeps
 * that promise: the note lands in `crm_activities` and nowhere else (R6).
 * BMI's own notes are the Notes tab's job, through the two existing rails.
 */
export interface NoteSheetProps {
  lead: LeadView;
  onDone: () => void;
  onCancel: () => void;
}

export function NoteSheet({ lead, onDone, onCancel }: NoteSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const [body, setBody] = useState("");

  const save = useMutation({
    mutationFn: () => postActivity(crmFetch, lead.publicId, { kind: "note", body: body.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      void qc.invalidateQueries({ queryKey: activitiesKeys.timeline(lead.publicId) });
      toast("Note saved");
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  return (
    <div className="stack" data-testid={ACTIVITY_TEST_IDS.noteSheet}>
      <div className="field">
        <label htmlFor="crm-note-body">Note</label>
        <textarea
          id="crm-note-body"
          className="textarea"
          rows={4}
          value={body}
          placeholder="Private to the sales team. Never written to BMI."
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <div className="hstack">
        <button type="button" className="btn" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!body.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}
