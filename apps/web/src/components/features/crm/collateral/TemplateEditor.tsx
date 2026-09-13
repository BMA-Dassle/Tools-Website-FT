"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { MessageTemplate, TemplateUpsertInput } from "~/features/crm/collateral/contracts";
import { COLLATERAL_TEST_IDS } from "~/features/crm/collateral/contracts";
import {
  MERGE_FIELDS,
  gsm7Verdict,
  previewValues,
  renderSegments,
  smsSegments,
  type PreviewLead,
} from "~/features/crm/collateral/service/merge";
import { CENTRES, CENTRE_CODES } from "~/features/crm/core/centres";
import type { CentreCode } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { Banner } from "../primitives/Banner";
import { collateralMessage } from "./model";

/**
 * Edit one message template — the prototype's `edit-tpl` sheet
 * (`crm-shared.js:485`): the form on the left, a live preview on the right,
 * and the merge-field buttons under the body.
 *
 * THE PREVIEW IS THE POINT. The prototype rendered `merge(t.body, lead)` as
 * plain text, so a field the lead had no value for came out as a literal
 * `{{hold.until}}` and a rep had to notice it. Here every field is a segment:
 * one that resolved is normal text, one that did NOT is marked — so the
 * prototype's own promise, "missing fields highlight before sending", is
 * actually kept. A blank is never rendered for a missing field, because a
 * blank is the version a rep sends by mistake.
 *
 * GSM-7 is enforced live for SMS bodies, not only on save: a single em dash
 * halves the segment length and doubles the bill, and the seeded "Quote nudge
 * (48 h)" template ships with one. The Save button is disabled while a body is
 * unsafe, with the offending character named — the server refuses it too
 * (`/collateral/templates` → 422), so this is a courtesy, not the control.
 */
export interface TemplateEditorProps {
  initial?: MessageTemplate;
  onSubmit: (input: TemplateUpsertInput) => Promise<void>;
  onCancel: () => void;
}

/**
 * Two value sets, both built at MODULE scope (never in a render body —
 * `feedback_tdz_component_const_helpers`).
 *
 * The default is the lead with GAPS, and that is the whole point of the
 * preview: against a value set where all twelve fields are filled, nothing is
 * ever missing, the highlight never paints, and the caption below the preview
 * describes a behaviour the director cannot see. The prototype's own preview
 * lead (Lee Health, L-1042) has no hold, no event last year and no quote sent
 * — the three fields most templates go blank on in real life.
 */
const PREVIEW_SETS: Record<PreviewLead, ReturnType<typeof previewValues>> = {
  typical: previewValues("typical"),
  complete: previewValues("complete"),
};

