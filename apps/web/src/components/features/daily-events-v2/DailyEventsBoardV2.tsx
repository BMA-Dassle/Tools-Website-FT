"use client";

/**
 * Daily Events v2 board — owner-approved hybrid (2026-07-13), deployed
 * alongside v1 (which stays untouched at /daily-events).
 *
 * Kept from v1: the whole feature layer (fetchDayReservations,
 * getPaymentsBulk, Wed–Tue week math), banded day sections, two-line rows,
 * PaymentCell, DailyEventModal with the ?event= deep link.
 *
 * New: a Day ⇄ Week toggle (Week = seven day-cards for the Wed–Tue period
 * containing the anchor date, replacing the Last/Current/Next tabs), a
 * needs-attention strip that turns exceptions into sentences, and per-day
 * money/risk summaries in the band — skinned with the employee portal's
 * design system (navy gradient, blue primary, Poppins; see ./theme.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { BOARD_CSS, baThemeCss } from "~/components/features/reservations-admin/theme";
import {
  fetchDayReservations,
  fetchLocalEvents,
  fetchSettledCheck,
  getPaymentsBulk,
  type LocalDayEvent,
} from "~/features/daily-events/api";
import { DEFAULT_WAIVER_THRESHOLDS, LOCATIONS } from "~/features/daily-events/constants";
import { fmtDateLabelLong, fmtEventTime, todayET } from "~/features/daily-events/format";
import { useBoardTheme } from "~/features/daily-events/hooks";
import {
  applyViewTypeFilter,
  isPendingSignedContract,
  isSendContract,
} from "~/features/daily-events/logic";
import type { Reservation, WebsitePaymentInfo } from "~/features/daily-events/types";
import { formatDisplayDate, getDaysInPeriod, getWeekPeriod } from "~/features/daily-events/week";

import DailyEventModal from "../daily-events/DailyEventModal";
import { DE_CSS } from "../daily-events/theme";
import DayCard from "./DayCard";
import { ADMIN_SANS, PORTAL_BLUE, PORTAL_SKIN_CSS } from "~/components/features/admin-skin/theme";
import { usePortalAutoHeight } from "~/components/features/admin-skin/usePortalAutoHeight";

type ViewMode = "day" | "week";

interface DayData {
  date: string;
  reservations: Reservation[];
}

interface AttentionItem {
  key: string;
  reservation: Reservation;
  kind: "money" | "contract" | "waiver";
  name: string;
  /** Muted context: when · contact. */
  meta: string;
  /** Right-aligned figure: open $ for money. */
  right: string;
  /** Money item whose contract is also unsigned — gets a second pill. */
  unsigned?: boolean;
  amountCents?: number;
  /** Which detail-modal tab clicking this row lands on. */
  targetTab: "Payments" | "Contract" | "Guest";
}

/** Issue pills — same visual language as the board's payment pills. */
const ATTENTION_PILL: Record<
  AttentionItem["kind"] | "unsigned",
  { label: string; bg: string; fg: string }
> = {
  money: { label: "UNPAID", bg: "rgba(239,68,68,0.18)", fg: "#f87171" },
  unsigned: { label: "UNSIGNED", bg: "rgba(168,85,247,0.18)", fg: "#c084fc" },
  contract: { label: "SEND CONTRACT", bg: "rgba(99,102,241,0.18)", fg: "#a5b4fc" },
  waiver: { label: "WAIVERS", bg: "rgba(245,158,11,0.15)", fg: "#fbbf24" },
};

function AttentionPill({ kind }: { kind: AttentionItem["kind"] | "unsigned" }) {
  const p = ATTENTION_PILL[kind];
  return (
    <span
      style={{
        padding: "1px 7px",
        borderRadius: 9999,
        backgroundColor: p.bg,
        color: p.fg,
        fontSize: "9px",
        fontWeight: 700,
        whiteSpace: "nowrap",
        alignSelf: "center",
        flexShrink: 0,
      }}
    >
      {p.label}
    </span>
  );
}

