"use client";

import { useMemo, useState } from "react";
import { IconPhone, IconPhoneOutgoing, IconSearch } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LeadView } from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { callsKeys } from "~/features/crm/calls/queries";
import type { CallsConnectivity, CallRow } from "~/features/crm/calls/contracts";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { fetchLeads } from "../leads/queries";
import { leadName, leadTitle } from "../leads/model";
import { postDial } from "./queries";
import { prettyNumber } from "./model";

/**
 * The Dial sheet (`crm-shared.js:426`): search your open leads, or type a
 * number, and press Call.
 *
 * WHAT HAPPENS WHEN YOU PRESS IT, and why this sheet is bigger than the
 * prototype's. `POST /calls/dial` writes the Neon intent row first, then asks
 * 3CX to ring your extension. Three outcomes, all normal:
 *   `ringing`  — the banner says so ("Ringing your 3CX extension (…) first…");
 *   `fallback` — the PBX refused; the sheet hands you a `tel:` link;
 *   `disabled` — the kill switch is off, or you have no extension on record.
 * The `tel:` link is ALWAYS there, so a rep is never stuck. The prototype's
 * last line said as much: "If 3CX is unavailable this button falls back to your
 * phone dialer."
 */
export function DialSheet({
  connectivity,
  initialNumber,
  initialLeadId,
  onDialed,
}: {
  connectivity: CallsConnectivity;
  initialNumber?: string | null;
  initialLeadId?: string | null;
  onDialed?: (call: CallRow | null) => void;
}) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [number, setNumber] = useState(initialNumber ?? "");
  const [leadId, setLeadId] = useState<string | null>(initialLeadId ?? null);
  const [result, setResult] = useState<{
    outcome: string;
    telHref: string;
    error: string | null;
  } | null>(null);

  const leads = useQuery({
    queryKey: leadsKeys.list({ mine: "1", q }),
    queryFn: () => fetchLeads(crmFetch, { mine: "1", limit: "8", ...(q ? { q } : {}) }),
    staleTime: 30_000,
  });

  const options = useMemo<LeadView[]>(
    () => (leads.data?.leads ?? []).filter((l) => l.guest.phone).slice(0, 6),
    [leads.data],
  );

  const dial = useMutation({
    mutationFn: (body: { number: string; leadId: string | null }) => postDial(crmFetch, body),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: callsKeys.all });
      setResult({ outcome: res.outcome, telHref: res.telHref, error: res.error });
      if (res.outcome === "ringing") toast(`Calling ${prettyNumber(res.call?.toE164 ?? null)}`);
      else toast(res.error ?? "3CX could not place the call — use your phone", "warn");
      onDialed?.(res.call);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const call = (n: string, lead: string | null) => {
    const trimmed = n.trim();
    if (!trimmed) return;
    setNumber(trimmed);
    setLeadId(lead);
    dial.mutate({ number: trimmed, leadId: lead });
  };

  return (
    <div data-testid="crm-dial-sheet-body">
      {connectivity.clickToCallEnabled && connectivity.myExtension ? (
        <Banner tone="info" icon={<IconPhoneOutgoing {...ICON} />}>
          Ringing your 3CX extension ({connectivity.myExtension}) first, then the number you pick.
        </Banner>
      ) : (
        <Banner tone="warn" icon={<IconPhone {...ICON} />}>
          {connectivity.clickToCallEnabled
            ? "No 3CX extension on your rep record — Dial will hand you a tel: link instead."
            : "Click-to-call is switched off — Dial will hand you a tel: link instead."}
        </Banner>
      )}

      <div className="search">
        <IconSearch {...ICON} />
        <input
          aria-label="Search your leads by name, business or number"
          placeholder="Name, business or number"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="stack">
        {options.map((l) => (
          <button
            key={l.id}
            type="button"
            className="opt"
            disabled={dial.isPending}
            onClick={() => call(l.guest.phone ?? "", l.publicId)}
          >
            <div>
              <div className="strong">{leadName(l)}</div>
              <div className="why">
                {prettyNumber(l.guest.phone)} · {leadTitle(l)}
              </div>
            </div>
            <IconPhone {...ICON} />
          </button>
        ))}
        {leads.isPending ? <div className="muted xs">Loading your leads…</div> : null}
        {!leads.isPending && options.length === 0 ? (
          <div className="muted xs">No open leads with a phone number — type one below.</div>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="dial-number">Or a number</label>
        <input
          id="dial-number"
          className="input tabular"
          inputMode="tel"
          placeholder="(239) 555-1234"
          value={number}
          maxLength={32}
          onChange={(e) => setNumber(e.target.value)}
        />
      </div>

      <div className="hstack between">
        <span className="muted xs">
          Duration, direction and the recording link are captured automatically from 3CX.
        </span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={dial.isPending || !number.trim()}
          onClick={() => call(number, leadId)}
        >
          <IconPhone {...ICON} /> {dial.isPending ? "Calling…" : "Call"}
        </button>
      </div>

      {result && result.outcome !== "ringing" ? (
        <Banner
          tone="warn"
          icon={<IconPhone {...ICON} />}
          actions={
            <a className="btn btn-sm" href={result.telHref}>
              Use my phone
            </a>
          }
        >
          {result.error ?? "3CX could not place the call"} — the call is logged either way.
        </Banner>
      ) : null}
    </div>
  );
}