export function TemplateEditor({ initial, onSubmit, onCancel }: TemplateEditorProps) {
  const ids = useId();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [kind, setKind] = useState<"sms" | "email">(initial?.kind ?? "sms");
  const [name, setName] = useState(initial?.name ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [centre, setCentre] = useState<string>(initial?.centre ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewLead, setPreviewLead] = useState<PreviewLead>("typical");

  const segments = useMemo(
    () => renderSegments(body, PREVIEW_SETS[previewLead]),
    [body, previewLead],
  );
  const gsm7 = useMemo(() => (kind === "sms" ? gsm7Verdict(body) : null), [kind, body]);
  const unknown = useMemo(
    () => [...new Set(segments.flatMap((s) => (s.kind === "field" && s.unknown ? [s.key] : [])))],
    [segments],
  );
  const segments7 = kind === "sms" ? smsSegments(body) : 0;
  const blocked = Boolean(gsm7 && !gsm7.ok);

  /**
   * Insert at the caret rather than appending: a director fixing the middle of
   * a sentence should not have the token land at the end.
   */
  const insert = (key: string) => {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    if (!el) return setBody(body + token);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? start;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the template a name.");
    if (!body.trim()) return setError("The body cannot be empty.");
    if (blocked) {
      return setError(
        `${JSON.stringify(gsm7?.offending)} is not a plain text character — a text containing it costs twice as much to send. Replace it.`,
      );
    }
    setError(null);
    setPending(true);
    try {
      await onSubmit({
        id: initial?.id,
        kind,
        name: name.trim(),
        subject: kind === "email" ? subject.trim() || null : null,
        body,
        centre: (centre || null) as CentreCode | null,
        position: initial?.position,
      });
    } catch (err) {
      setError(collateralMessage(errorMessage(err)));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="grid grid-2"
      onSubmit={submit}
      data-testid={COLLATERAL_TEST_IDS.templateEditor}
    >
      <div className="stack">
        <div className="seg" role="group" aria-label="Template kind">
          <button
            type="button"
            aria-pressed={kind === "sms"}
            onClick={() => setKind("sms")}
            disabled={pending || Boolean(initial)}
          >
            Text
          </button>
          <button
            type="button"
            aria-pressed={kind === "email"}
            onClick={() => setKind("email")}
            disabled={pending || Boolean(initial)}
          >
            Email
          </button>
        </div>

        <div className="field">
          <label htmlFor={`${ids}-name`}>Name</label>
          <input
            id={`${ids}-name`}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
          />
        </div>

        {kind === "email" ? (
          <div className="field">
            <label htmlFor={`${ids}-subject`}>Subject</label>
            <input
              id={`${ids}-subject`}
              className="input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={pending}
            />
          </div>
        ) : null}

        <div className="field">
          <label htmlFor={`${ids}-body`}>Body</label>
          <textarea
            id={`${ids}-body`}
            ref={bodyRef}
            className="textarea"
            rows={7}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="hstack" style={{ flexWrap: "wrap" }}>
          {MERGE_FIELDS.map((f) => (
            <button
              key={f.key}
              type="button"
              className="btn btn-sm"
              onClick={() => insert(f.key)}
              disabled={pending}
              title={f.label}
            >{`{{${f.key}}}`}</button>
          ))}
        </div>

        <div className="field">
          <label htmlFor={`${ids}-centre`}>Centre</label>
          <select
            id={`${ids}-centre`}
            className="select"
            value={centre}
            onChange={(e) => setCentre(e.target.value)}
            disabled={pending}
          >
            <option value="">All centres</option>
            {CENTRE_CODES.map((c) => (
              <option key={c} value={c}>
                {CENTRES[c].name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="stack">
        <div className="eyebrow">Preview</div>
        <div className="seg" role="group" aria-label="Preview this against">
          <button
            type="button"
            aria-pressed={previewLead === "typical"}
            onClick={() => setPreviewLead("typical")}
            disabled={pending}
          >
            A typical lead
          </button>
          <button
            type="button"
            aria-pressed={previewLead === "complete"}
            onClick={() => setPreviewLead("complete")}
            disabled={pending}
          >
            Every field filled
          </button>
        </div>
        <div className="bubble out" style={{ whiteSpace: "pre-wrap" }}>
          {segments.map((s, i) =>
            s.kind === "field" && (s.missing || s.unknown) ? (
              <mark
                key={`${s.key}-${i}`}
                style={{
                  background: "var(--warn-bg, rgba(245,158,11,.22))",
                  color: "inherit",
                  borderRadius: 4,
                  padding: "0 2px",
                }}
              >
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </div>
        <div className="xs muted">
          {previewLead === "typical"
            ? "A typical lead has no lane hold, no event with us last year and no quote sent yet. Those fields stay highlighted here and go out looking exactly like that — fix them before you send."
            : "Every field filled — how this reads for a lead that has all of it."}
        </div>

        {unknown.length > 0 ? (
          <Banner tone="warn">
            {unknown.map((k) => `{{${k}}}`).join(", ")} {unknown.length === 1 ? "is" : "are"} not a
            merge field — check the spelling.
          </Banner>
        ) : null}

        {gsm7 && !gsm7.ok ? (
          <Banner tone="crit">
            {JSON.stringify(gsm7.offending)} is not a plain text character. A text containing it
            costs twice as much to send — replace it before saving.
          </Banner>
        ) : null}

        {kind === "sms" && !blocked && body ? (
          <div className="xs muted">
            {body.length} characters · {segments7} segment{segments7 === 1 ? "" : "s"}
          </div>
        ) : null}

        {error ? <Banner tone="crit">{error}</Banner> : null}

        <div className="hstack" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={pending || blocked}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}
