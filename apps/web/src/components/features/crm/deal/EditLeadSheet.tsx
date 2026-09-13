"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { EVENT_TYPES, type EventType } from "~/features/crm/core/types";
import { EVENT_TYPE_LABEL, type LeadView } from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { patchLead, postMint } from "../leads/queries";

/**
 * Edit the contact and the event facts (`PATCH /leads/[id]`). With `thenMint`
 * — the header's "Complete to create in BMI" — a successful save is followed
 * by `POST /leads/[id]/mint`, the same inline mint the retry button runs.
 */
export interface EditLeadSheetProps {
  lead: LeadView;
  thenMint: boolean;
  onCancel: () => void;
  onDone: () => void;
}

export function EditLeadSheet({ lead, thenMint, onCancel, onDone }: EditLeadSheetProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [first, setFirst] = useState(lead.guest.first);
  const [last, setLast] = useState(lead.guest.last);
  const [phone, setPhone] = useState(lead.guest.phone ?? "");
  const [email, setEmail] = useState(lead.guest.email ?? "");
  const [prefers, setPrefers] = useState(lead.guest.prefers ?? "");
  const [eventDate, setEventDate] = useState(lead.eventDate);
  const [eventTime, setEventTime] = useState(lead.eventTime ?? "");
  const [guests, setGuests] = useState(String(lead.guests));
  const [type, setType] = useState<EventType>(lead.type);
  const [kids, setKids] = useState(lead.kids);
  const [notes, setNotes] = useState(lead.notes ?? "");

  const save = useMutation({
    mutationFn: async () => {
      await patchLead(crmFetch, lead.publicId, {
        eventDate,
        eventTime: eventTime || null,
        guests: Number(guests) || lead.guests,
        type,
        kids: type === "birthday" ? kids : false,
        notes: notes.trim() || null,
        contact: {
          firstName: first.trim() || undefined,
          lastName: last.trim() || undefined,
          phone: phone.trim() || null,
          email: email.trim() || null,
          prefers: prefers ? (prefers as "text" | "call" | "email") : null,
        },
      });
      if (thenMint) return postMint(crmFetch, lead.publicId);
      return null;
    },
    onSuccess: (mint) => {
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      if (!mint) toast("Lead updated");
      else if (mint.mint.status === "minted")
        toast(`BMI project ${mint.mint.projectNumber} created`);
      else toast(`Saved · BMI project not created: ${mint.mint.error ?? "unknown"}`, "warn");
      onDone();
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const needs = thenMint && (!email.trim() || !eventTime);

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending && !needs) save.mutate();
      }}
    >
      {thenMint ? (
        <p className="small muted" style={{ margin: 0 }}>
          Pandora needs an email and an event time to create the project in BMI Office. Nothing is
          sent until you save.
        </p>
      ) : null}
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${id}-first`}>First name</label>
          <input
            id={`${id}-first`}
            className="input"
            value={first}
            onChange={(e) => setFirst(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-last`}>Last name</label>
          <input
            id={`${id}-last`}
            className="input"
            value={last}
            onChange={(e) => setLast(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-phone`}>Phone</label>
          <input
            id={`${id}-phone`}
            className="input"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-email`}>Email</label>
          <input
            id={`${id}-email`}
            className="input"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-prefers`}>Prefers</label>
          <select
            id={`${id}-prefers`}
            className="select"
            value={prefers}
            onChange={(e) => setPrefers(e.target.value)}
          >
            <option value="">—</option>
            <option value="text">Text</option>
            <option value="call">Call</option>
            <option value="email">Email</option>
          </select>
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
          <label htmlFor={`${id}-date`}>Event date</label>
          <input
            id={`${id}-date`}
            className="input"
            type="date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-time`}>Event time</label>
          <input
            id={`${id}-time`}
            className="input"
            type="time"
            value={eventTime}
            onChange={(e) => setEventTime(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-guests`}>Guests</label>
          <input
            id={`${id}-guests`}
            className="input"
            inputMode="numeric"
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
          />
        </div>
      </div>
      {type === "birthday" ? (
        <label className="hstack small">
          <input type="checkbox" checked={kids} onChange={(e) => setKids(e.target.checked)} />
          Kids&apos; party
        </label>
      ) : null}
      <div className="field">
        <label htmlFor={`${id}-notes`}>Notes</label>
        <textarea
          id={`${id}-notes`}
          className="textarea"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending || needs}>
          {save.isPending ? "Saving…" : thenMint ? "Save and create in BMI" : "Save"}
        </button>
      </div>
    </form>
  );
}
