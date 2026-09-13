"use client";

import { IconAlertTriangle, IconCheck, IconLayersSubtract } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AVAILABILITY_TEST_IDS } from "~/features/crm/availability/contracts";
import { availabilityKeys } from "~/features/crm/availability/queries";
import { fmtMin } from "~/features/crm/availability/service/engine";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { ErrorState, LoadingState } from "../primitives/States";
import { runLabel, windowLabel } from "./model";
import { fetchAvailability } from "./queries";

/**
 * The deal rail's availability card — the one-line version of the verdict, with
 * a link through to the full screen.
 *
 * Exported for the deal rail, which B3 owns: this PR deliberately creates
 * NOTHING under `components/features/crm/deal/`, so the wiring is one import in
 * `deal/actions.ts` at release time rather than a file two PRs both touch.
 *
 * It takes the lead's public id and nothing else it can get from the server —
 * the route resolves the lead's own centre, date and guest count, so the rail
 * cannot drift out of step with the deal header.
 */

export interface AvailabilityCardProps {
  leadPublicId: string;
  /** Overrides for a rail that already knows the request (optional). */
  start?: number;
  dur?: number;
}

export function AvailabilityCard({ leadPublicId, start, dur }: AvailabilityCardProps) {
  const crmFetch = useCrmFetch();
  const params = { lead: leadPublicId, start, dur };
  const q = useQuery({
    queryKey: availabilityKeys.grid(params),
    queryFn: () => fetchAvailability(crmFetch, params),
  });

  const href = `${CRM_BASE}/availability/${encodeURIComponent(leadPublicId)}`;

  return (
    <div className="card" data-testid={AVAILABILITY_TEST_IDS.card}>
      <div className="card-h">
        <h2>Lane availability</h2>
        <div className="right">
          <Link className="btn btn-ghost btn-sm" href={href}>
            Open
          </Link>
        </div>
      </div>
      {q.isPending ? <LoadingState label="Reading the lane grid…" /> : null}
      {q.isError ? (
        <div className="pad">
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        </div>
      ) : null}
      {q.data ? (
        <div className="pad stack small">
          {q.data.source === "heats" ? (
            <div className="muted">
              FastTrax is karting — {q.data.request.guests} racers. Open for the heat grid.
            </div>
          ) : q.data.source === "unavailable" ? (
            <div className="hstack">
              <IconAlertTriangle {...ICON} />
              <span className="muted">{q.data.error}</span>
            </div>
          ) : q.data.fits && q.data.placement ? (
            <div className="hstack">
              <IconCheck {...ICON} />
              <span>
                <b>Fits.</b> {q.data.placement.section} lanes{" "}
                <b>{runLabel(q.data.placement.lanes)}</b> free{" "}
                {windowLabel(q.data.request.start, q.data.request.dur)}
              </span>
            </div>
          ) : (
            <div className="hstack">
              <IconAlertTriangle {...ICON} />
              <span>
                <b>Does not fit at {fmtMin(q.data.request.start)}.</b>{" "}
                {q.data.alternates.length > 0
                  ? `Nearest that works: ${q.data.alternates.map((a) => fmtMin(a.start)).join(" · ")}.`
                  : "Try a shorter block or another day."}
              </span>
            </div>
          )}
          {q.data.source === "lanes" ? (
            <div className="xs muted">
              <IconLayersSubtract {...ICON} /> {q.data.need} lanes for {q.data.request.guests}{" "}
              guests (6 per lane)
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
