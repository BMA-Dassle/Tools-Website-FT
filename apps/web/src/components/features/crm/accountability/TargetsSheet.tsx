"use client";

import { useState } from "react";
import type { RepAccountability, TargetsPostBody } from "~/features/crm/kpi/contracts";
import { CHANNELS } from "./model";

/**
 * "Weekly targets · <rep>" — the prototype's `targets` sheet
 * (crm-shared.js:418), which only toasted. This one writes.
 *
 * APPLIES FROM NEXT MONDAY, and the sheet says so because it is the whole
 * reason `crm_targets` is effective-dated: raising a target today would move
 * the bar under somebody who has already worked four days of the week against
 * the old one, and would retrospectively mark last week a failure.
 *
 * The numbers shown are the target for ONE week even when the screen is
 * showing four — the sheet edits the weekly rule, not the range in view.
 */
export interface TargetsSheetProps {
  rep: RepAccountability;
  /** Weekly targets, un-scaled (`weeks: 1`), whatever range the screen shows. */
  weekly: RepAccountability["target"];
  effectiveFrom: string;
  onCancel: () => void;
  onSubmit: (body: TargetsPostBody) => Promise<void>;
}

const RESPONSE_CHOICES = [30, 60, 120, 240];

export function TargetsSheet({
  rep,
  weekly,
  effectiveFrom,
  onCancel,
  onSubmit,
}: TargetsSheetProps) {
  const [values, setValues] = useState(() => ({
    calls: String(weekly.calls),
    texts: String(weekly.texts),
    emails: String(weekly.emails),
    reachouts: String(weekly.reachouts),
  }));
  const [responseTargetMinutes, setResponse] = useState(weekly.responseTargetMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const num = (v: string): number | null => {
    const t = v.trim();
    if (!/^\d{1,4}$/.test(t)) return null;
    return Number(t);
  };
  const parsed = {
    calls: num(values.calls),
    texts: num(values.texts),
    emails: num(values.emails),
    reachouts: num(values.reachouts),
  };
  const bad = Object.values(parsed).some((v) => v === null);

  const submit = async () => {
    if (bad || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        repSlug: rep.slug,
        calls: parsed.calls ?? 0,
        texts: parsed.texts ?? 0,
        emails: parsed.emails ?? 0,
        reachouts: parsed.reachouts ?? 0,
        responseTargetMinutes,
        effectiveFrom,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="grid grid-2">
        {CHANNELS.map((c) => (
          <div className="field" key={c.key}>
            <label htmlFor={`crm-target-${c.key}`}>{c.label} per week</label>
            <input
              id={`crm-target-${c.key}`}
              className="input tabular"
              inputMode="numeric"
              aria-invalid={parsed[c.key] === null ? "true" : undefined}
              value={values[c.key]}
              onChange={(e) => setValues({ ...values, [c.key]: e.target.value })}
            />
          </div>
        ))}
      </div>

      <div className="field">
        <label htmlFor="crm-target-response">Response-time target</label>
        <select
          id="crm-target-response"
          className="select"
          value={responseTargetMinutes}
          onChange={(e) => setResponse(Number(e.target.value))}
        >
          {RESPONSE_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
            </option>
          ))}
        </select>
      </div>

      <p className="muted xs">
        Applies from Monday {effectiveFrom} — the week in progress keeps the targets it started
        with. {rep.firstName} sees these on My Day.
      </p>

      {bad ? (
        <p className="xs" style={{ color: "var(--crit-ink)" }}>
          Every target has to be a whole number of activities.
        </p>
      ) : null}
      {error ? (
        <p className="xs" style={{ color: "var(--crit-ink)" }}>
          {error}
        </p>
      ) : null}

      <div className="hstack" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={bad || busy}
        >
          {busy ? "Saving…" : "Save targets"}
        </button>
      </div>
    </div>
  );
}
