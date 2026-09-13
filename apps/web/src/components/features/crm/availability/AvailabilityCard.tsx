"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { fmtMin } from "~/features/crm/availability/pure";
import { AVAILABILITY_TEST_IDS } from "~/features/crm/availability/contracts";
import { availabilityKeys } from "~/features/crm/availability/queries";
import { CRM_BASE } from "~/features/crm/core/contracts";
import { fDate } from "~/features/crm/core/dates";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { MeterRow } from "../primitives/Meter";
import { Pill } from "../primitives/Pill";
import { ICON } from "../primitives/icon-props";
import { ErrorState, LoadingState } from "../primitives/States";
import { miniSectionRows } from "./model";
import { fetchAvailability, fetchHeats } from "./queries";

/**
 * The deal rail's availability card — the prototype's `miniAvailability`
 * (`crm-shared.js:315,318`), which is a per-section meter list, NOT a one-line
 * verdict:
 *
 *   Availability · Sat, Oct 17                              [Full grid]
 *   Lanes free for a 2-hour block from 6:00 PM
 *   Old Time Lanes  ▓▓▓▓░░  3 of 4 free
 *   VIP             ▓▓░░░░  2 of 8 free
 *   Regular         ▓▓▓▓▓░ 13 of 16 free
 *   Live from QAMF · includes front-desk, leagues and maintenance
 *
 * FastTrax gets the heat-pill row instead, because it has no lanes at all.
 *
 * Exported for the deal rail, which B3 owns: this PR deliberately creates
 * NOTHING under `components/features/crm/deal/`, so the wiring is one import in
 * `deal/actions.ts` at release time rather than a file two PRs both touch. The
 * row shaping lives in `model.ts` (`miniSectionRows`) with its own test, so the
 * card is proved before anything imports it.
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

/** The prototype's window around the requested start (`crm-shared.js:318`). */
const HEAT_PILL_BEFORE_MIN = 36;
const HEAT_PILL_AFTER_MIN = 60;

export function AvailabilityCard({ leadPublicId, start, dur }: AvailabilityCardProps) {
  const crmFetch = useCrmFetch();
  const params = { lead: leadPublicId, start, dur };
  const q = useQuery({
    queryKey: availabilityKeys.grid(params),
    queryFn: () => fetchAvailability(crmFetch, params),
  });

  const isHeats = q.data?.source === "heats";
  const heatsParams = { lead: leadPublicId };
  const heatsQ = useQuery({
    queryKey: availabilityKeys.heats(heatsParams),
    queryFn: () => fetchHeats(crmFetch, heatsParams),
    enabled: isHeats,
  });

  const data = q.data;
  const href = `${CRM_BASE}/availability/${encodeURIComponent(leadPublicId)}`;
  const rows = data?.source === "lanes" ? miniSectionRows(data.sections) : [];
  const selected =
    heatsQ.data?.resources.find((r) => r.resourceId === heatsQ.data?.selectedResourceId) ?? null;
  const pills = selected
    ? selected.blocks.filter(
        (b) =>
          b.start >= (data?.request.start ?? 0) - HEAT_PILL_BEFORE_MIN &&
          b.start <= (data?.request.start ?? 0) + HEAT_PILL_AFTER_MIN,
      )
    : [];

  return (
    <div className="card" data-testid={AVAILABILITY_TEST_IDS.card}>
      <div className="card-h">
        <h2>Availability{data ? ` · ${fDate(data.request.date)}` : ""}</h2>
        <div className="right">
          <Link className="btn btn-sm" href={href}>
            Full grid
          </Link>
        </div>
      </div>
      {q.isPending ? <LoadingState label="Reading the lane grid…" /> : null}
      {q.isError ? (
        <div className="pad">
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        </div>
      ) : null}
      {data ? (
        <div className="pad stack">
          {data.source === "unavailable" ? (
            <Banner tone="crit" icon={<IconAlertTriangle {...ICON} />}>
              {data.error}
            </Banner>
          ) : (
            <>
              <div className="legend">
                {data.source === "heats"
                  ? `Karting heats near ${fmtMin(data.request.start)}`
                  : `Lanes free for a ${data.request.dur / 60}-hour block from ${fmtMin(data.request.start)}`}
              </div>

              {data.source === "heats" ? (
                <div className="hstack">
                  {pills.map((b) => (
                    <Pill key={b.start} className={b.freePlaces === 0 ? "full" : undefined}>
                      {b.label} · {b.freePlaces}/{b.capacity}
                    </Pill>
                  ))}
                </div>
              ) : (
                rows.map((r) => (
                  <MeterRow
                    key={r.name}
                    name={r.name}
                    n={r.n}
                    pct={r.pct}
                    tone={r.tone}
                    label={`${r.name}: ${r.n}`}
                  />
                ))
              )}

              {/* The prototype printed the QAMF footnote on both branches; it
                  is only true of the lane grid. Karting comes from Office, and
                  the heats panel's own sentence says so. */}
              <div className="xs muted">
                {data.source === "heats"
                  ? "Availability from Office dayPlanner (live)."
                  : "Live from QAMF · includes front-desk, leagues and maintenance"}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
