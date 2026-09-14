"use client";

import { IconFilter, IconFlag, IconLayoutColumns, IconPlus, IconSearch } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createPortal } from "react-dom";
import { activitiesKeys } from "~/features/crm/activities/queries";
import { CENTRE_LIST } from "~/features/crm/core/centres";
import type { ScreenProps } from "~/features/crm/core/screens";
import type { CentreCode } from "~/features/crm/core/types";
import { LEAD_TEST_IDS, type LeadView } from "~/features/crm/leads/contracts";
import { leadsKeys } from "~/features/crm/leads/queries";
import { BOARD_DRAG_HINT, PIPELINE_TEST_IDS } from "~/features/crm/statuses/contracts";
import { PIPELINE_POLL_MS, pipelineKeys } from "~/features/crm/statuses/queries";
import { transitionToastFor } from "~/features/crm/statuses/service/bmi-state";
import { errorMessage } from "../lib/crm-fetch";
import { useDebouncedValue } from "../lib/use-debounced";
import { useUrlQuery } from "../lib/use-url-query";
import {
  useCrmFetch,
  useCrmSheet,
  useCrmToast,
  useCrmUser,
  useTopbarSlot,
} from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { Seg } from "../primitives/Seg";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { DealDrawer } from "../deal/DealDrawer";
import { StatusSheet } from "../deal/StatusSheet";
import { postLeadStatus } from "../deal/queries";
import { useStatusIndex } from "../deal/use-deal";
import { NewLeadSheet } from "../leads/NewLeadSheet";
import { Board } from "./Board";
import { SHOW_ALL_COLUMNS, boardSubtitle } from "./model";
import { fetchPipeline } from "./queries";

/**
 * `/admin/crm/pipeline` (direction-b.html `leads`) — our statuses as columns,
 * a card per open lead, and two ways to move one: drag it, or press its
 * "Change status" button (R13 — never drag-only).
 *
 * The board's promise is stated on it, verbatim from the prototype: "Drag a
 * card to change status → writes the mapped BMI state". `transition()` keeps
 * it as far as it can be kept — Neon first, then the mapped Office state — and
 * the toast afterwards says which of the branches actually ran, so a status
 * that has no BMI state for that centre never LOOKS like it wrote one.
 *
 * A director gets the `?by=rep` swimlane toggle; a rep's board is their own,
 * where a swimlane would be one lane.
 *
 * `?cols=all` widens the empty columns back out. It lives in the URL like every
 * other filter here, so a link is a saved view (brief §3.1) — and it is a
 * toggle, not a setting, because the default (collapse) is the one a planner
 * wants nine days in ten.
 */
