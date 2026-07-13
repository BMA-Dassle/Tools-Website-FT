"use client";

/**
 * Daily Events board — faithful port of the employee portal's
 * DailyEventsPage list UI (Tools-Team-Member-Portal
 * src/pages/management/operations/DailyEventsPage.tsx), adapted to the
 * website's admin-token pages:
 *
 * - Portal DateContext/LocationContext → in-page date + location pickers
 *   (lazy-init from ?date= / ?location=).
 * - Portal auth/permission gate → the tokened page shell.
 * - Party/labor assignment display + unassign → dropped per owner.
 * - Detail navigation → DailyEventModal with a ?event= deep link
 *   (mirrors the reservations board's ?res= mechanics).
 *
 * State management, effects, and filter/stat derivations are otherwise
 * portal-verbatim via the ~/features/daily-events helpers.
 */
import { useEffect, useMemo, useState } from "react";
import { BOARD_CSS, baThemeCss } from "~/components/features/reservations-admin/theme";
import { fetchDayReservations, getPaymentsBulk } from "~/features/daily-events/api";
import { DEFAULT_WAIVER_THRESHOLDS, LOCATIONS } from "~/features/daily-events/constants";
import { todayET } from "~/features/daily-events/format";
import { useBoardTheme } from "~/features/daily-events/hooks";
import {
  applyStateFilter,
  applyViewTypeFilter,
  dayStats,
  weekRowFilter,
} from "~/features/daily-events/logic";
import type {
  Reservation,
  StateFilter,
  ViewType,
  WebsitePaymentInfo,
  WeekTabKey,
} from "~/features/daily-events/types";
import { buildWeekTabs, getDaysInPeriod } from "~/features/daily-events/week";
import { Spinner } from "./badges";
import DailyEventModal from "./DailyEventModal";
import DayEventsList from "./DayEventsList";
import HeaderBar from "./HeaderBar";
import StatCards from "./StatCards";
import { DE_CSS } from "./theme";
import WeeklySection from "./WeeklySection";

/** Reflect the open event in the URL (?event=) — best-effort, like ?res=. */
function setEventParam(id: string | null) {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("event", id);
    else url.searchParams.delete("event");
    window.history.replaceState(null, "", url.toString());
  } catch {
    /* URL state is best-effort */
  }
}

