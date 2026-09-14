"use client";

import { IconArrowLeft, IconArrowRight, IconCalendarPlus } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { CENTRE_CODES, CENTRES } from "~/features/crm/core/centres";
import type { ScreenProps } from "~/features/crm/core/screens";
import type { CentreCode } from "~/features/crm/core/types";
import {
  EVENTS_COPY,
  EVENT_TEST_IDS,
  type EventPillKind,
  type EventRowView,
  type EventsView,
} from "~/features/crm/events/contracts";
import { EVENTS_POLL_MS, eventsKeys } from "~/features/crm/events/queries";
import { dayRange, monthJumps, stepDate } from "~/features/crm/events/projection";
import { todayEasternYmd } from "~/features/crm/core/dates";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import { useCrmFetch, useCrmSheet, useCrmToast, useTopbarSlot } from "../lib/use-crm-user";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Seg } from "../primitives/Seg";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { DealDrawer } from "../deal/DealDrawer";
import type { DealTabId } from "../deal/tabs";
import { CreateLeadFromEventSheet } from "./CreateLeadFromEventSheet";
import { DayBand } from "./DayBand";
import { createLeadFromEventRow, fetchEventsBoard } from "./queries";
import { rangeLabel } from "./model";

/**
 * `/admin/crm/events[?centre=&view=day|week&date=&cancelled=1]` — the
 * prototype's `events` screen (crm-events.js:244-254): the Day / Week and
 * centre segmented controls in the topbar, a Prev / Next / Today strip with
 * the pill legend, then one card per day.
 *
 * Rows open the SAME deal drawer the pipeline and the queue open, on the Event
 * tab (`?deal=<publicId>&tab=event`) — filters live in the URL, so a link is a
 * saved view.
 */

const VIEW_OPTIONS: { value: EventsView; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
];

/**
 * "All" leads, because a planner asking "what is on this week" usually means
 * the company, not one building. Owner, 2026-09-14: "I'd like an 'all' in top
 * right."
 */
const CENTRE_OPTIONS = [
  { value: "all", label: "All" },
  ...CENTRE_CODES.map((code) => ({ value: code, label: CENTRES[code].short })),
];

/**
 * The three money states worth filtering on, in the order the legend has
 * always drawn them. "gf" and "none" are deliberately absent: "some other
 * contract state" and "no contract" are not what anybody means by "show me the
 * unsigned ones", and a filter nobody can name is a filter nobody uses.
 */
const MONEY_FILTERS: ReadonlyArray<{ kind: EventPillKind; label: string; chip: "won" | "warn" }> = [
  { kind: "paid", label: "PAID", chip: "won" },
  { kind: "deposit", label: "DEPOSIT", chip: "won" },
  { kind: "unsigned", label: "UNSIGNED", chip: "warn" },
];

function isCentre(value: string | undefined): value is CentreCode {
  return !!value && (CENTRE_CODES as readonly string[]).includes(value);
}

type CentreFilter = CentreCode | "all";

function isCentreFilter(value: string | undefined): value is CentreFilter {
  return value === "all" || isCentre(value);
}

