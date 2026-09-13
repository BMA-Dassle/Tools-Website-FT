"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ContractRow } from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { CANCEL_REASONS } from "~/features/crm/contracts/schemas";
import { money } from "~/features/crm/core/format";
import { leadsKeys } from "~/features/crm/leads/queries";
import { postCancel } from "../contracts/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";

/**
 * `gf-cancel` (crm-events.js:111).
 *
 * The banner says what the prototype's said, minus one claim it could not
 * keep: the CRM does NOT refund. It flips BMI to Cancellation and proves the
 * flip; `/api/cron/group-quote-sync` sees `-4` and does the money — drain the
 * internal gift cards first, then refund the card. Saying "refunds now" here
 * would be a promise made by a different process.
 *
 * If Office has not caught up by the time we finish polling, the toast says
 * so: "waiting for Office to confirm". Nothing is recorded as cancelled until
 * Office agrees.
 */
export interface CancelSheetProps {
  row: ContractRow;
  onCancel: () => void;
  onDone: () => void;
}

export function CancelSheet({ row, onCancel, onDone }: CancelSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [reason, setReason] = useState<string>(CANCEL_REASONS[0]);
  const [note, setNote] = useState("");

  const cancel = useMutation({
    mutationFn: () => postCancel(crmFetch, row.shortId!, { reason, note: note.trim() || null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: contractsKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      toast(r.message, r.verified ? "ok" : "warn");
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  return (
    <div className="stack">
      <Banner tone="crit" icon={<IconAlertTriangle {...ICON} />}>
        Flips BMI to <b>Cancellation</b>. Once BMI confirms it, the settlement cron drains the
        day-of gift card and refunds {money(row.collectedCents)} to the original card (3–5 business
        days) and emails the guest. Nothing is recorded as cancelled until BMI confirms.
      </Banner>
      <div className="field">
        <label htmlFor={`${id}-reason`}>Reason</label>
        <select
          id={`${id}-reason`}
          className="select"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {CANCEL_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-note`}>Note</label>
        <textarea
          id={`${id}-note`}
          className="textarea"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={cancel.isPending}>
          Keep event
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {cancel.isPending ? "Cancelling…" : "Cancel event"}
        </button>
      </div>
    </div>
  );
}