export default function PipelineScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const slot = useTopbarSlot();
  const { isDirector } = useCrmUser();
  const { openSheet, closeSheet } = useCrmSheet();
  const statuses = useStatusIndex();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);
  const [search, setSearch] = useState(urlQuery.q ?? "");
  const [pendingLeadId, setPendingLeadId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300, search);

  const repSlug = (urlQuery.rep as string | undefined) || null;
  // Swimlanes and a one-person filter answer the same question, so picking a
  // person collapses the lanes rather than drawing one lane with everything in
  // it. The route makes the same call.
  const byRep = isDirector && urlQuery.by === "rep" && !repSlug;
  const showAllColumns = urlQuery.cols === SHOW_ALL_COLUMNS;
  const centre = (urlQuery.centre as CentreCode | undefined) ?? undefined;
  const params: Record<string, string> = {};
  if (byRep) params.by = "rep";
  if (repSlug) params.rep = repSlug;
  if (centre) params.centre = centre;
  if (debouncedSearch.trim()) params.q = debouncedSearch.trim();

  const q = useQuery({
    queryKey: pipelineKeys.board(params),
    queryFn: () => fetchPipeline(crmFetch, params),
    refetchInterval: PIPELINE_POLL_MS,
    refetchIntervalInBackground: false,
  });

  // The FULL roster the response carries (`publicRoster()`), never narrowed by
  // the rep filter — options must not come from the thing they filter.
  const reps = q.data?.reps ?? [];
  const emptyColumns = (q.data?.columns ?? []).filter((c) => c.count === 0).length;

  const move = useMutation({
    mutationFn: (v: { lead: LeadView; statusId: string }) =>
      postLeadStatus(crmFetch, v.lead.publicId, {
        statusId: v.statusId,
        lostReason: null,
        note: null,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: pipelineKeys.all });
      void qc.invalidateQueries({ queryKey: leadsKeys.all });
      void qc.invalidateQueries({ queryKey: activitiesKeys.timeline(r.lead.publicId) });
      const t = transitionToastFor(r.status.label, r.bmi);
      toast(t.text, t.kind);
    },
    onError: (err) => toast(errorMessage(err), "crit"),
    onSettled: () => setPendingLeadId(null),
  });

  const dealId = urlQuery.deal ?? null;
  const openDeal = (publicId: string) => setUrlQuery({ deal: publicId });

  const openStatusSheet = (lead: LeadView) =>
    openSheet({
      title: "Change status",
      icon: <IconFlag {...ICON} />,
      testId: PIPELINE_TEST_IDS.statusSheet,
      body: <StatusSheet lead={lead} onCancel={closeSheet} onDone={closeSheet} />,
    });

  const openNew = () =>
    openSheet({
      title: "New lead",
      icon: <IconPlus {...ICON} />,
      wide: true,
      testId: LEAD_TEST_IDS.newLeadSheet,
      body: (
        <NewLeadSheet
          onCancel={closeSheet}
          onCreated={(r) => {
            closeSheet();
            toast(`Lead ${r.lead.publicId} saved`);
            openDeal(r.lead.publicId);
          }}
        />
      ),
    });

  const now = new Date();

  return (
    <>
      {slot
        ? createPortal(
            <>
              {isDirector ? (
                <Seg
                  label="Board grouping"
                  value={byRep ? "rep" : "status"}
                  options={[
                    { value: "status", label: "Columns" },
                    { value: "rep", label: "By rep" },
                  ]}
                  onChange={(v) => setUrlQuery({ by: v === "rep" ? "rep" : null })}
                  testId={PIPELINE_TEST_IDS.byRepToggle}
                />
              ) : null}
              <button type="button" className="btn btn-sm" onClick={openNew}>
                <IconPlus {...ICON} /> <span className="lbl">New lead</span>
              </button>
            </>,
            slot,
          )
        : null}

      <div className="board-wrap">
        <div className="board-tools">
          <div className="search" style={{ flex: 1, maxWidth: 320 }}>
            <IconSearch {...ICON} />
            <label className="sr-only" htmlFor="crm-pipeline-search">
              Search the pipeline
            </label>
            <input
              id="crm-pipeline-search"
              placeholder="Search…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setUrlQuery({ q: e.target.value || null });
              }}
            />
          </div>
          <label className="sr-only" htmlFor="crm-pipeline-centre">
            Filter by centre
          </label>
          {/*
            `.select` is `width: 100%` — right inside a form `.field`, wrong in
            a `flex-wrap` tool row, where a 100% basis takes the whole line to
            itself and pushes the hint onto a third one. Overridden HERE rather
            than in `crm.css`: this is the only `.select` in the CRM that is not
            in a field, and the stylesheet belongs to the shell PR this wave.
          */}
          <select
            id="crm-pipeline-centre"
            className="select"
            style={{ flex: "0 0 auto", width: "auto", minWidth: 168 }}
            value={centre ?? ""}
            onChange={(e) => setUrlQuery({ centre: e.target.value || null })}
          >
            <option value="">Centre: All</option>
            {CENTRE_LIST.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          {/* PERSON FILTER (owner: "need person filter too"). Options come from
              `data.reps`, which is the full roster from `publicRoster()` and is
              NOT narrowed by this filter — the same mistake made the KPI picker
              delete itself once a person was chosen. Directors only: a rep's
              board is already their own. */}
          {isDirector && reps.length > 1 ? (
            <>
              <label className="sr-only" htmlFor="crm-pipeline-rep">
                Filter by salesperson
              </label>
              <select
                id="crm-pipeline-rep"
                className="select"
                style={{ flex: "0 0 auto", width: "auto", minWidth: 168 }}
                value={repSlug ?? ""}
                onChange={(e) => setUrlQuery({ rep: e.target.value || null })}
              >
                <option value="">Everyone</option>
                {reps.map((r) => (
                  <option key={r.slug} value={r.slug}>
                    {r.displayName}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {/*
            The empty-column toggle, shown only when there is something to
            collapse — a control that provably does nothing is worse than no
            control. `aria-pressed` rather than two labels, so a screen reader
            hears one button with a state.
          */}
          {emptyColumns > 0 ? (
            <button
              type="button"
              className={showAllColumns ? "btn btn-sm btn-primary" : "btn btn-sm"}
              aria-pressed={showAllColumns}
              title={
                showAllColumns
                  ? `Collapse the ${emptyColumns} empty columns back to a rail`
                  : `${emptyColumns} empty columns are collapsed to a rail — you can still drop on them`
              }
              onClick={() => setUrlQuery({ cols: showAllColumns ? null : SHOW_ALL_COLUMNS })}
            >
              <IconLayoutColumns {...ICON} />{" "}
              <span className="lbl">Show empty ({emptyColumns})</span>
            </button>
          ) : null}
          <span className="xs muted" style={{ marginLeft: "auto" }}>
            <IconFilter {...ICON} /> {BOARD_DRAG_HINT}
          </span>
        </div>

        {q.isPending ? <LoadingState label="Loading the pipeline…" /> : null}
        {q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : null}

        {q.data ? (
          <>
            <div className="hstack xs muted" style={{ padding: "0 2px 8px" }}>
              <span>{boardSubtitle(q.data.openCount, q.data.openValueCents)}</span>
              {q.data.truncated ? (
                <span className="chip" data-kind="warn">
                  Showing the newest {q.data.leads.length} — narrow by centre or search
                </span>
              ) : null}
            </div>
            <div className="board-scroll" style={{ padding: 0 }}>
              <Board
                columns={q.data.columns}
                leads={q.data.leads}
                statuses={statuses}
                byRep={q.data.byRep}
                showAll={showAllColumns}
                now={now}
                pendingLeadId={pendingLeadId}
                onOpen={openDeal}
                onChangeStatus={openStatusSheet}
                onMove={(lead, statusId) => {
                  setPendingLeadId(lead.id);
                  move.mutate({ lead, statusId });
                }}
              />
            </div>
            {q.data.leads.length === 0 ? (
              <EmptyState>
                Nothing in the pipeline yet — new leads wait in the queue until they are assigned.
              </EmptyState>
            ) : null}
          </>
        ) : null}
      </div>

      {dealId ? (
        <DealDrawer
          publicId={dealId}
          onClose={() => setUrlQuery({ deal: null, tab: null })}
          query={urlQuery}
          setQuery={setUrlQuery}
        />
      ) : null}
    </>
  );
}