export default function EventsScreen({ query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const slot = useTopbarSlot();
  const { openSheet, closeSheet } = useCrmSheet();
  const qc = useQueryClient();
  const toast = useCrmToast();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);

  const centre: CentreFilter = isCentreFilter(urlQuery.centre) ? urlQuery.centre : "HPFM";
  /**
   * The row's own centre is only worth printing when the board is mixing them.
   * On a board already filtered to Fort Myers, "HP Fort Myers" down every row
   * is the same noise the pipeline cards carried.
   */
  const showCentre = centre === "all";

  /**
   * The money states being shown, from `?money=paid,unsigned`. Empty = all of
   * them, which is the default and what a planner wants nine days in ten.
   */
  const money = (urlQuery.money ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m): m is EventPillKind => MONEY_FILTERS.some((f) => f.kind === m));

  const toggleMoney = (kind: EventPillKind) => {
    const next = money.includes(kind) ? money.filter((m) => m !== kind) : [...money, kind];
    setUrlQuery({ money: next.length ? next.join(",") : null });
  };
  const view: EventsView = urlQuery.view === "day" ? "day" : "week";
  const includeCancelled = urlQuery.cancelled === "1";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(urlQuery.date ?? "")
    ? (urlQuery.date as string)
    : todayEasternYmd();

  const q = useQuery({
    queryKey: eventsKeys.board(centre, view, date, includeCancelled),
    queryFn: () => fetchEventsBoard(crmFetch, { centre, view, date, includeCancelled }),
    refetchInterval: EVENTS_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const today = q.data?.today ?? todayEasternYmd();
  const openDeal = (publicId: string, tab: DealTabId = "event") =>
    setUrlQuery({ deal: publicId, tab });

  /**
   * CLICKING AN EVENT OPENS THE EVENT. Always.
   *
   * Owner, three times: "Why doesn't it open the event?", "still can't click on
   * event either and it says create lead", "Anywhere in all this stuff I should
   * be able to click anywhere on the lead tile to bring up event."
   *
   * The row used to open only when a `crm_leads` row already existed, and no
   * BMI event has one until it is adopted, so the board offered to manufacture
   * a sales lead instead. That is backwards: the Event tab reads BMI, so it can
   * show Paseo perfectly well with no lead anywhere. Nobody should be asked to
   * create a sales record in order to look at a booking that already exists.
   *
   * So the lead is created SILENTLY from the row's own fields — the same call
   * the sheet made, with the same values it would have pre-filled — and the
   * drawer opens on the Event tab. The sheet stays for the one case that needs
   * a human: a host whose name Office never recorded.
   *
   * `tab` is where the drawer lands: the Event tab from the row body, the
   * Contract tab from the money pill. An event and its contract are one record
   * seen from two sides, and the drawer's tabs are where they meet — so the
   * pill needs no screen of its own, only a different landing tab.
   */
  const openEvent = async (row: EventRowView, tab: DealTabId = "event") => {
    if (row.lead) return openDeal(row.lead.publicId, tab);
    const name = (row.personName || "").trim();
    if (!name) return createLead(row); // nothing to seed from — ask.
    const cut = name.lastIndexOf(" ");
    try {
      const r = await createLeadFromEventRow(crmFetch, row.projectId, {
        centre: row.centre,
        firstName: cut > 0 ? name.slice(0, cut) : name,
        lastName: cut > 0 ? name.slice(cut + 1) : "",
        phone: "",
        email: null,
        eventDate: row.when.slice(0, 10),
        eventTime: row.when.slice(11, 16) || null,
        guests: row.persons || 1,
        // Must be one of EVENT_TYPES. "group" is not one of them, and sending it
        // was the second half of the 400 that kept bouncing the planner back to
        // the form. The sheet's own default is the honest placeholder here: the
        // type is ours, not BMI's, and a planner can change it on the deal.
        type: "corporate",
      });
      void qc.invalidateQueries({ queryKey: eventsKeys.all });
      openDeal(r.lead.publicId, tab);
    } catch (err) {
      // Never swallow it into a dead click: fall back to the sheet, which can
      // show the guest what went wrong and let them correct it.
      toast(errorMessage(err), "crit");
      createLead(row);
    }
  };

  const createLead = (row: EventRowView) =>
    openSheet({
      title: `Create lead from ${row.number || "this event"}`,
      icon: <IconCalendarPlus {...ICON} />,
      wide: true,
      testId: EVENT_TEST_IDS.createLeadSheet,
      body: (
        <CreateLeadFromEventSheet
          row={row}
          onCancel={closeSheet}
          onDone={(publicId) => {
            closeSheet();
            openDeal(publicId);
          }}
        />
      ),
    });

  /**
   * The board, narrowed to the money states being asked for.
   *
   * Filtered HERE rather than in the query, because every row already carries
   * its own `pill.kind` — so this costs no second read of Office, which matters
   * most on the All board where one day is three centre reads. A day whose rows
   * are all filtered out keeps its band: an empty Friday is information ("none
   * unsigned that day"), where a missing Friday reads as a bug.
   */
  const days = (q.data?.days ?? []).map((band) =>
    money.length === 0
      ? band
      : { ...band, events: band.events.filter((e) => money.includes(e.pill.kind)) },
  );

  /**
   * Stepping order for the deal drawer: the board's own day order, but ONLY
   * the rows that already have a CRM lead.
   *
   * A row without one MINTS a lead when it is opened (`openEvent` falls through
   * to `createLeadFromEventRow`), and creating records is not something an
   * arrow key may do on the way past. So the arrows walk between deals that
   * exist; an event that is not in the CRM yet is still opened the normal way,
   * by tapping it, which is an explicit act.
   */
  const dealOrder = useMemo(
    () =>
      (q.data?.days ?? []).flatMap((d) =>
        d.events.map((e) => e.lead?.publicId).filter((id): id is string => Boolean(id)),
      ),
    [q.data],
  );
  const nothing = days.length > 0 && days.every((d) => d.events.length === 0 && !d.error);

  return (
    <>
      {slot
        ? createPortal(
            <>
              <Seg
                options={VIEW_OPTIONS}
                value={view}
                label="Day or week"
                onChange={(v) => setUrlQuery({ view: v === "week" ? null : v })}
              />
              <Seg
                options={CENTRE_OPTIONS}
                value={centre}
                label="Center"
                onChange={(v) => setUrlQuery({ centre: v === "HPFM" ? null : v })}
              />
            </>,
            slot,
          )
        : null}

      {/* "Plus ability to quickly select certain months" — the same jump, one
          press, anchored on the month being viewed so stepping forward and then
          picking a month behaves the way the strip reads. */}
      <div className="hstack" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="xs muted">Jump to</span>
        {monthJumps(date).map((m) => {
          const here = date.slice(0, 7) === m.ymd.slice(0, 7);
          return (
            <button
              key={m.ymd}
              type="button"
              className="btn btn-sm"
              aria-pressed={here}
              onClick={() => setUrlQuery({ date: m.ymd })}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      <div className="hstack between">
        <div className="hstack">
          <button
            type="button"
            className="btn btn-sm"
            aria-label={view === "week" ? "Previous week" : "Previous day"}
            onClick={() => setUrlQuery({ date: stepDate(date, view, -1) })}
          >
            <IconArrowLeft {...ICON} />
          </button>
          <b>{rangeLabel(dayRange(date, view))}</b>
          <button
            type="button"
            className="btn btn-sm"
            aria-label={view === "week" ? "Next week" : "Next day"}
            onClick={() => setUrlQuery({ date: stepDate(date, view, 1) })}
          >
            <IconArrowRight {...ICON} />
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setUrlQuery({ date: null })}>
            Today
          </button>
          {/* Jump straight to a day. Owner, 2026-09-14: "Add date and range
              filter for events page." Prev/Next/Today could only walk, so a
              date in November was ten presses away. `?date=` already carries
              it, so a jump stays a shareable URL. */}
          <label className="sr-only" htmlFor="crm-events-date">
            Jump to a date
          </label>
          <input
            id="crm-events-date"
            type="date"
            className="input"
            style={{ width: "auto" }}
            value={date}
            onChange={(e) => setUrlQuery({ date: e.target.value || null })}
          />
        </div>
        {/* THE LEGEND IS THE FILTER.
            These three described the board and did nothing — a row of chips
            that look exactly like the ones on every row, next to a control
            ("BMI state") that also only described. Owner, 2026-09-14: "filters
            based on statues on events page?"
            Pressed, each one narrows the board to that money state; pressed
            again it lets go. CLIENT-SIDE, deliberately: every row already
            carries its own `pill.kind`, so filtering costs no second read of
            Office — which matters on the All board, where a day is three
            centre reads. It lives in the URL like every other filter, so a
            link to "every unsigned event in October" is a link. */}
        <div className="hstack xs muted">
          {MONEY_FILTERS.map((f) => {
            const on = money.includes(f.kind);
            return (
              <button
                key={f.kind}
                type="button"
                className="chip-button"
                aria-pressed={on}
                title={on ? `Stop showing only ${f.label}` : `Show only ${f.label}`}
                onClick={() => toggleMoney(f.kind)}
              >
                <Chip kind={f.chip}>{f.label}</Chip>
              </button>
            );
          })}
          <Chip bmi>BMI state</Chip>
          <label className="hstack xs muted" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(e) => setUrlQuery({ cancelled: e.target.checked ? "1" : null })}
            />
            show cancelled
          </label>
        </div>
      </div>

      {q.isPending ? <LoadingState label="Reading BMI for these days…" /> : null}
      {q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : null}

      {q.data ? (
        <div className="stack" style={{ gap: 10 }} data-testid={EVENT_TEST_IDS.board}>
          {nothing ? (
            <EmptyState>
              {/* Say WHY it is empty. "No group events" under three pressed
                  filters is a screen telling somebody their data is missing
                  when in fact they hid it themselves. */}
              {money.length > 0 ? (
                <>
                  No {money.join(" or ")} events{" "}
                  {centre === "all" ? "anywhere" : `at ${CENTRES[centre].short}`} in this window.{" "}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setUrlQuery({ money: null })}
                  >
                    Show all
                  </button>
                </>
              ) : (
                <>
                  No group events {centre === "all" ? "anywhere" : `at ${CENTRES[centre].short}`} in
                  this window.
                </>
              )}
            </EmptyState>
          ) : null}
          {days.map((band) => (
            <DayBand
              key={band.date}
              band={band}
              todayYmd={today}
              onOpenEvent={(row) => void openEvent(row)}
              onOpenContract={(row) => void openEvent(row, "contract")}
              showCentre={showCentre}
            />
          ))}
        </div>
      ) : null}

      <div className="xs muted">{EVENTS_COPY.boardFoot}</div>

      {urlQuery.deal ? (
        <DealDrawer
          publicId={urlQuery.deal}
          onClose={() => setUrlQuery({ deal: null, tab: null })}
          query={urlQuery}
          setQuery={setUrlQuery}
          order={dealOrder}
        />
      ) : null}
    </>
  );
}
