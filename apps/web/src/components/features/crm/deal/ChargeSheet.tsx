"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ContractRow } from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { money } from "~/features/crm/core/format";
import { postChargeBalance, postSendBalanceLink } from "../contracts/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";

/**
 * `gf-charge` and `gf-link` (crm-events.js:107, 109) in one sheet, because
 * they are the same decision seen twice: take the money now, or ask for it.
 *
 * `mode="card"` charges the card on file through the SAME code the 72-hour
 * cron runs; its atomic claim is what stops the two from both taking the
 * money. `mode="link"` sends our own pay page and touches no card — it is not
 * a decline, and nothing is recorded as one.
 */
export interface ChargeSheetProps {
  row: ContractRow;
  mode: "card" | "link";
  onCancel: () => void;
  onDone: () => void;
}

export function ChargeSheet({ row, mode, onCancel, onDone }: ChargeSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [reason, setReason] = useState("");

  const run = useMutation({
    mutationFn: () =>
      mode === "card"
        ? postChargeBalance(crmFetch, row.shortId!, reason.trim() || null)
        : postSendBalanceLink(crmFetch, row.shortId!, reason.trim() || null),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: contractsKeys.all });
      toast(r.message);
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const card =
    row.savedCardBrand && row.savedCardLast4
      ? `${row.savedCardBrand} •${row.savedCardLast4}`
      : "the card on file";

  return (
    <div className="stack">
      <div className="small">
        {mode === "card" ? (
          <>
            Charges <b>{money(row.balanceCents)}</b> to {card} and loads it onto the day-of gift
            card. Normally this happens automatically 72 hours before the event.
          </>
        ) : (
          <>
            Emails and texts the guest a link to pay <b>{money(row.balanceCents)}</b> on our own
            payment page. No card is charged.
          </>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${id}-reason`}>Why now? (recorded)</label>
        <input
          id={`${id}-reason`}
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Guest asked to pay early"
        />
      </div>
      <div className="xs muted">
        Runs the same code as the 72-hour cron, including its claim — if the cron is already working
        on this event, this reports that instead of charging twice.
      </div>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={run.isPending}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending
            ? mode === "card"
              ? "Charging…"
              : "Sending…"
            : mode === "card"
              ? "Charge card"
              : "Send payment link"}
        </button>
      </div>
    </div>
  );
}