/** Reflect board state in the URL — best-effort, mirrors v1's ?event=. */
function setUrlParams(params: Record<string, string | null>) {
  try {
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(null, "", url.toString());
  } catch {
    /* URL state is best-effort */
  }
}

function fmtUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Exceptions → compact rows, most urgent first: unpaid/unsigned money, then
 * quotes stuck before send. The UI collapses long lists behind a "Show all"
 * expander, so no cap here.
 */
function buildAttention(
  days: DayData[],
  payments: Map<string, WebsitePaymentInfo>,
  today: string,
): AttentionItem[] {
  const money: AttentionItem[] = [];
  const contracts: AttentionItem[] = [];

  for (const { date, reservations } of days) {
    for (const r of reservations) {
      if (r._isDayPlannerBlock) continue;
      const when =
        date === today
          ? `today ${fmtEventTime(r.when)}`.trim()
          : formatDisplayDate(date) + (r.when ? ` ${fmtEventTime(r.when)}` : "");
      const meta = r.personName ? `${when} · ${r.personName}` : when;
      const name = r.name || `#${r.number}`;

      const wp = payments.get(r.number || r.id);
      if (
        wp &&
        !wp.isFullyPaid &&
        wp.depositPaidCents === 0 &&
        !wp.status.includes("cancel") &&
        wp.totalCents > 0
      ) {
        money.push({
          key: `money-${r.id}`,
          reservation: r,
          kind: "money",
          name,
          meta,
          right: fmtUsd(wp.totalCents),
          unsigned: isPendingSignedContract(r.state),
          amountCents: wp.totalCents,
          targetTab: "Payments",
        });
      } else if (isSendContract(r.state)) {
        contracts.push({
          key: `send-${r.id}`,
          reservation: r,
          kind: "contract",
          name,
          meta,
          right: "",
          targetTab: "Contract",
        });
      }

      // Waiver shortfalls deliberately NOT surfaced here (owner 2026-07-13):
      // the day-list rows already show red registered-counts and stripes.
    }
  }
  return [...money, ...contracts];
}

/** How many attention rows show before the "Show all" expander. */
const ATTENTION_COLLAPSED = 4;

/** Owner 2026-07-13: hidden for now ("I don't like it") — flip to bring back. */
const SHOW_ATTENTION = false;

// Portal button idiom: outline (border + transparent) at rest, solid
// primary-blue with white text when selected (shadcn default/outline pair).
const NAV_A: React.CSSProperties = {
  color: "var(--ba-muted)",
  border: "1px solid var(--ba-input-border)",
  borderRadius: 8,
  padding: "4px 12px",
  fontSize: "0.8rem",
  fontWeight: 500,
  backgroundColor: "transparent",
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: "inherit",
};

const NAV_ON: React.CSSProperties = {
  ...NAV_A,
  color: "#ffffff",
  backgroundColor: PORTAL_BLUE,
  border: `1px solid ${PORTAL_BLUE}`,
  fontWeight: 600,
};

const NAV_LOC_ON: React.CSSProperties = {
  ...NAV_A,
  color: "var(--ba-fg)",
  backgroundColor: "var(--ba-hover)",
  border: "1px solid var(--ba-input-border)",
  fontWeight: 600,
};

