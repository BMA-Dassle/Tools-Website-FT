"use client";

/**
 * Kiosk Race Sims time step — the racing HEAT PICKER on a sim item (owner
 * 2026-08-26: "follow racing as close as possible", keep the Track step AND
 * let guests change track on the heat-pick screen, and — like karting across
 * tracks — picks ACCUMULATE: "if I select 10 on Track A … 10:15 would be open").
 *
 * Layout mirrors RaceHeatPickerStep's kiosk render at canvas px: centered
 * heading + "product · track · date" line, racing's TrackInfoBanner track
 * cards (Track A/B/C) above the grid, "Booking for N racers" summary, ONE
 * flat earliest-first grid of time cards (big time → block name → tri-color
 * status line → capacity bar), racing's selected / idle / disabled states,
 * tap-to-unpick, per-card "Holding…" overlay, hold-error card, loading /
 * error+Retry / empty shells, semi-live 30s refetch.
 *
 * Track cards FILTER the grid exactly like racing's: switching track keeps
 * every pick (item.sessions — racing's heats[]) and shows that track's key's
 * sessions; a pick on any track adds a session and eager-holds ONE $0
 * track-key line for the whole party; tapping a picked card releases it.
 *
 * Scheduling rules — race-sims/scheduling.ts, shared with the reserve guard
 * so grid and server agree: sim-vs-sim = the SAME time slot on another track
 * is the same rigs (greyed "Picked on Track A"), back-to-back is allowed;
 * sim-vs-kart heat / attraction / bowling = racing's 30-min cross-activity
 * spacing, against the whole cart AND the party's other reservations today
 * (booked-heats); group events (full-day private event blocks the screen,
 * morning buyout greys before the public reopen, event windows grey
 * overlapping sessions); capacity vs party; a 10-min lead. canAdvance
 * re-runs the checks on every picked session, racing's canAdvanceFor.
 *
 * Racing books per (heat × racer) line with racers stamped at the pick; a
 * sim session is ONE $0 line for the whole party, so the tap stamps the
 * roster (racerCount/assignedTo from session.party) and holds with that
 * quantity (heldQty). A party change after the hold re-holds each session at
 * the new quantity; reserve guard 2e refuses a stale hold.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RaceSimItem, RaceSimSession, StepDef } from "~/features/booking";
import { bmiAdapter, type BmiBlock, type BmiProposal } from "~/features/booking/data/bmi";
import { releaseRaceSimSessionLines } from "~/features/booking/service/checkout";
import {
  RACE_SIM_TRACKS,
  getRaceSimProduct,
  raceSimBookingTarget,
  type RaceSimTrackKey,
} from "~/features/race-sims/products";
import { bookRaceSimSession } from "~/features/race-sims/service";
import {
  cartTimedBookings,
  findRaceSimSelfConflict,
  ownPickAtSameStart,
  raceSimPrivateEventTitle,
  raceSimSlotBeforeReopen,
  raceSimSlotConflicts,
  raceSimSlotEventReserved,
  wallClockMs,
  type TimedBooking,
} from "~/features/race-sims/scheduling";
import { slotLabel, todayYmd } from "../service/first-available";
import { PRODUCT_NAME_KEYS } from "./KioskRaceSimProductStep";
import { useLocale } from "../i18n";
import type { MessageKey } from "../i18n";

/** Racing's kiosk lead for returning racers (RaceHeatPickerStep
 *  KIOSK_RETURNING_LEAD_MINUTES) — sims have no briefing, so the shorter one. */
const LEAD_MS = 10 * 60_000;
/** RACE_AVAILABILITY_POLL_MS parity — the grid stays semi-live. */
const POLL_MS = 30_000;

const TRACK_NAME_KEYS: Record<RaceSimTrackKey, MessageKey> = {
  a: "racesim.track.a",
  b: "racesim.track.b",
  c: "racesim.track.c",
};
/** Racing's track palette (TRACK_CARD / TRACK_TINT): Red, Blue, Mega purple. */
const TRACK_TINT: Record<RaceSimTrackKey, { tint: string; title: string }> = {
  a: { tint: "#e53935", title: "#fca5a5" },
  b: { tint: "#4fa9ff", title: "#93c5fd" },
  c: { tint: "#8652ff", title: "#d8b4fe" },
};

