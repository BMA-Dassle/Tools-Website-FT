"use client";

import { IconBuilding, IconHistory, IconPlus, IconSearch, IconUser } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CRM_BASE, type MirrorEvent } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { money } from "~/features/crm/core/format";
import { historyKeys } from "~/features/crm/bmi/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmUser } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { IconAvatar } from "./IconAvatar";
import { MirrorCard } from "./MirrorCard";
import { accountMeta, eventHost, eventMeta, wasRepLabel, windowLabel } from "./model";
import { fetchHistory, fetchLastYear } from "./queries";
import { HISTORY_TEST_IDS } from "./test-ids";

/**
 * `/admin/crm/history[?q=]` — ported from the prototype's `history` screen
 * (crm-shared.js:428-433): the search box, the Accounts list and the "This
 * time last year" list, fed by the BMI mirror. When a search term is given a
 * third card lists the mirrored EVENTS that match it (a host with no account
 * row is still findable by name, phone digits or email). The director also
 * sees the mirror control (backfill / delta / sync runs).
 *
 * "Start reach-out" creates a `source:'historical'` lead — that rail is the
 * leads PR's (B3); until it lands the button is present and disabled, and
 * says so.
 */
const SEARCH_DEBOUNCE_MS = 300;

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export default function HistoryScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const { isDirector } = useCrmUser();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);
  const q = urlQuery.q ?? "";
  const term = useDebounced(q.trim(), SEARCH_DEBOUNCE_MS);

  const historyQ = useInfiniteQuery({
    queryKey: historyKeys.search(term),
    queryFn: ({ pageParam }) =>
      fetchHistory(crmFetch, {
        q: term,
        accountsCursor: pageParam.accountsCursor,
        eventsCursor: pageParam.eventsCursor,
      }),
    initialPageParam: {
      accountsCursor: null as string | null,
      eventsCursor: null as string | null,
    },
    getNextPageParam: (last) =>
      last.accountsNextCursor || last.eventsNextCursor
        ? { accountsCursor: last.accountsNextCursor, eventsCursor: last.eventsNextCursor }
        : undefined,
  });

  const lastYearQ = useInfiniteQuery({
    queryKey: historyKeys.lastYear(null),
    queryFn: ({ pageParam }) => fetchLastYear(crmFetch, null, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const pages = historyQ.data?.pages ?? [];
  const accounts = pages.flatMap((p) => p.accounts);
  const events = pages.flatMap((p) => p.events);
  const mirror = pages[0]?.mirror ?? null;
  const lyPages = lastYearQ.data?.pages ?? [];
  const lastYear = lyPages.flatMap((p) => p.items);
  const window = lyPages[0]?.window ?? null;
  const mirrorEmpty = mirror !== null && mirror.projects === 0;

  return (
    <>
      <div className="search">
        <IconSearch {...ICON} />
        <input
          data-testid={HISTORY_TEST_IDS.search}
          type="search"
          aria-label="Search history"
          placeholder="Search host, business, phone or email…"
          value={q}
          onChange={(e) => setUrlQuery({ q: e.target.value })}
        />
      </div>

      {/* `.grid-2` alone, never an inline grid-template: the phone rule that
          collapses this to one column (crm.css @media max-width 768px) loses
          to an inline style, and the two cards would ride off the screen. */}
      <div className="grid grid-2">
        <div className="card" data-testid={HISTORY_TEST_IDS.accounts}>
          <div className="card-h">
            <h2>Accounts</h2>
            <div className="right">
              <Pill>{accounts.length} shown</Pill>
            </div>
          </div>
          <div className="list">
            {historyQ.isPending ? <LoadingState label="Loading accounts…" /> : null}
            {historyQ.isError ? (
              <div className="pad">
                <ErrorState
                  message={errorMessage(historyQ.error)}
                  onRetry={() => void historyQ.refetch()}
                />
              </div>
            ) : null}
            {historyQ.data && accounts.length === 0 ? (
              <EmptyState>
                {mirrorEmpty
                  ? isDirector
                    ? "No accounts yet — the BMI mirror is empty. Run a backfill below."
                    : "No accounts yet — the BMI mirror is empty."
                  : term
                    ? `No accounts match “${term}”.`
                    : "No accounts yet."}
              </EmptyState>
            ) : null}
            {accounts.map((a) => (
              <Link key={a.id} className="row" href={`${CRM_BASE}/account/${a.id}`}>
                <IconAvatar label={a.kind === "business" ? "Business" : "Household"}>
                  {a.kind === "business" ? <IconBuilding {...ICON} /> : <IconUser {...ICON} />}
                </IconAvatar>
                <div>
                  <div className="title">{a.name}</div>
                  <div className="meta">
                    {accountMeta(a).map((m, i) => (
                      <span key={i}>{m}</span>
                    ))}
                  </div>
                </div>
                <div className="right">
                  <span className="money strong">{money(a.lifetimeCents)}</span>
                  <span className="xs muted">lifetime</span>
                </div>
              </Link>
            ))}
            {historyQ.hasNextPage ? (
              <div className="pad">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={historyQ.isFetchingNextPage}
                  onClick={() => void historyQ.fetchNextPage()}
                >
                  {historyQ.isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="card" data-testid={HISTORY_TEST_IDS.lastYear}>
          <div className="card-h">
            <h2>This time last year</h2>
            <div className="right">{window ? <Pill>{windowLabel(window)}</Pill> : null}</div>
          </div>
          <div className="list">
            {lastYearQ.isPending ? <LoadingState label="Looking back a year…" /> : null}
            {lastYearQ.isError ? (
              <div className="pad">
                <ErrorState
                  message={errorMessage(lastYearQ.error)}
                  onRetry={() => void lastYearQ.refetch()}
                />
              </div>
            ) : null}
            {lastYearQ.data && lastYear.length === 0 ? (
              <EmptyState>All caught up</EmptyState>
            ) : null}
            {lastYear.map((e) => (
              <LastYearRow key={e.projectId} event={e} />
            ))}
            {lastYearQ.hasNextPage ? (
              <div className="pad">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={lastYearQ.isFetchingNextPage}
                  onClick={() => void lastYearQ.fetchNextPage()}
                >
                  {lastYearQ.isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {term ? (
        <div className="card" data-testid={HISTORY_TEST_IDS.events}>
          <div className="card-h">
            <h2>Events</h2>
            <div className="right">
              <Pill>{events.length} shown</Pill>
            </div>
          </div>
          <div className="list">
            {historyQ.data && events.length === 0 ? (
              <EmptyState>No events match “{term}”.</EmptyState>
            ) : null}
            {events.map((e) => (
              <EventRow key={e.projectId} event={e} />
            ))}
          </div>
        </div>
      ) : null}

      {isDirector ? <MirrorCard mirror={mirror} canEdit={isDirector} /> : null}
    </>
  );
}

function LastYearRow({ event: e }: { event: MirrorEvent }) {
  const was = wasRepLabel(e);
  return (
    <div className="row">
      <IconAvatar label="Last year">
        <IconHistory {...ICON} />
      </IconAvatar>
      <div>
        <div className="title">{eventHost(e)}</div>
        <div className="meta">
          {eventMeta(e).map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      </div>
      <div className="right">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled
          title="Reach-out leads arrive with the leads PR"
        >
          <IconPlus {...ICON} /> Start reach-out
        </button>
        {was ? <span className="xs muted">{was}</span> : null}
      </div>
    </div>
  );
}

function EventRow({ event: e }: { event: MirrorEvent }) {
  const body = (
    <>
      <IconAvatar label="Event">
        <IconHistory {...ICON} />
      </IconAvatar>
      <div>
        <div className="title">
          {eventHost(e)}
          {e.name && e.name !== eventHost(e) ? <span className="muted small">{e.name}</span> : null}
        </div>
        <div className="meta">
          {eventMeta(e).map((m, i) => (
            <span key={i}>{m}</span>
          ))}
          {e.stateName ? <span>{e.stateName}</span> : null}
        </div>
      </div>
      <div className="right">
        {e.rep ? (
          <span className="hstack small">
            <Avatar initials={e.rep.initials} repSlug={e.rep.slug} name={e.rep.firstName} sm />
            {e.rep.firstName}
          </span>
        ) : e.responsibleName ? (
          <span className="xs muted">{e.responsibleName}</span>
        ) : null}
      </div>
    </>
  );
  return e.accountId ? (
    <Link className="row" href={`${CRM_BASE}/account/${e.accountId}`}>
      {body}
    </Link>
  ) : (
    <div className="row">{body}</div>
  );
}
