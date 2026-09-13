"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ContractRow } from "~/features/crm/contracts/contracts";
import { contractsKeys } from "~/features/crm/contracts/queries";
import { postResend } from "../contracts/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Kv } from "../primitives/Kv";

/**
 * `gf-resend` (crm-events.js:105).
 *
 * DELIBERATE DIFFERENCE FROM THE PROTOTYPE, and it is the honest one: the
 * mock offered a channel picker ("Email + text / Email only / Text only") and
 * one-off phone and email overrides. `notifyContractSent` — the rail the
 * automatic send uses, and the one that must be reused so a resend is not a
 * second implementation of the contract email — sends both channels to the
 * contract's own contact details and takes no options. A picker that always
 * did both would be a lie, and an "override" would have to EDIT the contract's
 * contact fields to work, which is a different and much bigger action.
 *
 * So the sheet states exactly what will happen and to whom, and offers a note
 * for the timeline. Changing where a contract goes is an edit to the contract.
 */
export interface ResendSheetProps {
  row: ContractRow;
  onCancel: () => void;
  onDone: () => void;
}

export function ResendSheet({ row, onCancel, onDone }: ResendSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [note, setNote] = useState("");

  const resend = useMutation({
    mutationFn: () => postResend(crmFetch, row.shortId!, note.trim() || null),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: contractsKeys.all });
      toast(r.message);
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  return (
    <div className="stack">
      <Kv
        rows={[
          { label: "Email", value: row.guestEmail || "—" },
          { label: "Text", value: row.guestPhone || "no phone on file" },
          { label: "Link", value: <span className="mono">#{row.shortId}</span> },
        ]}
      />
      <div className="field">
        <label htmlFor={`${id}-note`}>Note for the timeline (optional)</label>
        <input
          id={`${id}-note`}
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Angela said the first email went to spam"
        />
      </div>
      <div className="xs muted">
        Same link, same version, email and text together — the rail the automatic send uses. Logged
        on the timeline and in the BMI private notes. To send it somewhere else, change the
        contract&apos;s contact details first.
      </div>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={resend.isPending}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
        >
          {resend.isPending ? "Resending…" : "Resend"}
        </button>
      </div>
    </div>
  );
}
