"use client";

import { IconRefresh } from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createPortal } from "react-dom";
import { AVAILABILITY_TEST_IDS } from "~/features/crm/availability/contracts";
import { availabilityKeys } from "~/features/crm/availability/queries";
import { boundsFor, lanesNeeded, ticksBetween } from "~/features/crm/availability/service/engine";
import {
  DEFAULT_CENTRE,
  DEFAULT_DURATION_MIN,
  DEFAULT_GUESTS,
  DEFAULT_START_MIN,
} from "~/features/crm/availability/service/request";
import { CENTRES } from "~/features/crm/core/centres";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDate, todayEasternYmd } from "~/features/crm/core/dates";
import type { ScreenProps } from "~/features/crm/core/screens";
import type { CentreCode } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmToast, useTopbarSlot } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { Seg } from "../primitives/Seg";
import { ErrorState, LoadingState } from "../primitives/States";
import { EveningTimeline } from "./EveningTimeline";
import { HeatsPanel } from "./HeatsPanel";
import { RequestBar } from "./RequestBar";
import { Verdict } from "./Verdict";
import { freshnessLabel, subtitleFor } from "./model";
import { fetchAvailability, fetchHeats } from "./queries";

/**
 * `/admin/crm/availability` and `/admin/crm/availability/<leadId>` (C4) —
 * the prototype's `availability` screen (`crm-shared.js:488-522`).
 *
 * The QUERY is the source of truth: centre, date, start, dur and guests all
 * live in the URL, so the link a planner sends to a colleague reproduces the
 * exact grid they were looking at. `/<leadId>` seeds the blanks from that
 * lead's own centre, date and guest count; a lead that is not there says so and
 * asks for the request by hand rather than inventing one.
 *
 * Everything on this screen is a READ. "Hold these lanes in BMI" is a link into
 * the builder (C5) and holds nothing today.
 */

const numberFrom = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const BMI_RESOURCES_TOAST = "BMI resources tab — coming later (needs product keys)";