type SlotEntry = { block: BmiBlock; proposal: BmiProposal };

const sameSession = (s: RaceSimSession, trackKey: string | null, slot: string) =>
  s.trackKey === trackKey && s.slot === slot;

const KioskRaceSimSlotStepComponent: StepDef<RaceSimItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const { t, locale } = useLocale();
  const target = raceSimBookingTarget(item.trackKey);
  // Racing: the whole party races — quantity comes from the roster, and the
  // tap stamps it onto the item (racing stamps racers at the heat pick).
  const partyIds = session.party.map((m) => m.id);
  const qty = Math.max(1, partyIds.length);
  const personIds = [
    ...new Set(session.party.map((m) => m.bmiPersonId).filter((id): id is string => !!id)),
  ].sort();

  const [slots, setSlots] = useState<SlotEntry[]>([]);
  const [scanState, setScanState] = useState<"loading" | "done" | "error">("loading");
  const [refreshTick, setRefreshTick] = useState(0);
  const [holding, setHolding] = useState<string | null>(null); // block.start being held/released
  const [holdError, setHoldError] = useState<string | null>(null);
  // The party's karting heats + sim sessions in OTHER reservations today
  // (racing's booked-heats signal, matched by bmiPersonId), with their track
  // so the rule can tell a sim row from a kart heat. Fail-open.
  const [existing, setExisting] = useState<TimedBooking[]>([]);
  const lastTargetRef = useRef<string | null>(null);

  // Kiosk = walk-up: the date is always today.
  const today = todayYmd();
  // The date the grid shows: item.date when it is today or later (the test
  // kiosk may have rolled it forward), otherwise today.
  const gridDate = item.date && item.date >= today ? item.date : today;
  useEffect(() => {
    if (!item.date || item.date < today) onChange({ date: today, sessions: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.date, today]);

  // Fetch the shown track's key's sessions; refetch every 30s.
  useEffect(() => {
    if (!target || !item.date) {
      setScanState("done");
      setSlots([]);
      return;
    }
    let cancelled = false;
    // Show the spinner on first load and on a track switch (new key), never
    // on the silent 30s poll.
    if (refreshTick === 0 || lastTargetRef.current !== target.productId) setScanState("loading");
    lastTargetRef.current = target.productId;
    bmiAdapter
      .getAvailability({
        date: gridDate,
        productId: target.productId,
        pageId: target.pageId,
        quantity: qty,
      })
      .then((res) => {
        if (cancelled) return;
        const byStart = new Map<string, SlotEntry>();
        for (const proposal of res.proposals) {
          const block = proposal.blocks[0]?.block;
          if (block && !byStart.has(block.start)) byStart.set(block.start, { block, proposal });
        }
        setSlots(
          Array.from(byStart.values()).sort(
            (a, b) => wallClockMs(a.block.start) - wallClockMs(b.block.start),
          ),
        );
        setScanState("done");
      })
      .catch(() => {
        if (!cancelled) setScanState("error");
      });
    const timer = setInterval(() => setRefreshTick((n) => n + 1), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // target is derived from trackKey; its two ids are the stable deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.productId, target?.pageId, item.date, gridDate, qty, today, refreshTick]);

  // Existing-reservation conflicts — the same endpoint racing's grid polls
  // (/api/booking/v2/booked-heats: karting heats + prior sim sessions),
  // excluding this session's own bill.
  const personKey = personIds.join(",");
  useEffect(() => {
    if (!personKey) {
      setExisting([]);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ date: gridDate, personIds: personKey });
    if (session.bmiBillId) params.set("excludeBillId", session.bmiBillId);
    fetch(`/api/booking/v2/booked-heats?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) return { heats: [] as Array<{ heatId: string; track: string | null }> };
        return (await res.json()) as { heats: Array<{ heatId: string; track: string | null }> };
      })
      .then((data) => {
        if (cancelled) return;
        setExisting(
          data.heats.map((h) => ({ startMs: wallClockMs(h.heatId), track: h.track ?? null })),
        );
      })
      .catch(() => {
        if (!cancelled) setExisting([]);
      });
    return () => {
      cancelled = true;
    };
  }, [personKey, gridDate, session.bmiBillId, refreshTick]);

  // Other cart activities — racing's cart-conflict gating, via the shared rule.
  const cartOthers = cartTimedBookings(session.items, item.id);

  /** Tap a picked card: release its $0 line and drop the session (racing's
   *  deselect). Other picks stay. */
  const unpickSession = useCallback(
    async (sess: RaceSimSession) => {
      if (holding) return;
      setHolding(sess.slot);
      setHoldError(null);
      setBusy?.(true);
      try {
        if (sess.bmiLineId) await releaseRaceSimSessionLines(session, [sess]);
      } finally {
        onChange({
          sessions: item.sessions.filter((s) => !sameSession(s, sess.trackKey, sess.slot)),
        });
        setHolding(null);
        setBusy?.(false);
      }
    },
    [holding, item.sessions, session, onChange, setBusy],
  );

  /** Tap an open card: ADD a session on the shown track and hold it. */
  const bookSlot = useCallback(
    async (entry: SlotEntry) => {
      const trackKey = item.trackKey;
      if (holding || !trackKey) return;
      const start = entry.block.start;
      setHolding(start);
      setHoldError(null);
      setBusy?.(true);
      const added: RaceSimSession = {
        trackKey,
        slot: start,
        slotProposal: entry.proposal,
        bmiLineId: null,
        heldQty: null,
      };
      const next = [...item.sessions.filter((s) => !sameSession(s, trackKey, start)), added];
      const stamped = { sessions: next, racerCount: qty, assignedTo: partyIds };
      try {
        onChange(stamped);
        await bookRaceSimSession(session, { ...item, ...stamped }, added, dispatch);
      } catch (err) {
        onChange({ sessions: next.filter((s) => !sameSession(s, trackKey, start)) });
        // err.message is a raw vendor/technical detail — appended untranslated.
        setHoldError(
          err instanceof Error
            ? `${t("slot.hold.filled")} (${err.message})`
            : t("slot.hold.filled"),
        );
      } finally {
        setHolding(null);
        setBusy?.(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- partyIds is rebuilt per render from session.party
    [holding, item, session, onChange, dispatch, setBusy, qty, t],
  );

  /** Track cards filter the grid (racing's TrackInfoBanner): every pick stays. */
  const switchTrack = useCallback(
    (key: RaceSimTrackKey) => {
      if (holding || key === item.trackKey) return;
      setHoldError(null);
      onChange({ trackKey: key });
    },
    [holding, item.trackKey, onChange],
  );

  // Party changed after a hold: BMI holds heldQty seats, the roster says qty —
  // re-hold that session at the new quantity, one at a time (racing's
  // per-racer lines re-stamp for free; a sim line must re-hold).
  const stale = item.sessions.find((s) => s.bmiLineId && s.heldQty != null && s.heldQty !== qty);
  useEffect(() => {
    if (!stale || holding) return;
    let cancelled = false;
    (async () => {
      setHolding(stale.slot);
      setBusy?.(true);
      const reset = item.sessions.map((s) =>
        sameSession(s, stale.trackKey, stale.slot) ? { ...s, bmiLineId: null, heldQty: null } : s,
      );
      try {
        await releaseRaceSimSessionLines(session, [stale]);
        if (cancelled) return;
        onChange({ sessions: reset, racerCount: qty, assignedTo: partyIds });
        await bookRaceSimSession(
          session,
          { ...item, sessions: reset, racerCount: qty, assignedTo: partyIds },
          stale,
          dispatch,
        );
      } catch (err) {
        if (!cancelled) {
          onChange({ sessions: reset.filter((s) => !sameSession(s, stale.trackKey, stale.slot)) });
          setHoldError(
            err instanceof Error
              ? `${t("slot.hold.filled")} (${err.message})`
              : t("slot.hold.filled"),
          );
        }
      } finally {
        if (!cancelled) {
          setHolding(null);
          setBusy?.(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stale session identity only
  }, [stale?.slot, stale?.trackKey, stale?.heldQty, qty, holding]);

  const nowMs = Date.now();
  const leadCutoffMs = nowMs + LEAD_MS;
  const visible = slots.filter(
    ({ block }) => gridDate !== today || wallClockMs(block.start) >= leadCutoffMs,
  );

  // TEST KIOSK ONLY (kiosk 99, context.kioskTest) — racing's rig: when TODAY's
  // grid has settled empty (all sessions past/lead-filtered/none planned) and
  // nothing is picked yet, roll the item ONE day forward so after-close
  // testing has a real grid. One roll per mount; only ever off today. Real
  // kiosks have no kioskTest flag.
  const kioskTestRig = !!session.context?.kioskTest;
  const testRolledRef = useRef(false);
  useEffect(() => {
    if (!kioskTestRig || testRolledRef.current || !target) return;
    if (gridDate !== today || scanState !== "done" || visible.length > 0) return;
    if (item.sessions.length > 0) return;
    testRolledRef.current = true;
    const next = new Date(`${today}T12:00:00`);
    next.setDate(next.getDate() + 1);
    onChange({ date: next.toISOString().slice(0, 10), sessions: [] });
  }, [
    kioskTestRig,
    target,
    gridDate,
    today,
    scanState,
    visible.length,
    item.sessions.length,
    onChange,
  ]);
  const testShowingFutureDay = kioskTestRig && gridDate > today;

  const product = getRaceSimProduct(item.productSlug);
  const productNameKey = item.productSlug ? PRODUCT_NAME_KEYS[item.productSlug] : undefined;
  const productName = productNameKey
    ? t(productNameKey)
    : (product?.name ?? t("racesim.tile.name"));
  const trackName = item.trackKey ? t(TRACK_NAME_KEYS[item.trackKey]) : null;
  const displayDate = new Date(`${gridDate}T12:00:00`).toLocaleDateString(
    locale === "es" ? "es-US" : "en-US",
    { weekday: "long", month: "long", day: "numeric" },
  );
  const pickedCount = item.sessions.length;

  // Racing's full-day private-event guard — the whole screen, before the grid.
  const privateEvent = raceSimPrivateEventTitle(gridDate);
  if (privateEvent) {
    return (
      <div className="space-y-[32px]">
        <div className="rounded-[16px] border border-amber-500/30 bg-amber-500/5 p-[28px] text-center">
          <p className="k-display text-[32px] text-amber-300">
            {t("racesim.slot.privateEvent.title")}
          </p>
          <p className="mt-[8px] text-[20px] text-white/60">
            {t("racesim.slot.privateEvent.body")}
          </p>
          <p className="mt-[8px] text-[17px] text-white/40">{privateEvent}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-[32px]">
      {/* Header — racing's "Pick a Heat" + "product · date" line. */}
      <div className="text-center">
        <h2 className="k-display mb-[6px] text-[32px] tracking-widest text-white">
          {t("racesim.slot.heading")}
        </h2>
        <p className="text-[18px] text-white/50">
          <span className="text-white/80">
            {productName}
            {trackName ? ` · ${trackName}` : ""}
          </span>{" "}
          · {displayDate}
        </p>
      </div>
      {testShowingFutureDay && (
        <div className="mx-auto max-w-[720px] rounded-[12px] border border-amber-500/40 bg-amber-500/10 px-[16px] py-[8px] text-center text-[15px] font-semibold text-amber-300">
          TEST KIOSK — today&apos;s sessions are done; showing tomorrow&apos;s grid
        </div>
      )}

      {/* Track cards — racing's TrackInfoBanner (tinted card, display title,
          ring when active, siblings dimmed); they filter the grid, picks stay. */}
      <div className="space-y-[10px]">
        <div className="grid grid-cols-3 gap-[16px]">
          {RACE_SIM_TRACKS.map((track) => {
            const active = item.trackKey === track.key;
            const { tint, title } = TRACK_TINT[track.key];
            return (
              <button
                key={track.key}
                type="button"
                aria-pressed={active}
                disabled={holding != null}
                onClick={() => switchTrack(track.key)}
                className={`k-tap rounded-[16px] border-2 px-[24px] py-[18px] text-left ${
                  item.trackKey && !active ? "opacity-40" : ""
                }`}
                style={{
                  borderColor: active ? tint : `${tint}66`,
                  background: `${tint}14`,
                  boxShadow: active ? `0 0 0 4px ${tint}99` : "none",
                }}
              >
                <div className="k-display text-[26px] tracking-wider" style={{ color: title }}>
                  {t(TRACK_NAME_KEYS[track.key])}
                </div>
              </button>
            );
          })}
        </div>
        {trackName && (
          <p className="text-center text-[16px] text-white/35">
            {t("racesim.slot.trackHint", { track: trackName })}
          </p>
        )}
      </div>

      {/* Racer count summary — racing's "Booking for N racers" card, plus the
          running pick count across tracks. */}
      <div className="mx-auto max-w-[520px] rounded-[16px] border border-white/8 bg-white/[0.03] p-[16px] text-center">
        <p className="text-[17px] text-white/50">
          {t("racesim.slot.bookingFor", { count: qty })}
          {pickedCount > 0 && (
            <span className="text-[#00E2E5]">
              {" · "}
              {t("racesim.slot.pickedCount", { count: pickedCount })}
            </span>
          )}
        </p>
      </div>

      {holdError && !holding && (
        <div className="mx-auto max-w-[520px] rounded-[16px] border border-red-500/30 bg-red-500/5 p-[16px] text-center text-[17px] text-red-300">
          {holdError}
        </div>
      )}

      {scanState === "loading" ? (
        <div className="flex h-[260px] items-center justify-center">
          <div className="h-[42px] w-[42px] animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      ) : scanState === "error" ? (
        <div className="rounded-[16px] border border-red-500/30 bg-red-500/5 p-[20px] text-center">
          <p className="text-[18px] text-red-300">{t("slot.error")}</p>
          <button
            type="button"
            onClick={() => setRefreshTick((n) => n + 1)}
            className="k-tap mt-[10px] rounded-[10px] border border-white/15 px-[20px] py-[8px] text-[16px] font-semibold text-white/70"
          >
            {t("racesim.slot.retry")}
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-[16px] border border-white/10 bg-white/[0.03] p-[20px] text-center text-[18px] text-white/50">
          {t("racesim.slot.empty")}
        </div>
      ) : (
        /* The grid — one flat earliest-first grid, racing's 4 columns. */
        <div className="grid grid-cols-4 gap-[10px]">
          {visible.map((entry) => {
            const { block } = entry;
            const startMs = wallClockMs(block.start);
            const free = block.freeSpots;
            const cap = Math.max(1, block.capacity ?? free);
            const picked = item.sessions.find((s) => sameSession(s, item.trackKey, block.start));
            const isSelected = !!picked;
            const isHolding = holding === block.start;
            // The same start already picked on ANOTHER track — same rigs.
            const ownOther = isSelected
              ? null
              : ownPickAtSameStart(item.sessions, block.start, item.trackKey);
            // Racing's gates, in its order. Selected cards are never "full".
            const isEventReserved =
              !isSelected && raceSimSlotEventReserved(gridDate, block.start, block.stop);
            const isBeforeReopen = !isSelected && raceSimSlotBeforeReopen(gridDate, block.start);
            const isCartConflict = !isSelected && raceSimSlotConflicts(startMs, cartOthers);
            const isExistingConflict =
              !isSelected && !isCartConflict && raceSimSlotConflicts(startMs, existing);
            const isConflict = isCartConflict || isExistingConflict || !!ownOther;
            const isLowCap = free < qty;
            const isFull =
              !isSelected && (isLowCap || isConflict || isEventReserved || isBeforeReopen);

            // Racing's status matrix, in its precedence.
            let statusKey: MessageKey;
            let statusVars: Record<string, string | number> = {};
            let statusClass: string;
            if (isEventReserved || isBeforeReopen) {
              statusKey = "racesim.slot.reservedForEvent";
              statusClass = "text-amber-400";
            } else if (ownOther) {
              statusKey = "racesim.slot.pickedOtherTrack";
              statusVars = { track: t(TRACK_NAME_KEYS[ownOther.trackKey]) };
              statusClass = "text-amber-400";
            } else if (isExistingConflict) {
              statusKey = "racesim.slot.tooCloseExisting";
              statusClass = "text-amber-400";
            } else if (isCartConflict) {
              statusKey = "racesim.slot.tooClose";
              statusClass = "text-amber-400";
            } else if (isLowCap && free > 0) {
              statusKey = "racesim.slot.needOnly";
              statusVars = { need: qty, free };
              statusClass = "text-red-400";
            } else if (free === 0) {
              statusKey = "racesim.slot.full";
              statusClass = "text-red-400";
            } else if (free / cap <= 0.3) {
              statusKey = "racesim.slot.spotsLeft";
              statusVars = { count: free };
              statusClass = "text-amber-400";
            } else {
              statusKey = "racesim.slot.open";
              statusVars = { free, cap };
              statusClass = "text-emerald-400";
            }

            const cardClass = isSelected
              ? "border-[#00E2E5] bg-[#00E2E5]/15 ring-1 ring-[#00E2E5]/50"
              : isFull
                ? "cursor-not-allowed border-white/5 bg-white/[0.03] opacity-40"
                : "cursor-pointer border-white/10 bg-white/5";
            const amberBar = isConflict || isEventReserved || isBeforeReopen;
            const barClass = isLowCap
              ? "bg-red-500"
              : amberBar
                ? "bg-amber-400/50"
                : free / cap <= 0.3
                  ? "bg-amber-400"
                  : "bg-emerald-400";

            return (
              <button
                key={block.start}
                type="button"
                disabled={isFull || holding != null}
                // Tapping a picked card unpicks it (racing's deselect —
                // releases its hold); an open card ADDS a session.
                onClick={() => void (picked ? unpickSession(picked) : bookSlot(entry))}
                className={`k-tap relative rounded-[16px] border p-[16px] text-left ${cardClass}`}
              >
                {isHolding && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-[6px] rounded-[16px] border border-[#00E2E5]/60 bg-[#000418]/85 backdrop-blur-sm">
                    <div className="h-[26px] w-[26px] animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
                    <span className="text-[14px] font-semibold text-[#00E2E5]">
                      {t("slot.holding")}
                    </span>
                  </div>
                )}
                <div className="k-num mb-[2px] text-[24px] font-bold text-white">
                  {slotLabel(block.start)}
                </div>
                <div className="mb-[10px]" />
                <div className="mb-[4px] text-[15px] font-medium text-white/60">{block.name}</div>
                <div className={`text-[16px] font-medium ${statusClass}`}>
                  {t(statusKey, statusVars)}
                </div>
                <div className="mt-[10px] h-[5px] overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full ${barClass}`}
                    style={{ width: amberBar ? "100%" : `${Math.min(100, (free / cap) * 100)}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// TODO(i18n): title/reasons localize via KioskFlow's lookup maps — "Time" →
// stepTitle.time, the reasons → stepReason.kioskSlot / racesimConflict /
// racesimSelfConflict.
export const KioskRaceSimSlotStep: StepDef<RaceSimItem> = {
  id: "racesim-slot",
  title: "Time",
  Component: KioskRaceSimSlotStepComponent,
  isVisible: () => true,
  // Racing's canAdvanceFor re-runs the rules as the wizard gate: at least one
  // session, no two of them on one start, none too close to the rest of the cart.
  canAdvance: (item, session) => {
    if (item.sessions.length === 0) return { reason: "Pick a time to continue." };
    if (findRaceSimSelfConflict(item.sessions)) {
      return { reason: "You picked the same time on two tracks — remove one to continue." };
    }
    const others = cartTimedBookings(session.items, item.id);
    if (item.sessions.some((s) => raceSimSlotConflicts(wallClockMs(s.slot), others))) {
      return { reason: "That time is too close to another activity — pick another." };
    }
    return true;
  },
};