export default function DailyEventsBoard({ token }: { token: string }) {
  const theme = useBoardTheme();

  // In-page date + location state replaces the portal's DateContext /
  // LocationContext. Lazy init from URL params (SSR-guarded).
  const [date, setDate] = useState<string>(() => {
    if (typeof window === "undefined") return todayET();
    const d = new URLSearchParams(window.location.search).get("date");
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayET();
  });
  const [locationId, setLocationId] = useState<number>(() => {
    if (typeof window === "undefined") return 332160;
    const raw = new URLSearchParams(window.location.search).get("location");
    const n = raw ? parseInt(raw, 10) : NaN;
    return LOCATIONS.some((l) => l.id === n) ? n : 332160;
  });

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [dataSource, setDataSource] = useState("");
  const [dataNote, setDataNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Type toggle: group functions (default) or online reservations
  const [viewType, setViewType] = useState<ViewType>("group");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  // Week navigation state
  const [activeWeekTab, setActiveWeekTab] = useState<WeekTabKey>("current");
  const [weekDataByDay, setWeekDataByDay] = useState<
    { date: string; reservations: Reservation[] }[]
  >([]);
  const [loadingWeek, setLoadingWeek] = useState(true);

  // Waiver thresholds — the portal loaded these from its own settings API;
  // the website has no such endpoint, so the defaults (red 60 / yellow 90,
  // same values as the portal DB row) apply.
  const waiverThresholds = DEFAULT_WAIVER_THRESHOLDS;

  // Website payment status: (number || id) → payment info (PAID/DEPOSIT pills)
  const [websitePayments, setWebsitePayments] = useState<Map<string, WebsitePaymentInfo>>(
    new Map(),
  );

  // Calculate week periods (Last / Current / Next, Wed–Tue)
  const weekTabs = useMemo(() => buildWeekTabs(new Date()), []);
  const activePeriod = weekTabs.find((t) => t.key === activeWeekTab)?.period ?? weekTabs[1].period;

  // Fetch reservations for the selected date (portal effect, minus auth gate)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchDayReservations(token, date, locationId)
      .then((data) => {
        if (!cancelled) {
          setReservations(data.reservations || []);
          setDataSource(data.source || "");
          setDataNote(data.note || "");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load events");
          setReservations([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, date, locationId]);

  // Fetch website payment statuses for the day's reservations
  useEffect(() => {
    if (reservations.length === 0) {
      setWebsitePayments(new Map());
      return;
    }
    getPaymentsBulk(token, reservations)
      .then(setWebsitePayments)
      .catch(() => {});
  }, [token, reservations]);

  // Fetch week reservations when the tab (or location) changes
  useEffect(() => {
    let cancelled = false;
    setLoadingWeek(true);

    const days = getDaysInPeriod(activePeriod.start, activePeriod.end);

    Promise.all(
      days.map((day) =>
        fetchDayReservations(token, day, locationId)
          .then((data) => ({ date: day, reservations: data.reservations || [] }))
          .catch(() => ({ date: day, reservations: [] as Reservation[] })),
      ),
    )
      .then((results) => {
        if (!cancelled) {
          setWeekDataByDay(results);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingWeek(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, activePeriod, locationId]);

  // Fetch website payment statuses for weekly reservations (merged in)
  useEffect(() => {
    const allWeek = weekDataByDay.flatMap((d) => d.reservations);
    if (allWeek.length === 0) return;
    getPaymentsBulk(token, allWeek)
      .then((map) => {
        setWebsitePayments((prev) => {
          const merged = new Map(prev);
          for (const [k, v] of map.entries()) merged.set(k, v);
          return merged;
        });
      })
      .catch(() => {});
  }, [token, weekDataByDay]);

  // Handle view type change — reset state filter to appropriate default
  function handleViewTypeChange(type: ViewType) {
    setViewType(type);
    setStateFilter(type === "group" ? "all" : "confirmed");
  }

  // Filter reservations by view type, then by state
  const typeFiltered = useMemo(
    () => applyViewTypeFilter(reservations, viewType),
    [reservations, viewType],
  );
  const filtered = useMemo(
    () => applyStateFilter(typeFiltered, stateFilter),
    [typeFiltered, stateFilter],
  );
  const stats = useMemo(() => dayStats(filtered), [filtered]);

  // Week data: confirmed / deposit-requested / contract-stage group functions
  const filteredWeek = useMemo(
    () =>
      weekDataByDay
        .map(({ date: d, reservations: dayRes }) => ({
          date: d,
          reservations: dayRes.filter(weekRowFilter),
        }))
        .filter((d) => d.reservations.length > 0),
    [weekDataByDay],
  );

  // Modal state — the open event id + a snapshot of the visible day list
  // (for the modal's prev/next navigation), captured at open time.
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [modalIds, setModalIds] = useState<string[]>([]);

  function openDetail(r: Reservation) {
    if (r._isDayPlannerBlock) return;
    setSelectedEventId(r.id);
    setModalIds(filtered.map((x) => x.id));
    setEventParam(r.id);
  }
  function closeDetail() {
    setSelectedEventId(null);
    setModalIds([]);
    setEventParam(null);
  }

  // ?event= deep link: once the day fetch settles, open the event. One-shot
  // — never re-fires after a manual close. Guarded setState-during-render
  // (mirrors the reservations board's ?res= mechanics) so the open happens
  // in the same commit the data arrives in. If the id isn't in the day list
  // the modal still opens, just without a prev/next snapshot.
  const [pendingEvent, setPendingEvent] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("event");
  });
  if (pendingEvent != null && !loading) {
    const inDayList = filtered.some((x) => x.id === pendingEvent);
    setSelectedEventId(pendingEvent);
    setModalIds(inDayList ? filtered.map((x) => x.id) : []);
    setPendingEvent(null);
  }

  const viewLabel = viewType === "group" ? "Group Functions" : "Online Reservations";

  // Theme palette — CSS variable approach, same as the reservations board.
  const themeStyle = baThemeCss(theme) + BOARD_CSS + DE_CSS;

  return (
    <div
      data-ba-theme={theme}
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--ba-bg)",
        color: "var(--ba-fg)",
        padding: "1rem",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* eslint-disable-next-line react/no-danger -- theme CSS variables */}
      <style dangerouslySetInnerHTML={{ __html: themeStyle }} />

      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <HeaderBar
          date={date}
          onDateChange={setDate}
          locationId={locationId}
          onLocationChange={setLocationId}
          viewType={viewType}
          onViewTypeChange={handleViewTypeChange}
          stateFilter={stateFilter}
          onStateFilterChange={setStateFilter}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* Summary stats */}
          {!loading && !error && filtered.length > 0 && (
            <StatCards stats={stats} viewType={viewType} />
          )}

          {/* Data source note */}
          {dataNote && !loading && (
            <div
              style={{
                backgroundColor: "rgba(234,179,8,0.1)",
                border: "1px solid rgba(234,179,8,0.3)",
                borderRadius: 8,
                padding: "0.5rem 0.75rem",
                color: "#facc15",
                fontSize: "0.75rem",
              }}
            >
              {dataNote}
            </div>
          )}

          {/* Error */}
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

          {/* Loading */}
          {loading && (
            <div style={{ display: "flex", justifyContent: "center", padding: "3rem 0" }}>
              <Spinner size={32} />
            </div>
          )}

          {/* No data */}
          {!loading && !error && filtered.length === 0 && (
            <div style={{ textAlign: "center", padding: "3rem 0", color: "var(--ba-muted)" }}>
              {reservations.length === 0
                ? "No event data available for this date and location."
                : `No ${viewLabel.toLowerCase()} match the current filter.`}
            </div>
          )}

          {/* Today's events */}
          {!loading && filtered.length > 0 && (
            <DayEventsList
              date={date}
              viewType={viewType}
              items={filtered}
              typeFilteredCount={typeFiltered.length}
              dataSource={dataSource}
              websitePayments={websitePayments}
              waiverThresholds={waiverThresholds}
              onOpen={openDetail}
            />
          )}

          {/* Upcoming group functions — week navigation */}
          <div style={{ marginTop: "0.5rem" }}>
            <WeeklySection
              tabs={weekTabs}
              activeTab={activeWeekTab}
              onTabChange={setActiveWeekTab}
              days={filteredWeek}
              loading={loadingWeek}
              websitePayments={websitePayments}
              waiverThresholds={waiverThresholds}
              onOpen={openDetail}
            />
          </div>
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
            setEventParam(id);
          }}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