export default function AvailabilityScreen({ view, query }: ScreenProps) {
  // ---- hooks above every early return (react-hooks/rules-of-hooks) ----
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const slot = useTopbarSlot();
  const qc = useQueryClient();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"lanes" | "bmi">("lanes");

  const leadId = view[0] ?? urlQuery.lead ?? undefined;
  const params = {
    centre: urlQuery.centre,
    date: urlQuery.date,
    start: numberFrom(urlQuery.start),
    dur: numberFrom(urlQuery.dur),
    guests: numberFrom(urlQuery.guests),
    lead: leadId,
  };

  const gridQ = useQuery({
    queryKey: availabilityKeys.grid(params),
    queryFn: () => fetchAvailability(crmFetch, params),
    placeholderData: keepPreviousData,
  });

  const isHeats = gridQ.data?.source === "heats";
  const heatsParams = {
    centre: gridQ.data?.request.centre,
    date: gridQ.data?.request.date,
    guests: gridQ.data?.request.guests,
    resourceId: urlQuery.resource,
    lead: leadId,
  };
  const heatsQ = useQuery({
    queryKey: availabilityKeys.heats(heatsParams),
    queryFn: () => fetchHeats(crmFetch, heatsParams),
    enabled: isHeats,
    placeholderData: keepPreviousData,
  });

  const refresh = useMutation({
    mutationFn: () => fetchAvailability(crmFetch, { ...params, refresh: true }),
    onSuccess: (data) => {
      qc.setQueryData(availabilityKeys.grid(params), data);
      if (data.source === "heats") void qc.invalidateQueries({ queryKey: availabilityKeys.all });
      toast("Lane grid refreshed");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  // ---- derived (no hooks below this line) ----
  const data = gridQ.data;
  const request = data?.request ?? {
    centre: (urlQuery.centre as CentreCode) ?? DEFAULT_CENTRE,
    date: urlQuery.date ?? todayEasternYmd(),
    start: numberFrom(urlQuery.start) ?? DEFAULT_START_MIN,
    dur: numberFrom(urlQuery.dur) ?? DEFAULT_DURATION_MIN,
    guests: numberFrom(urlQuery.guests) ?? DEFAULT_GUESTS,
  };
  const fallbackBounds = boundsFor({ start: request.start, dur: request.dur });
  const bounds = data?.bounds ?? { ...fallbackBounds, ticks: ticksBetween(fallbackBounds) };
  const need = data?.need || lanesNeeded(request.guests);
  const centreShort = CENTRES[request.centre].short;

  const onChange = (patch: {
    centre?: CentreCode;
    date?: string;
    start?: number;
    dur?: number;
    guests?: number;
  }) => {
    setUrlQuery({
      centre: patch.centre,
      date: patch.date,
      start: patch.start === undefined ? undefined : String(patch.start),
      dur: patch.dur === undefined ? undefined : String(patch.dur),
      guests: patch.guests === undefined ? undefined : String(patch.guests),
    });
  };

  return (
    <>
      {slot
        ? createPortal(
            <>
              <Seg
                label="Availability source"
                options={[
                  { value: "lanes", label: "Lanes (QAMF)" },
                  { value: "bmi", label: "BMI resources" },
                ]}
                value={tab}
                onChange={(v) => {
                  if (v === "bmi") {
                    toast(BMI_RESOURCES_TOAST);
                    return;
                  }
                  setTab(v);
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending || gridQ.isPending}
              >
                <IconRefresh size={16} aria-hidden className="icon" />{" "}
                <span className="lbl">Refresh</span>
              </button>
            </>,
            slot,
          )
        : null}

      <div className="card">
        <div className="card-h">
          <h2>Lane availability · {centreShort}</h2>
          <div className="right xs muted">
            {subtitleFor({
              dateLabel: fDate(request.date),
              title: data?.lead?.title ?? null,
              guests: request.guests,
              need,
            })}
          </div>
        </div>

        {data?.leadMissing ? (
          <div className="pad">
            <Banner tone="info">
              That lead is not in the CRM — enter the request manually below. (Deals land here once
              the leads board ships.)
            </Banner>
          </div>
        ) : null}

        <RequestBar
          centre={request.centre}
          date={request.date}
          start={request.start}
          dur={request.dur}
          guests={request.guests}
          need={need}
          bounds={bounds}
          busy={gridQ.isFetching || refresh.isPending}
          onChange={onChange}
        />

        {gridQ.isPending ? <LoadingState label="Reading the lane grid…" /> : null}

        {gridQ.isError ? (
          <div className="pad">
            <ErrorState message={errorMessage(gridQ.error)} onRetry={() => void gridQ.refetch()} />
          </div>
        ) : null}

        {data?.source === "unavailable" ? (
          <div className="pad">
            <Banner tone="crit">{data.error}</Banner>
          </div>
        ) : null}

        {data?.source === "lanes" ? (
          <div className="pad-x">
            <Verdict
              fits={data.fits}
              need={data.need}
              start={data.request.start}
              dur={data.request.dur}
              placement={data.placement}
              alternates={data.alternates}
              leadPublicId={data.lead?.publicId ?? null}
              crmBase={CRM_BASE}
              onPickStart={(start) => onChange({ start })}
            />
          </div>
        ) : null}
      </div>

      {data?.source === "lanes" ? (
        <div className="card">
          <div className="card-h">
            <h2>Evening timeline</h2>
            <div className="right legend">
              <span>
                <i className="lg-league" />
                League
              </span>
              <span>
                <i className="lg-party" />
                Party
              </span>
              <span>
                <i className="lg-walkin" />
                Walk-in / web
              </span>
              <span>
                <i className="lg-maint" />
                Maintenance
              </span>
              <span>
                <i className="lg-window" />
                Requested window
              </span>
            </div>
          </div>

          <EveningTimeline
            sections={data.sections}
            lanes={data.lanes}
            placement={data.placement}
            need={data.need}
            bounds={bounds}
            start={data.request.start}
            dur={data.request.dur}
            expanded={expanded}
            onToggleSection={(name) =>
              setExpanded((prev) => ({ ...prev, [name]: prev[name] !== true }))
            }
          />

          <div className="pad xs muted" style={{ paddingTop: 8 }}>
            Source: QAMF reservations search (v1.4) + live lane status,{" "}
            {freshnessLabel(data.readAt, new Date())}. Includes Conqueror front-desk bookings,
            leagues and maintenance that BMI cannot see. Holding lanes writes the lane block into
            the BMI quote; the QAMF reservation is made by the contract rail at deposit.
          </div>
        </div>
      ) : null}

      {isHeats && heatsQ.data ? (
        <HeatsPanel
          data={heatsQ.data}
          onSelectResource={(resourceId) => setUrlQuery({ resource: resourceId })}
        />
      ) : null}
      {isHeats && heatsQ.isPending ? <LoadingState label="Reading the heat grid…" /> : null}
      {isHeats && heatsQ.isError ? (
        <div className="pad" data-testid={AVAILABILITY_TEST_IDS.heats}>
          <ErrorState message={errorMessage(heatsQ.error)} onRetry={() => void heatsQ.refetch()} />
        </div>
      ) : null}
    </>
  );
}
