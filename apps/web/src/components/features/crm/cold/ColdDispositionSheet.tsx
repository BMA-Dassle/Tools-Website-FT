"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconMessageOff } from "@tabler/icons-react";
import {
  COLD_CALLBACK,
  COLD_DISPOSITIONS,
  COLD_INTERESTED,
  COLD_NO_TEXT_REASON,
  COLD_TEST_IDS,
  type ColdDisposition,
  type ColdRowView,
} from "~/features/crm/cold/contracts";
import { coldKeys } from "~/features/crm/cold/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { rowNumber, rowTitle } from "./model";
import { postColdRowAction } from "./queries";

/**
 * "When the call ends" for a cold row — the Calls screen's six outcomes with
 * "Interested" in front of them, and a date box that appears only for the one
 * outcome that promises a time.
 *
 * Pressing an outcome saves immediately with whatever is in the note box,
 * exactly as the Calls disposition sheet does; a rep between calls should not
 * have to find a Save button.
 *
 * "Interested" is not saved here — it hands over to the Convert sheet, because
 * interest is the moment the prospect becomes a lead and that needs the event
 * they are interested IN.
 */
export function ColdDispositionSheet({
  row,
  onDone,
  onInterested,
}: {
  row: ColdRowView;
  onDone: (updated: ColdRowView) => void;
  onInterested: (row: ColdRowView) => void;
}) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const [note, setNote] = useState(row.dispositionNote ?? "");
  const [callbackAt, setCallbackAt] = useState("");
  const [picked, setPicked] = useState<ColdDisposition | null>(null);

  const save = useMutation({
    mutationFn: (disposition: ColdDisposition) =>
      postColdRowAction(crmFetch, row.listId, row.id, {
        action: "disposition",
        disposition,
        note: note.trim() || null,
        callbackAt: disposition === COLD_CALLBACK && callbackAt ? isoFromLocal(callbackAt) : null,
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: coldKeys.all });
      toast(`Logged · ${res.row.disposition}`);
      onDone(res.row);
    },
    onError: (err) => {
      setPicked(null);
      toast(errorMessage(err), "crit");
    },
  });

  const needsCallback = picked === COLD_CALLBACK;

  return (
    <div data-testid={COLD_TEST_IDS.dispositionSheet}>
      <div className="eyebrow">When the call ends</div>
      <div className="grid grid-2">
        {COLD_DISPOSITIONS.map((o) => (
          <button
            key={o}
            type="button"
            className={`btn${picked === o ? " btn-primary" : ""}`}
            disabled={save.isPending}
            onClick={() => {
              setPicked(o);
              if (o === COLD_INTERESTED) {
                onInterested(row);
                return;
              }
              if (o === COLD_CALLBACK && !callbackAt) return;
              save.mutate(o);
            }}
          >
            {o}
          </button>
        ))}
      </div>

      {needsCallback ? (
        <div className="field">
          <label htmlFor={`cold-callback-${row.id}`}>Call them back at</label>
          <input
            id={`cold-callback-${row.id}`}
            className="input"
            type="datetime-local"
            value={callbackAt}
            onChange={(e) => setCallbackAt(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            style={{ marginTop: 8 }}
            disabled={!callbackAt || save.isPending}
            onClick={() => save.mutate(COLD_CALLBACK)}
          >
            Save the callback
          </button>
        </div>
      ) : null}

      <div className="field">
        <label htmlFor={`cold-note-${row.id}`}>Note</label>
        <textarea
          id={`cold-note-${row.id}`}
          className="textarea"
          placeholder="What did you learn?"
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <Banner tone="info" icon={<IconMessageOff {...ICON} />} testId={COLD_TEST_IDS.noText}>
        {COLD_NO_TEXT_REASON}
      </Banner>

      {row.matchedBy ? (
        <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
          This row is linked to {row.accountName ?? "an account we already have"} — check their
          history before you pitch.
        </Banner>
      ) : null}

      <div className="muted xs">
        {rowTitle(row)}
        {rowNumber(row) ? ` · ${rowNumber(row)}` : ""}
        {row.touchCount
          ? ` · ${row.touchCount} previous ${row.touchCount === 1 ? "call" : "calls"}`
          : ""}
      </div>
    </div>
  );
}

/**
 * `<input type="datetime-local">` hands back wall-clock text with no zone. The
 * rep is in Eastern time and so is the browser, so `new Date(local)` is their
 * intent; the server stores the instant. Anything unparseable becomes null
 * rather than an invalid date.
 */
export function isoFromLocal(local: string): string | null {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
