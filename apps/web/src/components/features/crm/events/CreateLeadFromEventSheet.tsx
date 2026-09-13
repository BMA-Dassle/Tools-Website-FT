"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { EVENT_TEST_IDS, type EventRowView } from "~/features/crm/events/contracts";
import { eventsKeys } from "~/features/crm/events/queries";
import { EVENT_TYPE_LABEL } from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { EVENT_TYPES, type EventType } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { LoadingState } from "../primitives/States";
import { createLeadFromEventRow, fetchEventByProject } from "./queries";

/**
 * The sheet behind "Create lead from event": the host's details read off the
 * BMI project, editable, saved as a CRM lead that POINTS AT the existing
 * project rather than minting a new one.
 *
 * The phone is required (it is how the CRM matches a guest across texts, calls
 * and history) and BMI does not always carry one, so the field is here with
 * whatever the project knows already in it.
 */
export interface CreateLeadFromEventSheetProps {
  row: EventRowView;
  onCancel: () => void;
  onDone: (publicId: string) => void;
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export function CreateLeadFromEventSheet({ row, onCancel, onDone }: CreateLeadFromEventSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();

  const detailQ = useQuery({
    queryKey: eventsKeys.detail(row.projectId),
    queryFn: () => fetchEventByProject(crmFetch, row.projectId, row.centre),
  });

  const contact = detailQ.data?.event.contact ?? null;
  const seed = splitName(contact?.name || row.personName || "");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [type, setType] = useState<EventType>("corporate");
  const [touched, setTouched] = useState(false);

  // The form seeds itself from the project the first time the read lands —
  // without an effect, and without overwriting anything already typed.
  const firstName = touched ? first : first || seed.first;
  const lastName = touched ? last : last || seed.last;
  const phoneValue = touched ? phone : phone || contact?.phone || row.lead?.guestPhone || "";
  const emailValue = touched ? email : email || contact?.email || "";

  const save = useMutation({
    mutationFn: () =>
      createLeadFromEventRow(crmFetch, row.projectId, {
        centre: row.centre,
        firstName,
        lastName,
        phone: phoneValue,
        email: emailValue || null,
        eventDate: row.when.slice(0, 10),
        eventTime: row.when.slice(11, 16) || null,
        guests: row.persons || 1,
        type,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: eventsKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      toast(`Lead ${r.lead.publicId} created from ${row.number || "this event"}`);
      onDone(r.lead.publicId);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  if (detailQ.isPending) return <LoadingState label="Reading the BMI project…" />;

  const canSave = firstName.trim().length > 0 && phoneValue.trim().length >= 7;

  return (
    <div className="stack" data-testid={EVENT_TEST_IDS.createLeadSheet}>
      <div className="xs muted">
        The CRM row points at BMI project {row.number || row.projectId}. Nothing new is created in
        BMI, and the event keeps its responsible until somebody assigns the lead.
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${id}-first`}>First name</label>
          <input
            id={`${id}-first`}
            className="input"
            value={firstName}
            onChange={(e) => {
              setTouched(true);
              setFirst(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-last`}>Last name</label>
          <input
            id={`${id}-last`}
            className="input"
            value={lastName}
            onChange={(e) => {
              setTouched(true);
              setLast(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-phone`}>Phone</label>
          <input
            id={`${id}-phone`}
            className="input"
            inputMode="tel"
            value={phoneValue}
            onChange={(e) => {
              setTouched(true);
              setPhone(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-email`}>Email</label>
          <input
            id={`${id}-email`}
            className="input"
            type="email"
            value={emailValue}
            onChange={(e) => {
              setTouched(true);
              setEmail(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-type`}>Event type</label>
          <select
            id={`${id}-type`}
            className="select"
            value={type}
            onChange={(e) => setType(e.target.value as EventType)}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-guests`}>Guests</label>
          <input
            id={`${id}-guests`}
            className="input tabular"
            value={row.persons}
            readOnly
            aria-describedby={`${id}-guests-help`}
          />
          <span id={`${id}-guests-help`} className="xs muted">
            From BMI — change it on the event, not here.
          </span>
        </div>
      </div>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Creating…" : "Create lead"}
        </button>
      </div>
      {!canSave ? (
        <div className="xs muted">
          A first name and a phone number are needed to match the guest.
        </div>
      ) : null}
    </div>
  );
}
