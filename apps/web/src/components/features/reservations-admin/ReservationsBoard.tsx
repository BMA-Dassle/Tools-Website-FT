"use client";

/**
 * Admin reservations board — the portal-embedded ops view of a day's
 * bookings (bowling, KBF, race, attraction, VIP combos, group events).
 *
 * This is the top-level client component composed from the
 * reservations-admin feature module; it replaced the monolithic
 * app/admin/[token]/reservations/ReservationsClient.tsx. All memo/filter
 * logic is verbatim from that file (the combo math lives in
 * ~/features/reservations-admin/combo-board.ts with unit tests).
 */
import { useEffect, useMemo, useState } from "react";
import {
  buildComboGroups,
  buildComboScheduleIndex,
  mergeComboRows,
} from "~/features/reservations-admin/combo-board";
import type { ComboMergeInfo, GroupEvent } from "~/features/reservations-admin/types";
import { CENTER_SLUGS } from "~/features/reservations-admin/constants";
import { fetchDayReservations } from "~/features/daily-events/api";
import { ADMIN_SANS, PORTAL_SKIN_CSS } from "~/components/features/admin-skin/theme";
import { usePortalAutoHeight } from "~/components/features/admin-skin/usePortalAutoHeight";
import DailyEventModal from "../daily-events/DailyEventModal";
import { nowEtWallMs, todayET } from "~/features/reservations-admin/format";
import {
  useBoardTheme,
  useNowTick,
  useReservationsData,
} from "~/features/reservations-admin/hooks";
import type { Reservation } from "~/features/reservations-admin/types";
import BoardCardList from "./BoardCardList";
import BoardTable from "./BoardTable";
import FilterBar from "./FilterBar";
import GroupEventsSection from "./GroupEventsSection";
import VipComboCards from "./VipComboCards";
import BowlingResendModal from "./modals/BowlingResendModal";
import CancelModal from "./modals/CancelModal";
import CheckInModal from "./modals/CheckInModal";
import ComboScheduleModal, { type ScheduleTarget } from "./modals/ComboScheduleModal";
import ComboTimeShiftModal from "./modals/ComboTimeShiftModal";
import ContactModal, { type ContactTarget } from "./modals/ContactModal";
import RescheduleModal from "./modals/RescheduleModal";
import SquareOrderModal, { type OrderTarget } from "./modals/SquareOrderModal";
import ManageReservationModal from "./manage/ManageReservationModal";
import { BOARD_CSS, baThemeCss } from "./theme";

/**
 * True for a self-service KIOSK booking made through our booking flow
 * (bookingSource "kiosk", stamped by unified-reserve / bowling service).
 *
 * NAMING COLLISION: the qamf-bowling webhook ALSO tags lane-side walk-ins
 * with bookingSource "kiosk" when the QAMF id starts with "K" (counter
 * kiosk walk-ins). Those are genuine walk-ins, not our booking-flow kiosk,
 * so we exclude any row whose QAMF reservation id is K-prefixed. This keeps
 * our kiosk bookings surfaced (they carry no K-prefixed QAMF id) while
 * QAMF-K walk-ins stay hidden by the "Web Only" filter like other walk-ins.
 */
function isBookingFlowKiosk(r: Reservation): boolean {
  return (
    r.bookingSource === "kiosk" &&
    !(r.qamfReservationId && r.qamfReservationId.toUpperCase().startsWith("K"))
  );
}

