"use client";

import { IconCheck, IconClock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { EVENT_TYPES, type CentreCode, type EventType } from "~/features/crm/core/types";
import { RULES_TEST_IDS } from "~/features/crm/rules/contracts";
import { EVENT_TYPE_LABEL } from "~/features/crm/rules/labels";
import { rulesKeys } from "~/features/crm/rules/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch } from "../lib/use-crm-user";
import { useDebouncedValue } from "../lib/use-debounced";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { RuleTrace } from "../primitives/RuleTrace";
import { ErrorState, LoadingState } from "../primitives/States";
import { parseGuests, traceRows, type CentreOption } from "./model";
import { fetchTryLead } from "./queries";

/**
 * "Try a lead" (crm-shared.js:457-462): guests · type · centre (· event date,
 * because the standard rule balances a real party month) → the verdict banner
 * and the rule trace from the SAME engine and context the sweep uses right
 * now. The fields live in the URL (`?guests=&type=&centre=&eventDate=`) so a
 * link is a saved scenario; the roster override invalidates the rules key, so
 * this re-runs when the roster changes — "Change the roster above and this
 * re-runs."
 */
/** Long enough to swallow a typed number, short enough to feel live. */
export const TRY_DEBOUNCE_MS = 300;

export interface TryLeadProps {
  centres: CentreOption[];
  values: { guests: string; type: EventType; centre: CentreCode; eventDate: string };
  onChange: (patch: Partial<TryLeadProps["values"]>) => void;
}

export function TryLead({ centres, values, onChange }: TryLeadProps) {
  const crmFetch = useCrmFetch();
  const ids = useId();
  const guests = parseGuests(values.guests);
  const params = {
    guests: guests ?? 0,
    type: values.type,
    centre: values.centre,
    eventDate: values.eventDate || undefined,
  };
  // Every run is four Neon queries (reps · rules · shifts · open volume), so
  // the fields settle before they reach the query key — typing "120" fires one
  // request, not three. The URL still updates immediately: the link is live.
  const settled = useDebouncedValue(
    params,
    TRY_DEBOUNCE_MS,
    `${params.guests}|${params.type}|${params.centre}|${params.eventDate ?? ""}`,
  );

  const tryQ = useQuery({
    queryKey: rulesKeys.try(settled),
    queryFn: () => fetchTryLead(crmFetch, settled),
    enabled: settled.guests >= 1,
    placeholderData: (prev) => prev,
  });

  const d = tryQ.data?.decision;
  const rows = d ? traceRows(d) : null;

  return (
    <div className="card" data-testid={RULES_TEST_IDS.tryLead}>
      <div className="card-h">
        <h2>Try a lead</h2>
      </div>
      <div className="pad stack">
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor={`${ids}-guests`}>Guests</label>
            <input
              id={`${ids}-guests`}
              className="input tabular"
              inputMode="numeric"
              value={values.guests}
              onChange={(e) => onChange({ guests: e.target.value })}
              aria-invalid={guests === null}
            />
          </div>
          <div className="field">
            <label htmlFor={`${ids}-type`}>Type</label>
            <select
              id={`${ids}-type`}
              className="select"
              value={values.type}
              onChange={(e) => onChange({ type: e.target.value as EventType })}
            >
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EVENT_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${ids}-centre`}>Centre</label>
            <select
              id={`${ids}-centre`}
              className="select"
              value={values.centre}
              onChange={(e) => onChange({ centre: e.target.value as CentreCode })}
            >
              {centres.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.short}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${ids}-date`}>Event date</label>
            <input
              id={`${ids}-date`}
              className="input"
              type="date"
              value={values.eventDate}
              onChange={(e) => onChange({ eventDate: e.target.value })}
            />
          </div>
        </div>

        {guests === null ? (
          <Banner tone="warn">Guests must be a whole number of 1 or more.</Banner>
        ) : null}
        {tryQ.isPending && guests !== null ? <LoadingState label="Running the rules…" /> : null}
        {tryQ.isError ? (
          <ErrorState message={errorMessage(tryQ.error)} onRetry={() => void tryQ.refetch()} />
        ) : null}
        {d && rows ? (
          <>
            <Banner
              tone={d.rep ? "good" : "warn"}
              icon={d.rep ? <IconCheck {...ICON} /> : <IconClock {...ICON} />}
              role="none"
              testId={RULES_TEST_IDS.tryVerdict}
            >
              {d.rep ? (
                <>
                  <b>{d.rep.displayName}</b> · {d.reason}
                </>
              ) : (
                <>
                  <b>Stays in the queue</b> · {d.reason}
                </>
              )}
            </Banner>
            <RuleTrace steps={rows.steps} finalRuleId={rows.finalRuleId} />
            <div className="xs muted">
              Right now it is {tryQ.data!.nowLabel}. Change the roster above and this re-runs.
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
