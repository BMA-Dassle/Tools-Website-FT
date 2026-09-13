"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ContractRow } from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { leadsKeys } from "~/features/crm/leads/queries";
import { postDeny } from "../contracts/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";

/**
 * `gf-deny` (crm-events.js:103). The reason is emailed to the planner, so it
 * is required — the API refuses an empty one too, rather than sending a blank
 * explanation to someone whose booking just stopped.
 */
export interface DenySheetProps {
  row: ContractRow;
  onCancel: () => void;
  onDone: () => void;
}

export function DenySheet({ row, onCancel, onDone }: DenySheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [reason, setReason] = useState("");

  const deny = useMutation({
    mutationFn: () => postDeny(crmFetch, row.shortId!, reason.trim()),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: contractsKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      toast(r.message, "warn");
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor={`${id}-reason`}>Reason (sent to the planner)</label>
        <textarea
          id={`${id}-reason`}
          className="textarea"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. No youth products; collect a standard deposit."
        />
      </div>
      <div className="xs muted">
        Recorded as denied by you. The contract is not sent; {row.plannerName ?? "the planner"} gets
        the reason by email.
      </div>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={deny.isPending}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={reason.trim().length < 3 || deny.isPending}
          onClick={() => deny.mutate()}
        >
          {deny.isPending ? "Denying…" : "Deny"}
        </button>
      </div>
    </div>
  );
}
