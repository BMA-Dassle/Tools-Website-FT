"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { CENTRE_LIST } from "~/features/crm/core/centres";
import {
  EVENT_TYPES,
  type CentreCode,
  type EventType,
  type LeadSource,
} from "~/features/crm/core/types";
import {
  EVENT_TYPE_LABEL,
  LEAD_SOURCE_LABEL,
  LEAD_TEST_IDS,
  STAFF_LEAD_SOURCES,
  type LeadCreateResponse,
} from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Seg } from "../primitives/Seg";
import { postCreateLead } from "./queries";

/**
 * Staff capture — a phone call, a walk-in or a referral logged by hand
 * (`POST /leads`). Neon first: a lead without an email or a time is saved
 * with "needs email & time" and NO Pandora call; the deal's "Complete to
 * create in BMI" finishes it once the guest supplies them.
 */
export interface NewLeadSheetProps {
  defaultCentre?: CentreCode;
  /**
   * Seed values for a lead that is being started FROM something — today only
   * "This time last year" on History, which knows the guest, the centre, the
   * headcount and who sold it. A rep should confirm and adjust (last year's
   * date is not this year's), not re-type what we already have.
   */
  prefill?: Partial<Draft>;
  onCancel: () => void;
  onCreated: (r: LeadCreateResponse) => void;
}

interface Draft {
  source: LeadSource;
  centre: CentreCode;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  company: string;
  eventDate: string;
  eventTime: string;
  guests: string;
  type: EventType;
  kids: boolean;
  notes: string;
}

const SOURCE_OPTIONS = STAFF_LEAD_SOURCES.map((s) => ({ value: s, label: LEAD_SOURCE_LABEL[s] }));

export function NewLeadSheet({
  defaultCentre = "HPFM",
  prefill,
  onCancel,
  onCreated,
}: NewLeadSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [d, setD] = useState<Draft>({
    source: "phone",
    centre: defaultCentre,
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    company: "",
    eventDate: "",
    eventTime: "",
    guests: "",
    type: "corporate",
    kids: false,
    notes: "",
    ...prefill,
  });

  const create = useMutation({
    mutationFn: () =>
      postCreateLead(crmFetch, {
        centre: d.centre,
        source: d.source as "phone" | "walkin" | "referral",
        firstName: d.firstName.trim(),
        lastName: d.lastName.trim(),
        phone: d.phone.trim(),
        email: d.email.trim() || null,
        company: d.company.trim() || null,
        eventDate: d.eventDate,
        eventTime: d.eventTime || null,
        guests: Number(d.guests),
        type: d.type,
        kids: d.type === "birthday" ? d.kids : false,
        notes: d.notes.trim() || null,
        prefers: null,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      onCreated(r);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const ready =
    d.firstName.trim() &&
    d.lastName.trim() &&
    d.phone.trim().length >= 7 &&
    d.eventDate &&
    Number(d.guests) >= 1;
  const willMint = !!d.email.trim() && !!d.eventTime;

  return (
    <form
      className="stack"
      data-testid={LEAD_TEST_IDS.newLeadSheet}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !create.isPending) create.mutate();
      }}
    >
      <Seg
        options={SOURCE_OPTIONS}
        value={d.source}
        onChange={(v) => set("source", v)}
        label="Source"
      />
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${id}-centre`}>Center</label>
          <select
            id={`${id}-centre`}
            className="select"
            value={d.centre}
            onChange={(e) => set("centre", e.target.value as CentreCode)}
          >
            {CENTRE_LIST.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-type`}>Event type</label>
          <select
            id={`${id}-type`}
            className="select"
            value={d.type}
            onChange={(e) => set("type", e.target.value as EventType)}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-first`}>First name</label>
          <input
            id={`${id}-first`}
            className="input"
            value={d.firstName}
            onChange={(e) => set("firstName", e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-last`}>Last name</label>
          <input
            id={`${id}-last`}
            className="input"
            value={d.lastName}
            onChange={(e) => set("lastName", e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-phone`}>Phone</label>
          <input
            id={`${id}-phone`}
            className="input"
            inputMode="tel"
            value={d.phone}
            onChange={(e) => set("phone", e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-email`}>Email (needed to create in BMI)</label>
          <input
            id={`${id}-email`}
            className="input"
            inputMode="email"
            value={d.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-company`}>Business (optional)</label>
          <input
            id={`${id}-company`}
            className="input"
            value={d.company}
            onChange={(e) => set("company", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-guests`}>Guests</label>
          <input
            id={`${id}-guests`}
            className="input"
            inputMode="numeric"
            value={d.guests}
            onChange={(e) => set("guests", e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-date`}>Event date</label>
          <input
            id={`${id}-date`}
            className="input"
            type="date"
            value={d.eventDate}
            onChange={(e) => set("eventDate", e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-time`}>Event time (needed to create in BMI)</label>
          <input
            id={`${id}-time`}
            className="input"
            type="time"
            value={d.eventTime}
            onChange={(e) => set("eventTime", e.target.value)}
          />
        </div>
      </div>
      {d.type === "birthday" ? (
        <label className="hstack small">
          <input type="checkbox" checked={d.kids} onChange={(e) => set("kids", e.target.checked)} />
          Kids&apos; party (routes to Guest Services; Pandora files it as Child Birthday)
        </label>
      ) : null}
      <div className="field">
        <label htmlFor={`${id}-notes`}>Notes</label>
        <textarea
          id={`${id}-notes`}
          className="textarea"
          rows={3}
          value={d.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </div>
      <p className="xs muted" style={{ margin: 0 }}>
        {willMint
          ? "Saved here first, then created in BMI Office through Pandora."
          : "Saved here first. Add an email and a time to create the project in BMI Office."}
      </p>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!ready || create.isPending}>
          {create.isPending ? "Saving…" : "Save lead"}
        </button>
      </div>
    </form>
  );
}
