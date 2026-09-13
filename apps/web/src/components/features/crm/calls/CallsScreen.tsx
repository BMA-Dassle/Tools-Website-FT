"use client";

import {
  IconAlertTriangle,
  IconPhone,
  IconPhoneIncoming,
  IconPhoneOff,
  IconPhoneOutgoing,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { createPortal } from "react-dom";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fStamp } from "~/features/crm/core/dates";
import type { ScreenProps } from "~/features/crm/core/screens";
import { CALL_TEST_IDS, type CallRow } from "~/features/crm/calls/contracts";
import { CALLS_POLL_MS, callsKeys } from "~/features/crm/calls/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmToast, useTopbarSlot } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { Seg } from "../primitives/Seg";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { Tile } from "../primitives/Tile";
import { Timer } from "../primitives/Timer";
import { DialSheet } from "./DialSheet";
import { DispositionSheet } from "./DispositionSheet";
import { fetchCalls } from "./queries";
import { UnknownCallersTray } from "./UnknownCallersTray";
import {
  callGlyph,
  callInstant,
  callNumber,
  callPill,
  callTitle,
  connectivityNotices,
  needsDisposition,
  prettyNumber,
  statusLabel,
  talkTime,
} from "./model";

/**
 * `/admin/crm/calls` (`crm-shared.js:422-425`) — "Your 3CX extension, matched to
 * leads automatically": the unknown-callers banner, the call list, and the
 * three tiles (Calls today · Reached · Avg talk time). Dial sits in the topbar.
 *
 * Everything the prototype faked is real here, and the two things it could not
 * know are said out loud: whether the PBX can reach us (the journal secret) and
 * whether this rep has an extension. The filter lives in the URL, so a link is
 * a saved view (§3.1).
 */

const FILTERS = [
  { value: "all", label: "All" },
  { value: "in", label: "Inbound" },
  { value: "out", label: "Outbound" },
  { value: "todo", label: "Needs disposition" },
  { value: "missed", label: "Missed" },
] as const;

type FilterId = (typeof FILTERS)[number]["value"];

function isFilter(v: unknown): v is FilterId {
  return typeof v === "string" && FILTERS.some((f) => f.value === v);
}

/** URL filter → the query string the route takes. Module scope (R12/TDZ). */
export function paramsFor(
  filter: FilterId,
  rep: string | null,
  cursor: string | null,
): Record<string, string> {
  const p: Record<string, string> = {};
  if (filter === "in" || filter === "out") p.direction = filter;
  if (filter === "todo") p.needsDisposition = "1";
  if (filter === "missed") p.missed = "1";
  if (rep) p.rep = rep;
  if (cursor) p.cursor = cursor;
  return p;
}

const GLYPH = {
  in: <IconPhoneIncoming {...ICON} />,
  out: <IconPhoneOutgoing {...ICON} />,
  missed: <IconPhoneOff {...ICON} />,
} as const;

