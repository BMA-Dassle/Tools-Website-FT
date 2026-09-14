"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconPlus } from "@tabler/icons-react";
import { COLD_TEST_IDS, type ColdRowView } from "~/features/crm/cold/contracts";
import { coldKeys } from "~/features/crm/cold/queries";
import { splitPersonName } from "~/features/crm/cold/mapping";
import { CENTRE_CODES } from "~/features/crm/core/centres";
import { todayEasternYmd } from "~/features/crm/core/dates";
import { EVENT_TYPES, type CentreCode, type EventType } from "~/features/crm/core/types";
import { leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { rowTitle } from "./model";
import { postColdRowAction } from "./queries";

/**
 * Converting a prospect into a lead.
 *
 * This is the moment the prototype's deal banner describes
 * (`crm-shared.js:530`): "This is a prospect (cold list or last-year
 * reach-out). Saving converts it into a lead: creates the Office project
 * (state New Lead), attaches … as the host, and assigns it by the rules."
 * NOTHING was minted at import; this is where the mint and the assignment
 * rules run, which is why the sheet asks for the event rather than guessing at
 * one.
 *
 * The fields are pre-filled from the cold row — including the name split into
 * two halves, which the rep can correct — because the rep is holding a phone.
 */
export function ConvertSheet({
  row,
  defaultCentre,
  onDone,
}: {
  row: ColdRowView;
  defaultCentre: CentreCode | null;
  onDone: (updated: ColdRowView, leadPublicId: string) => void;
}) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();

  const split = splitPersonName(row.contactName);
  const [firstName, setFirstName] = useState(split.firstName);
  const [lastName, setLastName] = useState(split.lastName);
  const [phone, setPhone] = useState(row.phoneE164 ?? row.phoneRaw ?? "");
  const [email, setEmail] = useState(row.email ?? "");
  const [company, setCompany] = useState(row.company ?? "");
  const [centre, setCentre] = useState<CentreCode>(defaultCentre ?? "HPFM");
  const [eventDate, setEventDate] = useState("");
  const [eventTime, setEventTime] = useState("");
  const [guests, setGuests] = useState("");
  const [type, setType] = useState<EventType>("corporate");
  const [notes, setNotes] = useState(row.notes ?? "");

  const convert = useMutation({
    mutationFn: () =>
      postColdRowAction(crmFetch, row.listId, row.id, {
        action: "convert",
        draft: {
          centre,
          eventDate,
          eventTime: eventTime || null,
          guests: Number(guests),
          type,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim() || null,
          email: email.trim() || null,
          company: company.trim() || null,
          notes: notes.trim() || null,
        },
        note: null,
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: coldKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      toast(
        res.mintStatus === "minted"
          ? `${res.leadPublicId} created · BMI project opened${res.assignedRepName ? ` · ${res.assignedRepName}` : ""}`
          : `${res.leadPublicId} created · BMI project not opened yet (${res.mintError ?? res.mintStatus})`,
        res.mintStatus === "minted" ? "ok" : "warn",
      );
      onDone(res.row, res.leadPublicId);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const missingMint = !email.trim() || !eventTime;
  const ready = firstName.trim() !== "" && eventDate !== "" && Number(guests) > 0;

  return (
    <div data-testid={COLD_TEST_IDS.convertSheet}>
      <Banner tone="info" icon={<IconPlus {...ICON} />}>
        Saving converts this prospect into a lead: it creates the Office project (state New Lead),
        attaches {rowTitle(row)} as the host, and assigns it by the rules.
      </Banner>

      <div className="eyebrow">Who they are</div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`cv-first-${row.id}`}>First name</label>
          <input
            id={`cv-first-${row.id}`}
            className="input"
            value={firstName}
            maxLength={80}
            onChange={(e) => setFirstName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`cv-last-${row.id}`}>Last name</label>
          <input
            id={`cv-last-${row.id}`}
            className="input"
            value={lastName}
            maxLength={80}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`cv-phone-${row.id}`}>Phone</label>
          <input
            id={`cv-phone-${row.id}`}
            className="input"
            inputMode="tel"
            value={phone}
            maxLength={30}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`cv-email-${row.id}`}>Email</label>
          <input
            id={`cv-email-${row.id}`}
            className="input"
            type="email"
            value={email}
            maxLength={200}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`cv-company-${row.id}`}>Company</label>
        <input
          id={`cv-company-${row.id}`}
          className="input"
          value={company}
          maxLength={160}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      <div className="eyebrow">What they want</div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`cv-centre-${row.id}`}>Center</label>
          <select
            id={`cv-centre-${row.id}`}
            className="select"
            value={centre}
            onChange={(e) => setCentre(e.target.value as CentreCode)}
          >
            {CENTRE_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`cv-type-${row.id}`}>Event type</label>
          <select
            id={`cv-type-${row.id}`}
            className="select"
            value={type}
            onChange={(e) => setType(e.target.value as EventType)}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`cv-date-${row.id}`}>Event date</label>
          <input
            id={`cv-date-${row.id}`}
            className="input"
            type="date"
            min={todayEasternYmd()}
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`cv-time-${row.id}`}>Start time</label>
          <input
            id={`cv-time-${row.id}`}
            className="input"
            type="time"
            value={eventTime}
            onChange={(e) => setEventTime(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`cv-guests-${row.id}`}>Guests</label>
          <input
            id={`cv-guests-${row.id}`}
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={5000}
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`cv-notes-${row.id}`}>Notes</label>
        <textarea
          id={`cv-notes-${row.id}`}
          className="textarea"
          value={notes}
          maxLength={4000}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {missingMint ? (
        <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
          Without an email address and a start time the lead is saved here but the BMI project
          cannot be opened yet. Add them if you have them; if not, the deal will show what is
          missing and you can open the project from there.
        </Banner>
      ) : null}

      <div className="foot" style={{ position: "static", padding: 0 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || convert.isPending}
          onClick={() => convert.mutate()}
        >
          {convert.isPending ? "Converting…" : "Convert to a lead"}
        </button>
      </div>
    </div>
  );
}
