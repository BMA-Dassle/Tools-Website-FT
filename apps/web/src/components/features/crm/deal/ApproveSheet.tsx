"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { contractsKeys } from "~/features/crm/contracts/queries";
import type { ContractRow } from "~/features/crm/contracts/contracts";
import { money } from "~/features/crm/core/format";
import { leadsKeys } from "~/features/crm/leads/queries";
import { postApprove } from "../contracts/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";

/**
 * `gf-approve` (crm-events.js:101): approve a post-paid contract and send it
 * with no deposit.
 *
 * The memo is REQUIRED here even though the API takes it as optional. The
 * prototype demanded one "because of the warning"; the real row has no
 * warnings field to hang that on, and an approval that waives a 50% deposit
 * with no stated reason is exactly the record nobody can reconstruct later.
 * The approver is the signed-in user — there is no address field, by design.
 */
export interface ApproveSheetProps {
  row: ContractRow;
  onCancel: () => void;
  onDone: () => void;
}

export function ApproveSheet({ row, onCancel, onDone }: ApproveSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [memo, setMemo] = useState("");

  const approve = useMutation({
    mutationFn: () => postApprove(crmFetch, row.shortId!, memo.trim()),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: contractsKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      toast(r.message);
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  return (
    <div className="stack">
      <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
        <b>Post-paid account.</b> Approve to send the contract with no deposit —{" "}
        {money(row.totalCents)} is invoiced after the event — or deny with a reason.
      </Banner>
      <div className="field">
        <label htmlFor={`${id}-memo`}>Approval memo (recorded with your name)</label>
        <textarea
          id={`${id}-memo`}
          className="textarea"
          rows={3}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="Why this post-paid approval is appropriate…"
        />
      </div>
      <div className="xs muted">
        Recorded as approved by you. The contract sends immediately with no deposit, and the guest
        gets the 5-step signing page by email and text.
      </div>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={approve.isPending}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={memo.trim().length < 3 || approve.isPending}
          onClick={() => approve.mutate()}
        >
          {approve.isPending ? "Approving…" : "Approve & send"}
        </button>
      </div>
    </div>
  );
}