export default function CallsScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const slot = useTopbarSlot();
  const { openSheet, closeSheet } = useCrmSheet();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const filter: FilterId = isFilter(urlQuery.f) ? urlQuery.f : "all";
  const rep = urlQuery.rep ?? null;
  const cursor = urlQuery.cursor ?? null;
  const params = paramsFor(filter, rep, cursor);

  const q = useQuery({
    queryKey: callsKeys.list(params),
    queryFn: () => fetchCalls(crmFetch, params),
    refetchInterval: CALLS_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const data = q.data;
  const notices = data ? connectivityNotices(data.connectivity) : [];

  const openDial = (call?: CallRow) =>
    openSheet({
      title: call ? `Calling ${callTitle(call)}` : "Dial",
      icon: <IconPhone {...ICON} />,
      wide: true,
      testId: CALL_TEST_IDS.dialSheet,
      body: data ? (
        <DialSheet
          connectivity={data.connectivity}
          initialNumber={call ? callNumber(call) : null}
          initialLeadId={call?.leadPublicId ?? null}
          onDialed={() => void qc.invalidateQueries({ queryKey: callsKeys.all })}
        />
      ) : null,
    });

  const openDispo = (call: CallRow) =>
    openSheet({
      title: `Log this call · ${callTitle(call)}`,
      icon: <IconPhone {...ICON} />,
      wide: true,
      testId: CALL_TEST_IDS.dispositionSheet,
      body: <DispositionSheet call={call} onDone={closeSheet} />,
    });

  return (
    <>
      {slot
        ? createPortal(
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => openDial()}
              disabled={!data}
            >
              <IconPhone {...ICON} /> <span className="lbl">Dial</span>
            </button>,
            slot,
          )
        : null}

      <div data-testid={CALL_TEST_IDS.screen}>
        {notices.map((n) => (
          <Banner
            key={n.text}
            tone={n.tone}
            icon={<IconAlertTriangle {...ICON} />}
            testId={n.tone === "warn" ? CALL_TEST_IDS.notConnected : undefined}
          >
            {n.text}
          </Banner>
        ))}

        {data ? <UnknownCallersTray tray={data.tray} /> : null}

        <Seg
          label="Filter calls"
          options={FILTERS.map((f) => ({
            value: f.value,
            label: f.label,
            badge:
              f.value === "todo" && data?.stats.needsDisposition
                ? data.stats.needsDisposition
                : undefined,
          }))}
          value={filter}
          onChange={(v) => setUrlQuery({ f: v === "all" ? null : v, cursor: null })}
        />

        {q.isPending ? <LoadingState label="Loading your calls…" /> : null}
        {q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : null}

        {data ? (
          <div className="card list" data-testid={CALL_TEST_IDS.list}>
            {data.calls.map((c) => (
              <CallRowView
                key={c.id}
                call={c}
                onLog={() => openDispo(c)}
                onCall={() => openDial(c)}
              />
            ))}
            {data.calls.length === 0 ? (
              <EmptyState icon={<IconPhone {...ICON} />}>
                {filter === "all"
                  ? "No calls yet. They appear as the reconcile job reads the PBX."
                  : "No calls match this filter."}
              </EmptyState>
            ) : null}
          </div>
        ) : null}

        {data && (data.nextCursor || cursor) ? (
          <div className="hstack" style={{ justifyContent: "center", padding: 8, gap: 8 }}>
            {cursor ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setUrlQuery({ cursor: null })}
              >
                Back to the newest
              </button>
            ) : null}
            {data.nextCursor ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  // Keyset, never OFFSET (R10): the next page is the cursor the
                  // server handed back, kept in the URL so the view is a link.
                  setUrlQuery({ cursor: data.nextCursor });
                  toast("Loading older calls…");
                }}
              >
                Older calls
              </button>
            ) : null}
          </div>
        ) : null}

        {data ? (
          <div className="grid grid-3" data-testid={CALL_TEST_IDS.stats}>
            <Tile label="Calls today" value={data.stats.today} />
            <Tile label="Reached" value={data.stats.reached} />
            <Tile label="Avg talk time" value={talkTime(data.stats.avgTalkSeconds)} />
          </div>
        ) : null}

        <p className="muted xs">
          Duration, direction and the recording link are captured automatically from 3CX.{" "}
          <Link href={`${CRM_BASE}/accountability`}>Accountability</Link> counts every call you log.
        </p>
      </div>
    </>
  );
}

/** One `.row` of the list (`crm-shared.js:424`), made clickable and keyboard-reachable. */
function CallRowView({
  call,
  onLog,
  onCall,
}: {
  call: CallRow;
  onLog: () => void;
  onCall: () => void;
}) {
  const pill = callPill(call);
  const todo = needsDisposition(call);
  return (
    <div className="row" data-testid={CALL_TEST_IDS.callRow(call.id)}>
      <Avatar icon={GLYPH[callGlyph(call)]} />
      <div>
        <div className="title">
          {call.leadPublicId ? (
            <Link href={`${CRM_BASE}/deal/${encodeURIComponent(call.leadPublicId)}`}>
              {callTitle(call)}
            </Link>
          ) : (
            callTitle(call)
          )}{" "}
          {call.contactLabel && call.leadPublicId ? (
            <span className="muted small">· {call.contactLabel}</span>
          ) : null}
          {pill ? <Pill>{pill}</Pill> : null}
        </div>
        <div className="meta">
          <span>{call.direction === "in" ? "Inbound" : "Outbound"}</span>
          <span>{talkTime(call.durationSeconds)}</span>
          <span>{statusLabel(call)}</span>
          {call.disposition ? <span>· {call.disposition}</span> : null}
          {todo ? (
            <Timer tone="warn" icon={<IconAlertTriangle {...ICON} />}>
              needs disposition
            </Timer>
          ) : null}
          {call.extension ? <span className="muted">ext {call.extension}</span> : null}
          <span className="muted">{prettyNumber(callNumber(call))}</span>
        </div>
      </div>
      <div className="right">
        <span className="small muted">{fStamp(callInstant(call))}</span>
        {call.repInitials ? (
          <Avatar initials={call.repInitials} repSlug={call.repSlug} name={call.repName ?? ""} sm />
        ) : null}
        <button type="button" className="btn btn-sm" onClick={onLog}>
          {call.disposition ? "Re-log" : "Log this call"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-icon"
          aria-label={`Call ${callTitle(call)} back`}
          title={`Call ${callTitle(call)} back`}
          onClick={onCall}
        >
          <IconPhone {...ICON} />
        </button>
      </div>
    </div>
  );
}