export default function ReservationsBoard({
  token,
  embedded,
}: {
  token: string;
  /** Portal iframe mode — posts content height so the iframe auto-sizes. */
  embedded?: boolean;
}) {
  const theme = useBoardTheme();

  const [date, setDate] = useState(todayET);
  // Read ?center= slug from URL on mount (e.g. ?center=fm or ?center=naples)
  const [center] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const p = new URLSearchParams(window.location.search);
    const slug = p.get("center")?.toLowerCase() || "";
    return CENTER_SLUGS[slug] || "";
  });
  const [search, setSearch] = useState("");
  const [hideCancelled, setHideCancelled] = useState(true);
  const [hideWalkins, setHideWalkins] = useState(true);
  // Isolate self-service kiosk bookings (owner ask). Orthogonal to kind/source.
  const [kioskOnly, setKioskOnly] = useState(false);
  // ?view=vip deep link (Teams movement cards) opens straight to the ★VIP filter.
  const [kindFilter, setKindFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("view") === "vip" ? "vip" : null;
  });

  const { reservations, groupEvents, vipReservations, comboMeta, loading, error, reload } =
    useReservationsData(token, date, center);

  // Countdown heartbeat — keeps the VIP pills moving between data polls.
  useNowTick(30_000);

  const [resendTarget, setResendTarget] = useState<Reservation | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Reservation | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<Reservation | null>(null);
  // Ultimate VIP combo ±1h bowling time shift (VIP card button).
  const [comboShiftTarget, setComboShiftTarget] = useState<Reservation | null>(null);
  const [checkinTarget, setCheckinTarget] = useState<Reservation | null>(null);
  // Contact details (phone/email) shown on clicking the guest name — keeps them
  // out of the row so the row stays single-line.
  const [contactTarget, setContactTarget] = useState<ContactTarget | null>(null);
  const [orderTarget, setOrderTarget] = useState<OrderTarget | null>(null);
  // Combo schedule popover (also reachable from a VIP row in the main list).
  const [scheduleTarget, setScheduleTarget] = useState<ScheduleTarget | null>(null);
  // Manage Reservation modal — opened by clicking any row/card. Holds a
  // snapshot; the render below re-resolves the freshest row by id so the
  // 10s poll keeps the header pills live without clobbering modal state.
  const [manageTarget, setManageTarget] = useState<
    (Reservation & { comboMerge?: ComboMergeInfo }) | null
  >(null);
  const [toast, setToast] = useState<string | null>(null);

  // Daily-events detail modal (Overview·Schedule·Payments·Guest·Notes·Contract)
  // for group-function rows. Quotes don't store the BMI projectId, so resolve
  // it from that day's daily-events board by event number, trying the center's
  // BMI locations in order (FM group events can live on HP FM or FastTrax).
  const [dailyEvent, setDailyEvent] = useState<{ projectId: string; locationId: number } | null>(
    null,
  );
  const [resolvingEventId, setResolvingEventId] = useState<number | null>(null);

  async function openEventDetail(ge: GroupEvent) {
    if (resolvingEventId != null) return;
    setResolvingEventId(ge.id);
    try {
      const candidates =
        ge.centerCode === "PPTR5G2N0QXF7"
          ? [332145]
          : ge.centerCode === "LAB52GY480CJF"
            ? [467486, 332160]
            : [332160, 467486];
      const wanted = ge.eventNumber.replace(/^#/, "").toLowerCase();
      // BMI's business day runs 6 AM → 6 AM: a midnight–6 AM event dated
      // Jul 15 lives on BMI's Jul 14 board (3420, 2026-07-14) — so try the
      // board date, then the previous day.
      const prevDay = new Date(`${date}T12:00:00Z`);
      prevDay.setUTCDate(prevDay.getUTCDate() - 1);
      const dates = [date, prevDay.toISOString().slice(0, 10)];
      for (const day of dates) {
        for (const locationId of candidates) {
          const data = await fetchDayReservations(token, day, locationId);
          const match = (data.reservations || []).find(
            (r) => (r.number || "").replace(/^#/, "").toLowerCase() === wanted,
          );
          if (match) {
            setDailyEvent({ projectId: match.id, locationId });
            return;
          }
        }
      }
      showToast(`Couldn't find event #${ge.eventNumber} on the daily-events board`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to open event detail");
    } finally {
      setResolvingEventId(null);
    }
  }

  // Client-side search + cancelled filter + kind filter
  const filtered = useMemo(() => {
    let list = reservations;
    if (hideWalkins) {
      // "Web Only" hides QAMF-side entries (conqueror, admin) and lane-side
      // walk-ins — but NOT our self-service kiosk bookings. Those are real
      // guest bookings made through the booking flow (bookingSource "kiosk")
      // and belong alongside web bookings, clearly badged. See
      // isBookingFlowKiosk for the walk-in collision it guards against.
      list = list.filter(
        (r) => !r.bookingSource || r.bookingSource === "web" || isBookingFlowKiosk(r),
      );
    }
    if (hideCancelled) {
      // "Active Only": drop cancelled + completed. Also drop `arrived` RACING
      // rows — QAMF gives bowling a real `completed` status (so arrived bowlers
      // stay visible until they truly finish), but races never get one, so an
      // arrived race is effectively done. Past-event no-shows are flipped to a
      // terminal status by the reservation-status-close cron (not filtered here).
      // VIP combo legs are exempt from the status drops (cancelled aside):
      // staff flip a leg to completed at check-in/settle while later itinerary
      // steps are still hours away, so retiring a combo is a GROUP decision —
      // displayRows drops the merged row 30 min after its last scheduled step.
      list = list.filter((r) => {
        if (r.comboSpecialId) return r.status !== "cancelled";
        return (
          r.status !== "cancelled" &&
          r.status !== "completed" &&
          r.status !== "no_show" &&
          !(r.status === "arrived" && r.productKind === "race")
        );
      });
    }
    if (kindFilter && kindFilter !== "vip") {
      list = list.filter((r) => r.productKind === kindFilter);
    }
    if (kioskOnly) {
      // Show ONLY self-service kiosk bookings (excludes QAMF-"K" walk-ins).
      list = list.filter(isBookingFlowKiosk);
    }
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((r) => {
        const fields = [
          r.guestName,
          r.guestEmail,
          r.guestPhone,
          r.qamfReservationId,
          r.notes,
          r.dayofOrderLane,
          String(r.id),
        ];
        return fields.some((f) => f?.toLowerCase().includes(q));
      });
    }
    return list;
  }, [reservations, search, hideCancelled, hideWalkins, kindFilter, kioskOnly]);

  // VIP combos grouped with live schedules. Recomputes when the 10s poll
  // lands fresh arrays; nowEtWallMs() is read at that moment (retirement
  // advances with the poll, the render-time pills use their own nowMs below).
  const comboGroups = useMemo(
    () => buildComboGroups(vipReservations, comboMeta, nowEtWallMs()),
    [vipReservations, comboMeta],
  );

  // VIP cards honor the Active Only toggle + search. The schedule lookup
  // below (comboScheduleByKey) deliberately uses ALL groups, so main-list
  // retirement + itinerary still resolve for combos hidden from the cards.
  const visibleComboGroups = useMemo(() => {
    let out = comboGroups;
    if (hideCancelled) out = out.filter((g) => !g.inactive);
    if (search.trim()) {
      const query = search.toLowerCase().trim();
      out = out.filter((g) =>
        g.legs.some((l) =>
          [l.guestName, l.guestEmail, l.guestPhone, l.qamfReservationId, l.dayofOrderLane].some(
            (f) => f?.toLowerCase().includes(query),
          ),
        ),
      );
    }
    return out;
  }, [comboGroups, hideCancelled, search]);

  const comboScheduleByKey = useMemo(() => buildComboScheduleIndex(comboGroups), [comboGroups]);
  const comboScheduleFor = (r: Reservation) =>
    comboScheduleByKey.get(r.squareDepositOrderId ?? "") ??
    comboScheduleByKey.get(r.squareDayofOrderId ?? "");

  const vipActive = kindFilter === "vip";

  // Group events respect the "Active Only" toggle just like reservations do:
  // hide completed events (cancelled/denied are already excluded server-side).
  const visibleGroupEvents = useMemo(
    () => (hideCancelled ? groupEvents.filter((g) => g.status !== "completed") : groupEvents),
    [groupEvents, hideCancelled],
  );

  const displayRows = useMemo(
    () => mergeComboRows(filtered, hideCancelled, comboScheduleByKey),
    [filtered, hideCancelled, comboScheduleByKey],
  );

  // Stats
  const active = displayRows.filter((r) => r.status !== "cancelled" && r.status !== "completed");
  const totalCancelledAll = reservations.filter((r) => r.status === "cancelled").length;
  const totalCompletedAll = reservations.filter((r) => r.status === "completed").length;
  // Walk-in count = QAMF-side entries the "Web Only" filter hides. Excludes
  // our booking-flow kiosk rows, which are now shown alongside web (so they
  // are not "hidden walk-ins").
  const totalWalkins = reservations.filter(
    (r) => r.bookingSource && r.bookingSource !== "web" && !isBookingFlowKiosk(r),
  ).length;
  const totalKiosk = reservations.filter(isBookingFlowKiosk).length;
  const totalHidden = totalCancelledAll + totalCompletedAll;
  // Combo rows carry the COMBINED total across their two day-of orders (and are
  // 100% prepaid, so deposit == total); use it so revenue isn't under/double-counted.
  const totalDeposit = active.reduce((s, r) => s + (r.comboMerge?.totalCents ?? r.depositCents), 0);
  const totalRevenue = active.reduce((s, r) => s + (r.comboMerge?.totalCents ?? r.totalCents), 0);
  const totalPlayers = active.reduce((s, r) => s + (r.playerCount ?? 0), 0);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  // Open the manage modal + reflect it in the URL (?res=) so a refresh
  // inside the portal iframe reopens the same reservation.
  function openManage(r: Reservation & { comboMerge?: ComboMergeInfo }) {
    setManageTarget(r);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("res", String(r.id));
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* URL state is best-effort */
    }
  }
  function closeManage() {
    setManageTarget(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("res");
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* URL state is best-effort */
    }
  }

  // ?res= deep link: once data lands, open the reservation if it's on the
  // board (today's date). One-shot — never re-fires after a manual close.
  // Guarded setState-during-render (React's adjust-state-on-change pattern)
  // instead of an effect, so the open happens in the same commit the data
  // arrives in.
  const [pendingRes, setPendingRes] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("res");
    const id = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(id) && id > 0 ? id : null;
  });
  if (pendingRes != null && !loading) {
    const hit =
      displayRows.find((x) => x.id === pendingRes) ??
      reservations.find((x) => x.id === pendingRes) ??
      vipReservations.find((x) => x.id === pendingRes);
    if (hit) setManageTarget(hit);
    setPendingRes(null);
  }

  // Freshest copy of the open reservation — the 10s poll updates status
  // pills in the modal header; if the row leaves the list (date nav), the
  // snapshot keeps the modal alive rather than force-closing mid-action.
  const manageRow = manageTarget
    ? (displayRows.find((x) => x.id === manageTarget.id) ??
      reservations.find((x) => x.id === manageTarget.id) ??
      manageTarget)
    : null;

  // Theme palette — CSS variable approach avoids touching 137 inline styles.
  // The <style> block sets variables on [data-theme], and key surface colors
  // reference them. Accent colors (status badges, pills) stay hardcoded
  // since they work on both backgrounds. PORTAL_SKIN_CSS re-tokens both
  // themes to the employee portal's palette (navy gradient / white).
  const themeStyle = baThemeCss(theme) + BOARD_CSS + PORTAL_SKIN_CSS;

  const anyModalOpen = Boolean(
    resendTarget ||
    cancelTarget ||
    rescheduleTarget ||
    comboShiftTarget ||
    checkinTarget ||
    contactTarget ||
    orderTarget ||
    scheduleTarget ||
    manageRow ||
    dailyEvent,
  );
  usePortalAutoHeight("bowling-resize", !!embedded, anyModalOpen);

  // Same modal contract as the daily-events embed: the portal locks its
  // page scroll, sizes the iframe to the visible viewport, and ignores
  // resize messages while any modal is open.
  useEffect(() => {
    if (!embedded || typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage({ type: "bowling-modal", open: anyModalOpen }, "*");
  }, [embedded, anyModalOpen]);

  return (
    <div
      data-ba-theme={theme}
      className="portal-skin"
      style={{
        minHeight: embedded ? undefined : "100vh",
        color: "var(--ba-fg)",
        fontFamily: ADMIN_SANS,
        padding: "1rem",
      }}
    >
      {/* eslint-disable-next-line react/no-danger -- theme CSS variables */}
      <style dangerouslySetInnerHTML={{ __html: themeStyle }} />
      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 60,
            padding: "0.75rem 1.25rem",
            borderRadius: 10,
            backgroundColor: "rgba(34,197,94,0.9)",
            color: "#fff",
            fontWeight: 600,
            fontSize: "0.85rem",
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
          }}
        >
          {toast}
        </div>
      )}

      {/* Resend modal */}
      {resendTarget && (
        <BowlingResendModal
          reservation={resendTarget}
          token={token}
          onClose={() => setResendTarget(null)}
          onSent={(msg) => showToast(`${resendTarget.guestName || "Guest"}: ${msg}`)}
        />
      )}

      {/* Cancel modal */}
      {cancelTarget && (
        <CancelModal
          reservation={cancelTarget}
          token={token}
          onClose={() => setCancelTarget(null)}
          onDone={(msg) => {
            showToast(msg);
            void reload();
          }}
        />
      )}

      {/* Ultimate VIP bowling time-shift modal */}
      {comboShiftTarget && (
        <ComboTimeShiftModal
          reservation={comboShiftTarget}
          token={token}
          onClose={() => setComboShiftTarget(null)}
          onDone={(msg) => {
            showToast(`${comboShiftTarget.guestName || "Guest"}: ${msg}`);
            void reload();
          }}
        />
      )}

      {/* Reschedule modal */}
      {rescheduleTarget && (
        <RescheduleModal
          reservation={rescheduleTarget}
          token={token}
          onClose={() => setRescheduleTarget(null)}
          onRescheduled={(msg) => {
            showToast(`${rescheduleTarget.guestName || "Guest"}: ${msg}`);
            void reload();
          }}
        />
      )}

      {/* Check-in modal */}
      {checkinTarget && (
        <CheckInModal
          reservation={checkinTarget}
          token={token}
          onClose={() => setCheckinTarget(null)}
          onCheckedIn={(msg) => {
            showToast(`${checkinTarget.guestName || "Guest"}: ${msg}`);
            void reload();
          }}
        />
      )}

      {/* Guest contact (phone / email) — opened from the name */}
      {contactTarget && (
        <ContactModal target={contactTarget} onClose={() => setContactTarget(null)} />
      )}

      {/* VIP combo schedule (itinerary) modal */}
      {scheduleTarget && (
        <ComboScheduleModal target={scheduleTarget} onClose={() => setScheduleTarget(null)} />
      )}

      {/* Square order details modal */}
      {orderTarget && (
        <SquareOrderModal target={orderTarget} token={token} onClose={() => setOrderTarget(null)} />
      )}

      {/* Daily-events detail modal — full group-function drill-down
          (Overview · Schedule · Payments · Guest · Notes · Contract). */}
      {dailyEvent && (
        <DailyEventModal
          token={token}
          projectId={dailyEvent.projectId}
          locationId={dailyEvent.locationId}
          ids={[dailyEvent.projectId]}
          onNavigate={() => {}}
          onClose={() => setDailyEvent(null)}
        />
      )}

      {/* Manage Reservation modal — full-page, opened from any row/card.
          key remounts it per reservation so its fetched detail never leaks
          between bookings. */}
      {manageRow && (
        <ManageReservationModal
          key={manageRow.id}
          reservation={manageRow}
          token={token}
          onClose={closeManage}
          onMutated={() => void reload({ silent: true })}
          onToast={showToast}
        />
      )}

      {/* Filters */}
      <FilterBar
        reservations={reservations}
        vipReservations={vipReservations}
        hideCancelled={hideCancelled}
        setHideCancelled={setHideCancelled}
        hideWalkins={hideWalkins}
        setHideWalkins={setHideWalkins}
        kioskOnly={kioskOnly}
        setKioskOnly={setKioskOnly}
        kioskCount={totalKiosk}
        kindFilter={kindFilter}
        setKindFilter={setKindFilter}
        date={date}
        setDate={setDate}
        search={search}
        setSearch={setSearch}
        loading={loading}
        filteredCount={filtered.length}
        stats={{
          activeCount: active.length,
          totalHidden,
          totalCancelledAll,
          totalCompletedAll,
          totalWalkins,
          totalPlayers,
          totalDeposit,
          totalRevenue,
        }}
      />

      {/* Content */}
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--ba-muted)" }}>
            Loading...
          </div>
        ) : error ? (
          <div
            style={{
              textAlign: "center",
              padding: "2rem",
              color: "#ef4444",
              backgroundColor: "rgba(239,68,68,0.1)",
              borderRadius: 12,
              border: "1px solid rgba(239,68,68,0.3)",
            }}
          >
            {error}
          </div>
        ) : vipActive ? (
          visibleComboGroups.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "var(--ba-muted)" }}>
              {search ? "No matching VIP combos." : "No VIP combos for this date."}
            </div>
          ) : (
            <VipComboCards
              groups={visibleComboGroups}
              // Recomputed on every render — the 10s silent auto-refresh and
              // the 30s heartbeat keep the "left"/"in" countdowns current.
              nowMs={nowEtWallMs()}
              onCancelLeg={setCancelTarget}
              onViewOrder={setOrderTarget}
              onOpenReservation={openManage}
              onChangeBowlingTime={setComboShiftTarget}
            />
          )
        ) : displayRows.length === 0 && visibleGroupEvents.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--ba-muted)" }}>
            {search ? "No matching reservations." : "No reservations for this date."}
          </div>
        ) : (
          <>
            <GroupEventsSection
              events={visibleGroupEvents}
              onViewOrder={setOrderTarget}
              onViewEvent={openEventDetail}
              resolvingEventId={resolvingEventId}
            />
            <BoardCardList
              rows={displayRows}
              comboScheduleFor={comboScheduleFor}
              actionMode="checkin-only"
              onCheckIn={setCheckinTarget}
              onReschedule={setRescheduleTarget}
              onResend={setResendTarget}
              onCancel={setCancelTarget}
              onViewOrder={setOrderTarget}
              onViewSchedule={setScheduleTarget}
              onOpenReservation={openManage}
            />
            <BoardTable
              rows={displayRows}
              comboScheduleFor={comboScheduleFor}
              actionMode="checkin-only"
              onCheckIn={setCheckinTarget}
              onReschedule={setRescheduleTarget}
              onResend={setResendTarget}
              onCancel={setCancelTarget}
              onViewSchedule={setScheduleTarget}
              onOpenContact={setContactTarget}
              onOpenReservation={openManage}
            />
          </>
        )}
      </div>
    </div>
  );
}
