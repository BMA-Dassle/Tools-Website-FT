"use client";

import { useId, useState, type FormEvent } from "react";
import {
  STATUS_KINDS,
  type CrmStatus,
  type CrmStatusInput,
  type StatusKind,
} from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { Banner } from "../primitives/Banner";
import { slugify } from "./model";

/**
 * Add / edit one status — the body of the sheet the "Add status" and pencil
 * buttons open. The id is derived from the label for a NEW status until the
 * director types their own; an existing status keeps its id (leads reference
 * it) and only the label, kind, SLA and board flag change.
 */
export interface StatusFormProps {
  initial?: CrmStatus;
  /** Where a new status lands in the order. */
  nextPosition: number;
  onSubmit: (input: CrmStatusInput) => Promise<void>;
  onCancel: () => void;
}

export function StatusForm({ initial, nextPosition, onSubmit, onCancel }: StatusFormProps) {
  const ids = useId();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [id, setId] = useState(initial?.id ?? "");
  const [idTouched, setIdTouched] = useState(!!initial);
  const [kind, setKind] = useState<StatusKind>(initial?.kind ?? "open");
  const [slaLabel, setSlaLabel] = useState(initial?.slaLabel ?? "");
  const [slaHours, setSlaHours] = useState(
    initial?.slaHours === null || initial?.slaHours === undefined ? "" : String(initial.slaHours),
  );
  const [onBoard, setOnBoard] = useState(initial?.onBoard ?? true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveId = idTouched ? id : slugify(label);
  const isNew = !initial;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return setError("A label is required.");
    if (!effectiveId) return setError("An id is required.");
    const hours = slaHours.trim() === "" ? null : Number(slaHours);
    if (hours !== null && (!Number.isFinite(hours) || hours < 0))
      return setError("SLA hours must be a number.");
    setError(null);
    setPending(true);
    try {
      await onSubmit({
        id: effectiveId,
        label: label.trim(),
        kind,
        position: initial?.position ?? nextPosition,
        slaLabel: slaLabel.trim() || null,
        slaHours: hours,
        onBoard,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${ids}-label`}>Label</label>
        <input
          id={`${ids}-label`}
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Waiting on guest"
          required
        />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${ids}-id`}>Id</label>
          <input
            id={`${ids}-id`}
            className="input mono"
            value={effectiveId}
            readOnly={!isNew}
            onChange={(e) => {
              setIdTouched(true);
              setId(slugify(e.target.value));
            }}
            placeholder="waiting-on-guest"
          />
        </div>
        <div className="field">
          <label htmlFor={`${ids}-kind`}>Counts as</label>
          <select
            id={`${ids}-kind`}
            className="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as StatusKind)}
          >
            {STATUS_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${ids}-sla`}>SLA (shown on the board)</label>
          <input
            id={`${ids}-sla`}
            className="input"
            value={slaLabel}
            onChange={(e) => setSlaLabel(e.target.value)}
            placeholder="e.g. 48 h follow-up"
          />
        </div>
        <div className="field">
          <label htmlFor={`${ids}-hours`}>SLA hours</label>
          <input
            id={`${ids}-hours`}
            className="input tabular"
            inputMode="numeric"
            value={slaHours}
            onChange={(e) => setSlaHours(e.target.value)}
            placeholder="48"
          />
        </div>
      </div>
      <label className="hstack small" htmlFor={`${ids}-board`}>
        <input
          id={`${ids}-board`}
          type="checkbox"
          checked={onBoard}
          onChange={(e) => setOnBoard(e.target.checked)}
        />
        Show as a column on the pipeline board
      </label>
      {error ? <Banner tone="crit">{error}</Banner> : null}
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : isNew ? "Add status" : "Save"}
        </button>
      </div>
    </form>
  );
}
