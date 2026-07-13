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
import { fetchDayReservations, getPaymentsBulk } from "~/features/daily-events/api";
import { DEFAULT_WAIVER_THRESHOLDS, LOCATIONS } from "~/features/daily-events/constants";
import { fmtDateLabelLong, fmtEventTime, todayET } from "~/features/daily-events/format";
import { useBoardTheme } from "~/features/daily-events/hooks";
import {
  applyViewTypeFilter,
  getWaiverStatus,
  isPendingSignedContract,
  isSendContract,
} from "~/features/daily-events/logic";
import type { Reservation, WebsitePaymentInfo } from "~/features/daily-events/types";
import { formatDisplayDate, getDaysInPeriod, getWeekPeriod } from "~/features/daily-events/week";
import { Spinner } from "../daily-events/badges";
import DailyEventModal from "../daily-events/DailyEventModal";
import { DE_CSS } from "../daily-events/theme";
import DayCard from "./DayCard";
import { BLUE_V2, SANS_V2, V2_SKIN_CSS } from "./theme";

type ViewMode = "day" | "week";

interface DayData {
  date: string;
  reservations: Reservation[];
}

interface AttentionItem {
  key: string;
  reservation: Reservation;
  head: string;
  tail: string;
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
 * Exceptions → sentences, most urgent first: unpaid/unsigned money, quotes
 * stuck before send, red waiver registration. Capped so the strip stays a
 * strip.
 */
function buildAttention(
  days: DayData[],
  payments: Map<string, WebsitePaymentInfo>,
  today: string,
): AttentionItem[] {
  const money: AttentionItem[] = [];
  const contracts: AttentionItem[] = [];
  const waivers: AttentionItem[] = [];

  for (const { date, reservations } of days) {
    for (const r of reservations) {
      if (r._isDayPlannerBlock) continue;
      const when =
        date === today
          ? `today ${fmtEventTime(r.when)}`.trim()
          : formatDisplayDate(date) + (r.when ? ` ${fmtEventTime(r.when)}` : "");
      const contact = r.personName ? ` Contact ${r.personName}.` : "";

      const wp = payments.get(r.number || r.id);
      if (
        wp &&
        !wp.isFullyPaid &&
        wp.depositPaidCents === 0 &&
        !wp.status.includes("cancel") &&
        wp.totalCents > 0
      ) {
        const unsigned = isPendingSignedContract(r.state);
        money.push({
          key: `money-${r.id}`,
          reservation: r,
          head: `${r.name || `#${r.number}`} (${when}) is ${unsigned ? "unsigned and unpaid" : "unpaid"}`,
          tail: ` — ${fmtUsd(wp.totalCents)} open.${contact}`,
        });
      } else if (isSendContract(r.state)) {
        contracts.push({
          key: `send-${r.id}`,
          reservation: r,
          head: `${r.name || `#${r.number}`} (${when}) still needs its contract sent`,
          tail: `.${contact}`,
        });
      }

      const waiver = getWaiverStatus(r, DEFAULT_WAIVER_THRESHOLDS);
      if (waiver?.color === "red") {
        waivers.push({
          key: `waiver-${r.id}`,
          reservation: r,
          head: `${r.name || `#${r.number}`} (${when}) has ${waiver.registered} of ${r.persons} waivers`,
          tail: " — send the waiver reminder.",
        });
      }
    }
  }
  return [...money, ...contracts, ...waivers].slice(0, 6);
}

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
  backgroundColor: BLUE_V2,
  border: `1px solid ${BLUE_V2}`,
  fontWeight: 600,
};

const NAV_LOC_ON: React.CSSProperties = {
  ...NAV_A,
  color: "var(--ba-fg)",
  backgroundColor: "var(--ba-hover)",
  border: "1px solid var(--ba-input-border)",
  fontWeight: 600,
};

