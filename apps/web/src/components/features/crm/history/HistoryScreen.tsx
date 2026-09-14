"use client";

import { IconBuilding, IconHistory, IconPlus, IconSearch, IconUser } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CRM_BASE, type MirrorEvent } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { money } from "~/features/crm/core/format";
import { eventDayHref } from "~/features/crm/core/nav";
import { historyKeys } from "~/features/crm/bmi/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmToast, useCrmUser } from "../lib/use-crm-user";
import { Avatar } from "../primitives/Avatar";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { IconAvatar } from "./IconAvatar";
import { MirrorCard } from "./MirrorCard";
import { NewLeadSheet } from "../leads/NewLeadSheet";
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
  const { openSheet, closeSheet } = useCrmSheet();
  const toast = useCrmToast();

  /**
   * "This time last year" → a reach-out lead, seeded from the booking.
   *
   * Everything the mirror knows is handed over — the host's name split the way
   * every other adopt path splits it, the centre, the headcount, the phone and
   * email — EXCEPT the date. Last year's date is not this year's, and guessing
   * (same weekday? same week?) would be a date nobody chose sitting on a real
   * lead. The rep picks it, which is the conversation they are about to have
   * anyway.
   *
   * `source: "historical"` makes it a PROSPECT: no BMI project is minted and no
   * guest notification fires until somebody converts it on real interest.
   */
  const startReachOut = (e: MirrorEvent) => {
    const name = (e.personName || eventHost(e) || "").trim();
    const cut = name.lastIndexOf(" ");
    openSheet({
      title: `Reach out to ${name || "last year's guest"}`,
      icon: <IconPlus {...ICON} />,
      wide: true,
      body: (
        <NewLeadSheet
          defaultCentre={e.centre ?? "HPFM"}
          prefill={{
            source: "historical",
            centre: e.centre ?? "HPFM",
            firstName: cut > 0 ? name.slice(0, cut) : name,
            lastName: cut > 0 ? name.slice(cut + 1) : "",
            phone: e.personPhone ?? "",
            email: e.personEmail ?? "",
            guests: e.persons ? String(e.persons) : "",
          }}
          onCancel={closeSheet}
          onCreated={(r) => {
            closeSheet();
            toast(`Reach-out ${r.lead.publicId} started`);
          }}
        />
      ),
    });
  };
  const [urlQuery, setUrlQuery] = useUrlQuery(query);
  const q = urlQuery.q ?? "";
  const term = useDebounced(q.trim(), SEARCH_DEBOUNCE_MS);

  /**
   * ONE request per page, TWO independent cursors. A list that has run out is
   * marked `done` in the page param and switched OFF for the next request —
   * otherwise the server, seeing no cursor for it, would answer with its FIRST
   * page again and the screen would render those rows a second time (duplicate
   * keys, a doubled "N shown"). The mirror's counts ride the first page only:
   * they are two unfiltered counts over the whole mirror.
   */
  const historyQ = useInfiniteQuery({
    queryKey: historyKeys.search(term),
    queryFn: ({ pageParam }) =>
      fetchHistory(crmFetch, {
        q: term,
        accountsCursor: pageParam.accountsCursor,
        eventsCursor: pageParam.eventsCursor,
        accountsDone: pageParam.accountsDone,
        eventsDone: pageParam.eventsDone,
        withStatus: pageParam.accountsCursor === null && pageParam.eventsCursor === null,
      }),
    initialPageParam: {
      accountsCursor: null as string | null,
      eventsCursor: null as string | null,
      accountsDone: false,
      eventsDone: false,
    },
    getNextPageParam: (last, _pages, lastParam) => {
      const accountsDone = lastParam.accountsDone || !last.accountsNextCursor;
      const eventsDone = lastParam.eventsDone || !last.eventsNextCursor;
      if (accountsDone && eventsDone) return undefined;
      return {
        accountsCursor: last.accountsNextCursor,
        eventsCursor: last.eventsNextCursor,
        accountsDone,
        eventsDone,
      };
    },
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
  const lastPage = pages[pages.length - 1] ?? null;
  const moreAccounts = !!lastPage?.accountsNextCursor;
  const moreEvents = !!lastPage?.eventsNextCursor;
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
            {moreAccounts ? (
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
              <LastYearRow key={e.projectId} event={e} onReachOut={startReachOut} />
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
            {moreEvents ? (
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
      ) : null}

      {isDirector ? <MirrorCard mirror={mirror} canEdit={isDirector} /> : null}
    </>
  );
}

/**
 * WHERE A MIRRORED BOOKING GOES WHEN YOU CLICK IT.
 *
 * Owner, 2026-09-13: "Anywhere in all this stuff I should be able to click
 * anywhee on the lead tile to bring up event." These rows had two shapes and
 * one of them was dead: a link when the mirror had matched the booking to an
 * account, and a plain `<div>` when it had not.
 *
 * The account page is the right destination when there is one — it is this
 * host, every year. When there is not, the booking is still addressable by the
 * DAY it happened, which is the Events board: the same lens the Contracts board
 * now links to. Only a mirrored project with neither an account nor a placeable
 * date has nowhere to go, and then the row stays plain rather than pretending.
 *
 * It deliberately does NOT adopt the project into a CRM lead the way the Events
 * board does. `createLeadFromEvent` is not keyed on the project, so a second
 * click would mint a second lead for the same booking — and History is a
 * browsing surface where people click a lot of rows.
 */
function mirrorRowHref(e: MirrorEvent): string | null {
  if (e.accountId) return `${CRM_BASE}/account/${e.accountId}`;
  return eventDayHref(e);
}

function LastYearRow({
  event: e,
  onReachOut,
}: {
  event: MirrorEvent;
  onReachOut: (e: MirrorEvent) => void;
}) {
  const was = wasRepLabel(e);
  const href = mirrorRowHref(e);
  const title = eventHost(e);
  return (
    <div className="row row-click">
      <IconAvatar label="Last year">
        <IconHistory {...ICON} />
      </IconAvatar>
      <div>
        <div className="title">
          {href ? (
            <Link className="card-open" href={href} title={`Open ${title}`}>
              {title}
            </Link>
          ) : (
            title
          )}
        </div>
        <div className="meta">
          {eventMeta(e).map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      </div>
      <div className="right">
        {/* Enabled at last. This said "Reach-out leads arrive with the leads
            PR" long after that rail shipped: `create-lead.ts` has known
            `historical` (a PROSPECT — no BMI project, no notifications) since
            it was written, and only the route's zod schema was still refusing
            the source. Owner, 2026-09-14: "Why can't I start a reach out? says
            arrives with leads PR."
            It opens the sheet rather than creating silently, because LAST
            YEAR'S DATE IS NOT THIS YEAR'S — the one field we cannot infer is
            the one that matters, and a rep confirming it is the point of the
            reach-out. */}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onReachOut(e)}
          title={`Start a lead for ${eventHost(e)} from last year's booking`}
        >
          <IconPlus {...ICON} /> Start reach-out
        </button>
        {was ? <span className="xs muted">{was}</span> : null}
      </div>
    </div>
  );
}

function EventRow({ event: e }: { event: MirrorEvent }) {
  const href = mirrorRowHref(e);
  const title = eventHost(e);
  return (
    <div className="row row-click">
      <IconAvatar label="Event">
        <IconHistory {...ICON} />
      </IconAvatar>
      <div>
        <div className="title">
          {href ? (
            <Link className="card-open" href={href} title={`Open ${title}`}>
              {title}
            </Link>
          ) : (
            title
          )}
          {e.name && e.name !== title ? <span className="muted small">{e.name}</span> : null}
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
    </div>
  );
}