export default function DailyEventsBoardV2({
  token,
  embedded,
}: {
  token: string;
  /** Portal iframe mode: the portal owns date/location context, so the
   *  date nav, location pills, and v1-board link are hidden. */
  embedded?: boolean;
}) {
  const theme = useBoardTheme();
  const waiverThresholds = DEFAULT_WAIVER_THRESHOLDS;

  // Defaults on first render, URL params applied after mount — unlike v1's
  // lazy window-reading initializers, this hydrates clean (?date= deep links
  // gave v1 a server/client heading mismatch).
  const [date, setDate] = useState<string>(todayET);
  const [view, setView] = useState<ViewMode>("day");
  const [locationId, setLocationId] = useState<number>(332160);
  // Cancelled events are hidden by default (owner request); ?cancelled=1 shows.
  const [showCancelled, setShowCancelled] = useState(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const d = sp.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
    if (sp.get("view") === "week") setView("week");
    if (sp.get("cancelled") === "1") setShowCancelled(true);
    const raw = sp.get("location");
    const n = raw ? parseInt(raw, 10) : NaN;
    if (LOCATIONS.some((l) => l.id === n)) setLocationId(n);
  }, []);

  const today = todayET();

  // The dates in scope: one for Day, the Wed–Tue period for Week.
  const scopeDates = useMemo(() => {
    if (view === "day") return [date];
    const period = getWeekPeriod(new Date(`${date}T12:00:00Z`));
    return getDaysInPeriod(period.start, period.end);
  }, [view, date]);

  const [board, setBoard] = useState<DayData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [websitePayments, setWebsitePayments] = useState<Map<string, WebsitePaymentInfo>>(
    new Map(),
  );
  /** Quote-less events → POS check total cents (null = checked, no check). */
  const [posChecks, setPosChecks] = useState<Map<string, number | null>>(new Map());

  // ONE PAINT, PERIOD (owner 2026-07-13: any provisional rows that BMI later
  // corrects read as things "half disappearing"). The board holds a spinner
  // until BMI truth is in for every date, then paints once — fast, because
  // the daily-events-cache-warm cron keeps today−1…+13 hot (~0.1s/date).
  // The Neon fetch runs alongside purely to pre-fill payment pills and as a
  // fallback if a date's BMI fetch dies. Group functions only; v1 keeps the
  // online view.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBoard(null);
    setWebsitePayments(new Map());
    setPosChecks(new Map());

    let localData: Record<string, LocalDayEvent[]> | null = null;

    fetchLocalEvents(token, scopeDates, locationId)
      .then((byDate) => {
        if (cancelled) return;
        localData = byDate;
        setWebsitePayments((prev) => {
          const next = new Map(prev);
          for (const list of Object.values(byDate)) {
            for (const e of list) {
              const key = e.reservation.number || e.reservation.id;
              if (!next.has(key)) next.set(key, e.payment);
            }
          }
          return next;
        });
      })
      .catch(() => {
        /* payments arrive via getPaymentsBulk after the paint instead */
      });

    void Promise.all(
      scopeDates.map((day) =>
        fetchDayReservations(token, day, locationId)
          .catch(() => fetchDayReservations(token, day, locationId))
          .then((data) => ({
            day,
            ok: true,
            reservations: applyViewTypeFilter(data.reservations || [], "group"),
          }))
          .catch(() => ({ day, ok: false, reservations: null })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const days = results.map((r) => ({
        date: r.day,
        // Total BMI failure for a date → fall back to its Neon rows.
        reservations: r.reservations ?? (localData?.[r.day] ?? []).map((e) => e.reservation),
      }));
      setBoard(days);
      if (scopeDates.length === 1 && !results[0].ok) {
        setError("BMI lookup failed — showing website events only");
      }
      const all = days.flatMap((d) => d.reservations).filter((r) => !r._provisional);
      if (all.length > 0) {
        getPaymentsBulk(token, all)
          .then((m) => {
            if (cancelled) return;
            setWebsitePayments((prev) => new Map([...prev, ...m]));
            // Quote-less events (no website record anywhere): ask Square for
            // a "BMI <n>" POS close-out so the board can show PAID instead
            // of SQUARE CLOSEOUT (owner 2026-07-13; server caches hits 7d).
            const quoteKeys = new Set<string>(m.keys());
            if (localData) {
              for (const list of Object.values(localData)) {
                for (const e of list) quoteKeys.add(e.reservation.number || e.reservation.id);
              }
            }
            // No balance gate: venues often record the payment in BMI after
            // the close-out, zeroing the balance (3253 did) — the POS check
            // is still the PAID signal. Server caches hits 7 days.
            const candidates = all.filter(
              (r) =>
                !r._isDayPlannerBlock &&
                r.number &&
                r.when &&
                !quoteKeys.has(r.number || r.id) &&
                !(r.state || "").toLowerCase().includes("cancel"),
            );
            for (const r of candidates) {
              fetchSettledCheck(token, { eventNumber: r.number, when: r.when, locationId })
                .then((chk) => {
                  if (cancelled) return;
                  setPosChecks((prev) =>
                    new Map(prev).set(r.number || r.id, chk ? (chk.totalCents ?? 0) : null),
                  );
                })
                .catch(() => {
                  if (!cancelled) {
                    setPosChecks((prev) => new Map(prev).set(r.number || r.id, null));
                  }
                });
            }
          })
          .catch(() => {});
      }
    });

    return () => {
      cancelled = true;
    };
  }, [token, locationId, scopeDates]);

  const days = board ?? [];
  const allLoaded = board !== null;
  const anyContent = days.length > 0;

  // Hide-cancelled filter feeds EVERYTHING downstream: cards, summaries,
  // attention, totals, and modal prev/next navigation.
  const { visibleDays, cancelledCount } = useMemo(() => {
    let cancelled = 0;
    const filtered = days.map((d) => ({
      ...d,
      reservations: d.reservations.filter((r) => {
        const isCancelled = (r.state || "").toLowerCase().includes("cancel");
        if (isCancelled) cancelled++;
        return showCancelled || !isCancelled;
      }),
    }));
    return { visibleDays: filtered, cancelledCount: cancelled };
  }, [days, showCancelled]);

  const attention = useMemo(
    () => buildAttention(visibleDays, websitePayments, today),
    [visibleDays, websitePayments, today],
  );
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const attentionOpenCents = useMemo(
    () => attention.reduce((s, a) => s + (a.amountCents || 0), 0),
    [attention],
  );

  const totals = useMemo(() => {
    const all = visibleDays.flatMap((d) => d.reservations);
    return {
      events: all.length,
      persons: all.reduce((s, r) => s + (r.persons || 0), 0),
    };
  }, [visibleDays]);

  // ── Navigation ──
  function go(next: { date?: string; view?: ViewMode; location?: number }) {
    if (next.date) setDate(next.date);
    if (next.view) setView(next.view);
    if (next.location) setLocationId(next.location);
    setUrlParams({
      date: next.date ?? date,
      view: (next.view ?? view) === "week" ? "week" : null,
      location: String(next.location ?? locationId),
    });
  }
  const step = view === "day" ? 1 : 7;

  const heading =
    view === "day"
      ? fmtDateLabelLong(date)
      : `Week of ${formatDisplayDate(scopeDates[0])} – ${formatDisplayDate(scopeDates[scopeDates.length - 1])}`;

  // Week view: runs of 2+ consecutive empty days combine into one slim band.
  // Safe again under the two-paint model — the layout settles at most once
  // (owner 2026-07-13, third ruling: combining is back now that per-day
  // churn is gone).
  type RenderGroup = { kind: "day"; day: DayData } | { kind: "emptyRun"; days: DayData[] };
  const renderGroups = useMemo<RenderGroup[]>(() => {
    if (view !== "week") return visibleDays.map((day) => ({ kind: "day" as const, day }));
    const groups: RenderGroup[] = [];
    let run: DayData[] = [];
    const flush = () => {
      if (run.length >= 2) groups.push({ kind: "emptyRun", days: run });
      else for (const day of run) groups.push({ kind: "day", day });
      run = [];
    };
    for (const d of visibleDays) {
      if (d.reservations.length === 0) run.push(d);
      else {
        flush();
        groups.push({ kind: "day", day: d });
      }
    }
    flush();
    return groups;
  }, [view, visibleDays]);

  // ── Detail modal (v1 mechanics, ?event= deep link) ──
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [modalIds, setModalIds] = useState<string[]>([]);
  const visibleIds = useMemo(
    () =>
      visibleDays.flatMap((d) =>
        d.reservations.filter((r) => !r._isDayPlannerBlock).map((r) => r.id),
      ),
    [visibleDays],
  );

  // Attention rows deep-link into the tab that fixes the problem
  // (unpaid → Payments, contract → Contract, waivers → Guest).
  const [modalTab, setModalTab] = useState<string | undefined>(undefined);
  function openDetail(r: Reservation, tab?: string) {
    if (r._isDayPlannerBlock) return;
    setModalTab(tab);
    setSelectedEventId(r.id);
    setModalIds(visibleIds);
    setUrlParams({ event: r.id });
  }
  function closeDetail() {
    setSelectedEventId(null);
    setModalIds([]);
    setModalTab(undefined);
    setUrlParams({ event: null });
  }

  const [pendingEvent, setPendingEvent] = useState<{ id: string; tab: string | null } | null>(
    () => {
      if (typeof window === "undefined") return null;
      const sp = new URLSearchParams(window.location.search);
      const id = sp.get("event");
      return id ? { id, tab: sp.get("tab") } : null;
    },
  );
  if (pendingEvent != null && allLoaded) {
    setSelectedEventId(pendingEvent.id);
    setModalTab(pendingEvent.tab ?? undefined);
    setModalIds(visibleIds.includes(pendingEvent.id) ? visibleIds : []);
    setPendingEvent(null);
  }

  // Portal-embed state broadcast: URL mirroring PLUS everything the portal
  // needs to render the header itself (embedded mode hides our whole top
  // line — heading, Day/Week, Cancelled — to free real estate; owner
  // 2026-07-13). Same postMessage channel the theme sync already rides.
  useEffect(() => {
    if (!embedded || typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage(
      {
        type: "daily-events-state",
        location: String(locationId),
        date,
        view,
        cancelled: showCancelled ? "1" : null,
        event: selectedEventId,
        tab: selectedEventId ? (modalTab ?? null) : null,
        // Header payload — render-ready.
        heading,
        locationLabel: LOCATIONS.find((l) => l.id === locationId)?.label ?? "",
        events: allLoaded ? totals.events : null,
        persons: allLoaded ? totals.persons : null,
        cancelledCount,
        loaded: allLoaded,
      },
      "*",
    );
  }, [
    embedded,
    locationId,
    date,
    view,
    showCancelled,
    selectedEventId,
    modalTab,
    heading,
    allLoaded,
    totals,
    cancelledCount,
  ]);

  // Portal-embed remote control: the portal's own header buttons drive the
  // board (Day/Week, Cancelled, date/location pickers, open/close event).
  useEffect(() => {
    if (!embedded || typeof window === "undefined") return;
    function onMessage(e: MessageEvent) {
      if (e.origin !== "https://portal.headpinz.com") return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || d.type !== "daily-events-control") return;
      if (d.view === "day" || d.view === "week") setView(d.view);
      if (typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) setDate(d.date);
      const loc = Number(d.location);
      if (LOCATIONS.some((l) => l.id === loc)) setLocationId(loc);
      if (typeof d.showCancelled === "boolean") setShowCancelled(d.showCancelled);
      if (d.event === null) {
        setSelectedEventId(null);
        setModalTab(undefined);
        setModalIds([]);
      } else if (typeof d.event === "string" && d.event) {
        setSelectedEventId(d.event);
        setModalTab(typeof d.tab === "string" && d.tab ? d.tab : undefined);
        setModalIds(visibleIds.includes(d.event) ? visibleIds : []);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [embedded, visibleIds]);

  // Portal-embed auto-height (see usePortalAutoHeight for the contract).
  usePortalAutoHeight("daily-events-resize", !!embedded, selectedEventId !== null);

  // Modal open/close signal: the portal locks ITS page scroll, sizes the
  // iframe to the visible viewport, scrolls it into view, and ignores
  // resize messages while open — kills the modal double-scroll (owner
  // 2026-07-13; see the daily-events-modal contract).
  useEffect(() => {
    if (!embedded || typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage({ type: "daily-events-modal", open: selectedEventId !== null }, "*");
  }, [embedded, selectedEventId]);

  const themeStyle =
    baThemeCss(theme) +
    BOARD_CSS +
    DE_CSS +
    PORTAL_SKIN_CSS +
    ".de-attn:hover { background-color: rgba(245,158,11,0.09); }";

  return (
    <div
      data-ba-theme={theme}
      className="portal-skin"
      style={{
        // Embedded: the iframe is sized to our content (daily-events-resize),
        // so a viewport-relative min-height would feed back and only grow.
        minHeight: embedded ? undefined : "100vh",
        color: "var(--ba-fg)",
        padding: "1rem",
        fontFamily: ADMIN_SANS,
      }}
    >
      {/* eslint-disable-next-line react/no-danger -- theme CSS variables */}
      <style dangerouslySetInnerHTML={{ __html: themeStyle }} />

      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {/* ── Top line — embedded mode renders NONE of it: the portal owns
            the heading, totals, and every control via daily-events-state /
            daily-events-control (owner 2026-07-13, frees real estate) ── */}
        {!embedded && (
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 16,
              flexWrap: "wrap",
              marginBottom: 18,
            }}
          >
            <h1 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0 }}>{heading}</h1>
            {anyContent && (
              <span style={{ color: "var(--ba-muted)", fontSize: "0.82rem" }}>
                {LOCATIONS.find((l) => l.id === locationId)?.label} · {totals.events} event
                {totals.events === 1 ? "" : "s"} · {totals.persons} people
              </span>
            )}
            <span
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: 6,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                style={view === "day" ? NAV_ON : NAV_A}
                onClick={() => go({ view: "day" })}
              >
                Day
              </button>
              <button
                type="button"
                style={view === "week" ? NAV_ON : NAV_A}
                onClick={() => go({ view: "week" })}
              >
                Week
              </button>
              {!embedded && (
                <>
                  <span style={{ width: 8 }} />
                  <button
                    type="button"
                    aria-label="Previous"
                    style={NAV_A}
                    onClick={() => go({ date: shiftDate(date, -step) })}
                  >
                    ‹
                  </button>
                  <button type="button" style={NAV_A} onClick={() => go({ date: today })}>
                    {view === "day" ? "Today" : "This week"}
                  </button>
                  <button
                    type="button"
                    aria-label="Next"
                    style={NAV_A}
                    onClick={() => go({ date: shiftDate(date, step) })}
                  >
                    ›
                  </button>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => e.target.value && go({ date: e.target.value })}
                    aria-label="Jump to date"
                    style={{
                      ...NAV_A,
                      colorScheme: theme,
                      color: "var(--ba-fg)",
                      backgroundColor: "var(--ba-input-bg)",
                      fontSize: "0.78rem",
                    }}
                  />
                  <span style={{ width: 8 }} />
                  {LOCATIONS.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      style={locationId === l.id ? NAV_LOC_ON : NAV_A}
                      onClick={() => go({ location: l.id })}
                    >
                      {l.short}
                    </button>
                  ))}
                </>
              )}
              <span style={{ width: 8 }} />
              {cancelledCount > 0 && (
                <button
                  type="button"
                  title={
                    showCancelled
                      ? "Hide cancelled events"
                      : `${cancelledCount} cancelled event${cancelledCount === 1 ? "" : "s"} hidden — click to show`
                  }
                  style={showCancelled ? NAV_LOC_ON : NAV_A}
                  onClick={() => {
                    const next = !showCancelled;
                    setShowCancelled(next);
                    setUrlParams({ cancelled: next ? "1" : null });
                  }}
                >
                  Cancelled · {cancelledCount}
                </button>
              )}
            </span>
          </div>
        )}

        {/* ── Needs attention — the portal's amber note-box idiom ── */}
        {SHOW_ATTENTION && anyContent && attention.length > 0 && (
          <div
            style={{
              backgroundColor: "rgba(245,158,11,0.1)",
              border: "1px solid rgba(245,158,11,0.3)",
              borderRadius: 8,
              padding: "10px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 7,
              marginBottom: 22,
            }}
          >
            <span
              style={{
                fontSize: "0.7rem",
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "#fbbf24",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              Needs attention · {attention.length}
              {attentionOpenCents > 0 && <> · {fmtUsd(attentionOpenCents)} open</>}
            </span>
            {(attentionExpanded ? attention : attention.slice(0, ATTENTION_COLLAPSED)).map((a) => (
              <button
                key={a.key}
                type="button"
                className="de-attn"
                onClick={() => openDetail(a.reservation, a.targetTab)}
                style={{
                  background: "none",
                  border: "none",
                  borderRadius: 6,
                  padding: "3px 6px",
                  margin: "-3px -6px",
                  textAlign: "left",
                  color: "var(--ba-fg)",
                  fontSize: "0.84rem",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  flexWrap: "wrap",
                  width: "100%",
                }}
              >
                <AttentionPill kind={a.kind} />
                {a.unsigned && <AttentionPill kind="unsigned" />}
                <b style={{ fontWeight: 600 }}>{a.name}</b>
                <span style={{ color: "var(--ba-muted)", fontSize: "0.78rem" }}>{a.meta}</span>
                <span
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.right && (
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: "0.8rem",
                        color: a.kind === "money" ? "#fbbf24" : "var(--ba-muted)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {a.right}
                    </span>
                  )}
                  <span aria-hidden style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>
                    ›
                  </span>
                </span>
              </button>
            ))}
            {attention.length > ATTENTION_COLLAPSED && (
              <button
                type="button"
                onClick={() => setAttentionExpanded(!attentionExpanded)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                  color: "#fbbf24",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {attentionExpanded
                  ? "Show less"
                  : `Show all ${attention.length} (${attention.length - ATTENTION_COLLAPSED} more)`}
              </button>
            )}
          </div>
        )}

        {/* ── Body ── */}
        {error && (
          <div
            style={{
              backgroundColor: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              padding: "1rem",
              color: "#f87171",
              fontSize: "0.875rem",
            }}
          >
            {error}
          </div>
        )}
        {board === null && !error && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "3rem 0",
            }}
          >
            <span
              className="de-spin"
              style={{
                width: 28,
                height: 28,
                border: "2px solid transparent",
                borderTopColor: "#60a5fa",
                borderBottomColor: "#60a5fa",
                borderRadius: "50%",
              }}
            />
          </div>
        )}
        {board !== null && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {renderGroups.map((g) =>
              g.kind === "emptyRun" ? (
                <div
                  key={g.days[0].date}
                  style={{
                    backgroundColor: "var(--ba-bg2)",
                    border: "1px solid var(--ba-border)",
                    borderRadius: 8,
                    padding: "9px 16px",
                    display: "flex",
                    alignItems: "baseline",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <b style={{ fontSize: "0.9rem", color: "var(--ba-fg)" }}>
                    {formatDisplayDate(g.days[0].date)} –{" "}
                    {formatDisplayDate(g.days[g.days.length - 1].date)}
                  </b>
                  <span
                    style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--ba-muted)" }}
                  >
                    no group functions
                  </span>
                </div>
              ) : view === "day" && g.day.reservations.length === 0 ? (
                <div
                  key={g.day.date}
                  style={{ textAlign: "center", padding: "3rem 0", color: "var(--ba-muted)" }}
                >
                  No group functions for this date and location.
                </div>
              ) : (
                <DayCard
                  key={g.day.date}
                  label={
                    view === "day" ? fmtDateLabelLong(g.day.date) : formatDisplayDate(g.day.date)
                  }
                  isToday={g.day.date === today}
                  reservations={g.day.reservations}
                  websitePayments={websitePayments}
                  waiverThresholds={waiverThresholds}
                  onOpen={openDetail}
                  onOpenDay={
                    view === "week" ? () => go({ view: "day", date: g.day.date }) : undefined
                  }
                  posChecks={posChecks}
                />
              ),
            )}
          </div>
        )}

        <div style={{ color: "var(--ba-muted)", fontSize: "0.75rem", paddingTop: 18 }}>
          Click any row for the full detail (Overview · Payments · Guest · Notes · Contract).
          {view === "week" && " Click a day band to zoom into that day."}
        </div>
      </div>

      {selectedEventId && (
        <DailyEventModal
          token={token}
          projectId={selectedEventId}
          locationId={locationId}
          initialTab={modalTab}
          onTabChange={setModalTab}
          ids={modalIds}
          onNavigate={(id: string) => {
            setSelectedEventId(id);
            setUrlParams({ event: id });
          }}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
