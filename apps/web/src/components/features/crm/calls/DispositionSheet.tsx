"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CALL_DISPOSITIONS,
  type CallDisposition,
  type CallRow,
} from "~/features/crm/calls/contracts";
import { callsKeys } from "~/features/crm/calls/queries";
import { leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { postDisposition } from "./queries";
import { callTitle } from "./model";

/**
 * "When the call ends" — the six outcome buttons and the note box
 * (`crm-shared.js:256-257`), verbatim.
 *
 * Pressing an outcome saves immediately WITH whatever is in the note box, which
 * is what the prototype does and what a rep between calls wants; there is no
 * separate Save. The chosen button stays selected while the request is in
 * flight so a slow network cannot look like nothing happened.
 */
export function DispositionSheet({
  call,
  onDone,
}: {
  call: CallRow;
  onDone: (updated: CallRow) => void;
}) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<CallDisposition | null>(null);

  const save = useMutation({
    mutationFn: (disposition: CallDisposition) =>
      postDisposition(crmFetch, call.id, { disposition, note: note.trim() || null }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: callsKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      toast(
        res.firstTouchRecorded
          ? `Call logged · ${res.call.disposition} · first touch recorded`
          : `Call logged · ${res.call.disposition}`,
      );
      onDone(res.call);
    },
    onError: (err) => {
      setPicked(null);
      toast(errorMessage(err), "crit");
    },
  });

  return (
    <div data-testid="crm-disposition-sheet-body">
      <div className="eyebrow">When the call ends</div>
      <div className="grid grid-2">
        {CALL_DISPOSITIONS.map((o) => (
          <button
            key={o}
            type="button"
            className={`btn${picked === o ? " btn-primary" : ""}`}
            disabled={save.isPending}
            onClick={() => {
              setPicked(o);
              save.mutate(o);
            }}
          >
            {o}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor={`dispo-note-${call.id}`}>Note</label>
        <textarea
          id={`dispo-note-${call.id}`}
          className="textarea"
          placeholder="What did you learn?"
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="muted xs">
        Duration, direction and the recording link are captured automatically from 3CX.
        {call.leadId
          ? null
          : ` This call is not linked to a lead yet — link it from the Calls screen so it lands on their timeline.`}
      </div>
      <div className="muted xs" style={{ marginTop: 4 }}>
        {callTitle(call)}
      </div>
    </div>
  );
}
