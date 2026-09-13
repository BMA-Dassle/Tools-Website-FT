"use client";

import { useState } from "react";
import { IconPhoneIncoming, IconPlus, IconSearch } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fStamp } from "~/features/crm/core/dates";
import type { CallRow } from "~/features/crm/calls/contracts";
import { CALL_TEST_IDS } from "~/features/crm/calls/contracts";
import { callsKeys } from "~/features/crm/calls/queries";
import { leadsKeys } from "~/features/crm/leads/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmSheet, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { fetchLeads } from "../leads/queries";
import { leadName, leadTitle } from "../leads/model";
import { NewLeadSheet } from "../leads/NewLeadSheet";
import { postLinkCall } from "./queries";
import { callInstant, callTitle, prettyNumber, statusLabel } from "./model";

/**
 * "**1 missed call** from (239) 555-0199 at … — not in your leads.
 *  [Create lead] [Link to a lead]" (`crm-shared.js:423`), generalised to every
 * call the matcher could not place, not just missed ones: an ANSWERED call from
 * a stranger needs claiming just as much, and leaving it out is how a real
 * enquiry disappears.
 *
 * Both buttons are real. "Create lead" opens B3's `NewLeadSheet` with the
 * number pre-filled and links the call to whatever it creates; "Link to a lead"
 * searches the open leads and attaches it.
 */
export function UnknownCallersTray({ tray }: { tray: CallRow[] }) {
  const { openSheet, closeSheet } = useCrmSheet();
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();

  const link = useMutation({
    mutationFn: (v: { callId: string; leadId: string }) =>
      postLinkCall(crmFetch, v.callId, { leadId: v.leadId }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: callsKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      closeSheet();
      toast(`Call linked to ${res.call.leadPublicId ?? "the lead"}`);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  if (tray.length === 0) return null;

  const first = tray[0];
  const number = first.fromE164 ?? first.toE164 ?? null;

  const openLink = (call: CallRow) =>
    openSheet({
      title: `Link ${callTitle(call)} to a lead`,
      icon: <IconSearch {...ICON} />,
      wide: true,
      body: (
        <LinkPicker
          call={call}
          pending={link.isPending}
          onPick={(leadId) => link.mutate({ callId: call.id, leadId })}
        />
      ),
    });

  const openCreate = (call: CallRow) =>
    openSheet({
      title: `New lead from ${prettyNumber(call.fromE164 ?? call.toE164)}`,
      icon: <IconPlus {...ICON} />,
      wide: true,
      body: (
        <NewLeadSheet
          onCancel={closeSheet}
          onCreated={(r) => link.mutate({ callId: call.id, leadId: r.lead.publicId })}
        />
      ),
    });

  return (
    <div data-testid={CALL_TEST_IDS.tray}>
      <Banner
        tone="warn"
        icon={<IconPhoneIncoming {...ICON} />}
        actions={
          <>
            <button type="button" className="btn btn-sm" onClick={() => openCreate(first)}>
              Create lead
            </button>
            <button type="button" className="btn btn-sm" onClick={() => openLink(first)}>
              Link to a lead
            </button>
          </>
        }
      >
        <b>
          {tray.length} {tray.length === 1 ? "call" : "calls"}
        </b>{" "}
        from {prettyNumber(number)}
        {tray.length > 1 ? " and others" : ""} at {fStamp(callInstant(first))} — not in your leads.
      </Banner>

      {tray.length > 1 ? (
        <div className="card list">
          {tray.slice(1).map((c) => (
            <div className="row" key={c.id}>
              <div>
                <div className="title">{callTitle(c)}</div>
                <div className="meta">
                  <span>{c.direction === "in" ? "Inbound" : "Outbound"}</span>
                  <span>{statusLabel(c)}</span>
                  <span>{fStamp(callInstant(c))}</span>
                </div>
              </div>
              <div className="right">
                <button type="button" className="btn btn-sm" onClick={() => openCreate(c)}>
                  Create lead
                </button>
                <button type="button" className="btn btn-sm" onClick={() => openLink(c)}>
                  Link
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Search the open leads and pick one. Keyboard-reachable; never drag-only (R13). */
function LinkPicker({
  call,
  pending,
  onPick,
}: {
  call: CallRow;
  pending: boolean;
  onPick: (leadPublicId: string) => void;
}) {
  const crmFetch = useCrmFetch();
  const [q, setQ] = useState("");
  const leads = useQuery({
    queryKey: leadsKeys.list({ q, link: call.id }),
    queryFn: () => fetchLeads(crmFetch, { limit: "10", ...(q ? { q } : {}) }),
    staleTime: 15_000,
  });

  return (
    <div>
      <div className="search">
        <IconSearch {...ICON} />
        <input
          aria-label="Search leads"
          placeholder="Host, business, phone or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="stack">
        {(leads.data?.leads ?? []).map((l) => (
          <button
            key={l.id}
            type="button"
            className="opt"
            disabled={pending}
            // The visible label is two nested divs, which jsx-a11y cannot see
            // through; spell it out so a screen reader hears the lead, not "button".
            aria-label={`Link this call to ${leadName(l)} · ${l.publicId}`}
            onClick={() => onPick(l.publicId)}
          >
            <div>
              <div className="strong">{leadName(l)}</div>
              <div className="why">
                {l.publicId} · {leadTitle(l)} · {prettyNumber(l.guest.phone)}
              </div>
            </div>
          </button>
        ))}
        {leads.isPending ? <div className="muted xs">Searching…</div> : null}
        {!leads.isPending && (leads.data?.leads ?? []).length === 0 ? (
          <div className="muted xs">No leads match — create one instead.</div>
        ) : null}
      </div>
    </div>
  );
}
