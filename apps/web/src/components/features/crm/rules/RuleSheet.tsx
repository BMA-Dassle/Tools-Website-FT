"use client";

import { useId, useState, type FormEvent } from "react";
import type { PublicRep } from "~/features/crm/core/contracts";
import {
  EVENT_TYPES,
  LEAD_SOURCES,
  type AssignmentRule,
  type CentreCode,
  type EventType,
  type LeadSource,
} from "~/features/crm/core/types";
import type { RuleInputWire } from "~/features/crm/rules/contracts";
import { EVENT_TYPE_LABEL, LEAD_SOURCE_LABEL } from "~/features/crm/rules/labels";
import { errorMessage } from "../lib/crm-fetch";
import { Banner } from "../primitives/Banner";
import {
  ACTION_OPTIONS,
  actionNeedsPerson,
  formFromRule,
  monthOptions,
  ruleFromForm,
  type CentreOption,
  type RuleAction,
  type RuleForm,
} from "./model";

/**
 * The rule sheet (`ruleSheet`, crm-shared.js:472): Name · When (guests at
 * least / at most, event type, centre, source, party month) · Then (action,
 * person / team) · the hold explainer. Beyond the prototype: a "Why" line
 * (every seeded rule shows one) and a kids-only box that appears for
 * birthdays, so editing R2 keeps `kids: true`; the two availability kinds are
 * selectable so R4 / R5 can be edited without losing their kind.
 */
export interface RuleSheetProps {
  initial?: AssignmentRule;
  reps: PublicRep[];
  centres: CentreOption[];
  /** ET YYYY-MM-DD — anchors the party-month options. */
  todayYmd: string;
  onSubmit: (rule: RuleInputWire) => Promise<void>;
  onCancel: () => void;
}

export function RuleSheet({
  initial,
  reps,
  centres,
  todayYmd,
  onSubmit,
  onCancel,
}: RuleSheetProps) {
  const ids = useId();
  const [form, setForm] = useState<RuleForm>(() => formFromRule(initial, reps));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const months = monthOptions(todayYmd);
  if (form.partyMonth && !months.some((m) => m.value === form.partyMonth)) {
    months.unshift({ value: form.partyMonth, label: form.partyMonth });
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const out = ruleFromForm(form, initial?.id);
    if ("error" in out) return setError(out.error);
    setError(null);
    setPending(true);
    try {
      await onSubmit(out.rule);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${ids}-name`}>Name</label>
        <input
          id={`${ids}-name`}
          className="input"
          value={form.label}
          onChange={(e) => set("label", e.target.value)}
          placeholder="e.g. Holiday parties in December go to Lori"
          required
        />
      </div>
      <div className="field">
        <label htmlFor={`${ids}-why`}>Why</label>
        <input
          id={`${ids}-why`}
          className="input"
          value={form.why}
          onChange={(e) => set("why", e.target.value)}
        />
      </div>

      <div className="eyebrow">When</div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${ids}-min`}>Guests at least</label>
          <input
            id={`${ids}-min`}
            className="input tabular"
            inputMode="numeric"
            value={form.guestsMin}
            onChange={(e) => set("guestsMin", e.target.value)}
            placeholder="any"
          />
        </div>
        <div className="field">
          <label htmlFor={`${ids}-max`}>Guests at most</label>
          <input
            id={`${ids}-max`}
            className="input tabular"
            inputMode="numeric"
            value={form.guestsMax}
            onChange={(e) => set("guestsMax", e.target.value)}
            placeholder="any"
          />
        </div>
        <div className="field">
          <label htmlFor={`${ids}-type`}>Event type</label>
          <select
            id={`${ids}-type`}
            className="select"
            value={form.type}
            onChange={(e) => set("type", e.target.value as EventType | "")}
          >
            <option value="">Any</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          {form.type === "birthday" ? (
            <label className="hstack small" htmlFor={`${ids}-kids`} style={{ marginTop: 6 }}>
              <input
                id={`${ids}-kids`}
                type="checkbox"
                checked={form.kids}
                onChange={(e) => set("kids", e.target.checked)}
              />
              Kids only
            </label>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={`${ids}-centre`}>Centre</label>
          <select
            id={`${ids}-centre`}
            className="select"
            value={form.centre}
            onChange={(e) => set("centre", e.target.value as CentreCode | "")}
          >
            <option value="">Any</option>
            {centres.map((c) => (
              <option key={c.code} value={c.code}>
                {c.short}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${ids}-source`}>Source</label>
          <select
            id={`${ids}-source`}
            className="select"
            value={form.source}
            onChange={(e) => set("source", e.target.value as LeadSource | "")}
          >
            <option value="">Any</option>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {LEAD_SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${ids}-month`}>Party month</label>
          <select
            id={`${ids}-month`}
            className="select"
            value={form.partyMonth}
            onChange={(e) => set("partyMonth", e.target.value)}
          >
            <option value="">Any</option>
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="eyebrow">Then</div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${ids}-action`}>Action</label>
          <select
            id={`${ids}-action`}
            className="select"
            value={form.action}
            onChange={(e) => set("action", e.target.value as RuleAction)}
          >
            {ACTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${ids}-person`}>Person / team</label>
          <select
            id={`${ids}-person`}
            className="select"
            value={form.person}
            disabled={!actionNeedsPerson(form.action)}
            onChange={(e) => set("person", e.target.value)}
          >
            {reps.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="xs muted">
        Hold means the lead is parked with that person and does not count toward anyone&apos;s
        volume until they release it.
      </div>

      {error ? <Banner tone="crit">{error}</Banner> : null}
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save rule"}
        </button>
      </div>
    </form>
  );
}