export default function DailyEventsBoardV2({ token }: { token: string }) {
  const theme = useBoardTheme();
  const waiverThresholds = DEFAULT_WAIVER_THRESHOLDS;

  // Defaults on first render, URL params applied after mount — unlike v1's
  // lazy window-reading initializers, this hydrates clean (?date= deep links
  // gave v1 a server/client heading mismatch).
  const [date, setDate] = useState<string>(todayET);
  const [view, setView] = useState<ViewMode>("day");
  const [locationId, setLocationId] = useState<number>(332160);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const d = sp.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
    if (sp.get("view") === "week") setView("week");
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

  const [days, setDays] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [websitePayments, setWebsitePayments] = useState<Map<string, WebsitePaymentInfo>>(
    new Map(),
  );

  // Fetch every date in scope (Day = 1 call, Week = 7 parallel — v1's own
  // weekly pattern). Group functions only; v1 keeps the online view.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all(
      scopeDates.map((day) =>
        fetchDayReservations(token, day, locationId)
          .then((data) => ({
            date: day,
            reservations: applyViewTypeFilter(data.reservations || [], "group"),
          }))
          .catch((err: unknown) => {
            if (scopeDates.length === 1) throw err;
            return { date: day, reservations: [] as Reservation[] };
          }),
      ),
    )
      .then((results) => {
        if (!cancelled) setDays(results);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load events");
          setDays([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, locationId, scopeDates]);

  // Payment overlay for everything in scope.
  useEffect(() => {
    const all = days.flatMap((d) => d.reservations);
    if (all.length === 0) {
      setWebsitePayments(new Map());
      return;
    }
    getPaymentsBulk(token, all)
      .then(setWebsitePayments)
      .catch(() => {});
  }, [token, days]);

  const attention = useMemo(
    () => buildAttention(days, websitePayments, today),
    [days, websitePayments, today],
  );

  const totals = useMemo(() => {
    const all = days.flatMap((d) => d.reservations);
    return {
      events: all.length,
      persons: all.reduce((s, r) => s + (r.persons || 0), 0),
    };
  }, [days]);

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

  // ── Detail modal (v1 mechanics, ?event= deep link) ──
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [modalIds, setModalIds] = useState<string[]>([]);
  const visibleIds = useMemo(
    () => days.flatMap((d) => d.reservations.filter((r) => !r._isDayPlannerBlock).map((r) => r.id)),
    [days],
  );

  function openDetail(r: Reservation) {
    if (r._isDayPlannerBlock) return;
    setSelectedEventId(r.id);
    setModalIds(visibleIds);
    setUrlParams({ event: r.id });
  }
  function closeDetail() {
    setSelectedEventId(null);
    setModalIds([]);
    setUrlParams({ event: null });
  }

  const [pendingEvent, setPendingEvent] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("event");
  });
  if (pendingEvent != null && !loading) {
    setSelectedEventId(pendingEvent);
    setModalIds(visibleIds.includes(pendingEvent) ? visibleIds : []);
    setPendingEvent(null);
  }

  const themeStyle = baThemeCss(theme) + BOARD_CSS + DE_CSS + V2_SKIN_CSS;

  return (
    <div
      data-ba-theme={theme}
      className="v2-skin"
      style={{
        minHeight: "100vh",
        color: "var(--ba-fg)",
        padding: "1rem",
        fontFamily: SANS_V2,
      }}
    >
      {/* eslint-disable-next-line react/no-danger -- theme CSS variables */}
      <style dangerouslySetInnerHTML={{ __html: themeStyle }} />

      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {/* ── Top line ── */}
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
          {!loading && (
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
            <span style={{ width: 8 }} />
            <a href={`/admin/${token}/daily-events`} style={{ ...NAV_A, textDecoration: "none" }}>
              v1 board
            </a>
          </span>
        </div>

        {/* ── Needs attention — the portal's amber note-box idiom ── */}
        {!loading && attention.length > 0 && (
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
              }}
            >
              Needs attention · {attention.length}
            </span>
            {attention.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => openDetail(a.reservation)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                  color: "var(--ba-fg)",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <b style={{ fontWeight: 600 }}>{a.head}</b>
                <span style={{ color: "var(--ba-muted)" }}>{a.tail}</span>
              </button>
            ))}
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
        {loading && (
          <div style={{ display: "flex", justifyContent: "center", padding: "3rem 0" }}>
            <Spinner size={32} />
          </div>
        )}
        {!loading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {days.map((d) =>
              view === "day" && d.reservations.length === 0 ? (
                <div
                  key={d.date}
                  style={{ textAlign: "center", padding: "3rem 0", color: "var(--ba-muted)" }}
                >
                  No group functions for this date and location.
                </div>
              ) : (
                <DayCard
                  key={d.date}
                  label={view === "day" ? fmtDateLabelLong(d.date) : formatDisplayDate(d.date)}
                  isToday={d.date === today}
                  reservations={d.reservations}
                  websitePayments={websitePayments}
                  waiverThresholds={waiverThresholds}
                  onOpen={openDetail}
                  onOpenDay={view === "week" ? () => go({ view: "day", date: d.date }) : undefined}
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
