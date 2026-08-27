"use client";

/**
 * Kiosk Race Sims time step — the racing HEAT PICKER on a sim item (owner
 * 2026-08-26: "follow racing as close as possible", "apply all of our
 * scheduling rules", and keep the Track step AND let guests change track on
 * the heat-pick screen).
 *
 * Layout mirrors RaceHeatPickerStep's kiosk render at canvas px: centered
 * heading + "product · track · date" line, racing's TrackInfoBanner track
 * cards (Track A/B/C) above the grid, "Booking for N racers" summary, ONE
 * flat earliest-first grid of time cards (big time → block name → tri-color
 * status line → capacity bar), racing's selected / idle / disabled states,
 * tap-to-unpick, per-card "Holding…" overlay, hold-error card, loading /
 * error+Retry / empty shells, semi-live 30s refetch.
 *
 * Track cards: on racing they FILTER one multi-track grid; every sim track
 * is its own $0 key that books the same rigs, so here a card SWITCHES the
 * track — releases any held line (the hold is per key), clears the pick and
 * refetches that key's sessions. Same visual, honest semantics.
 *
 * Scheduling rules — racing's engine via race-sims/scheduling.ts, shared
 * with the reserve guard so grid and server agree: spacing (heatsConflict:
 * 30 min vs a kart heat, skip-a-session vs another sim) against the whole
 * cart AND the party's other reservations today (booked-heats — karting heats
 * + prior sim sessions); group events (full-day private event blocks the
 * screen, morning buyout greys before the public reopen, event windows grey
 * overlapping sessions); capacity vs party; a 10-min lead. canAdvance re-runs
 * the spacing check on the picked slot, racing's canAdvanceFor pattern.
 *
 * Racing books per (heat × racer) line with racers stamped at the pick; a
 * sim is ONE $0 track-key line for the whole party, so the tap stamps the
 * roster (racerCount/assignedTo from session.party) and eager-holds with that
 * quantity (bookRaceSimOnAdvance records heldQty). A party change after the
 * hold re-holds at the new quantity; reserve guard 2e refuses a stale hold.
 *
 * Karting-only rules deliberately not mirrored: tier/category restrictions,
 * cross-category collision, pack caps, licence lead/briefing copy.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RaceSimItem, StepDef } from "~/features/booking";
import { bmiAdapter, type BmiBlock, type BmiProposal } from "~/features/booking/data/bmi";
import { releaseItemBmiLines } from "~/features/booking/service/checkout";
import {
  RACE_SIM_TRACKS,
  getRaceSimProduct,
  raceSimBookingTarget,
  type RaceSimTrackKey,
} from "~/features/race-sims/products";
import { bookRaceSimOnAdvance } from "~/features/race-sims/service";
import {
  cartTimedBookings,
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

/** Sentinel for `holding` while a track switch releases the old line. */
const SWITCHING = "__track__";

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
  const [holding, setHolding] = useState<string | null>(null); // block.start (or SWITCHING)
  const [holdError, setHoldError] = useState<string | null>(null);
  // The party's karting heats + sim sessions in OTHER reservations today
  // (racing's booked-heats signal, matched by bmiPersonId), with their track
  // so the spacing rule can tell same-track from cross-track. Fail-open.
  const [existing, setExisting] = useState<TimedBooking[]>([]);
  const lastTargetRef = useRef<string | null>(null);

  // Kiosk = walk-up: the date is always today.
  const today = todayYmd();
  useEffect(() => {
    if (item.date !== today) onChange({ date: today, slot: null, slotProposal: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.date, today]);

  // Fetch today's sessions for the chosen track's key; refetch every 30s.
  useEffect(() => {
    if (!target || item.date !== today) {
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
        date: today,
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
  }, [target?.productId, target?.pageId, item.date, qty, today, refreshTick]);

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
    const params = new URLSearchParams({ date: today, personIds: personKey });
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
  }, [personKey, today, session.bmiBillId, refreshTick]);

  // Other cart activities — racing's cart-conflict gating, via the shared
  // spacing rule (track-aware).
  const cartOthers = cartTimedBookings(session.items, item.id);

  /** Release whatever this item holds and clear the pick (racing's deselect). */
  const unpick = useCallback(async () => {
    if (holding) return;
    setHolding(item.slot);
    setHoldError(null);
    setBusy?.(true);
    try {
      if (item.bmiLineId) await releaseItemBmiLines(session, item);
    } finally {
      onChange({ slot: null, slotProposal: null, bmiLineId: null, heldQty: null });
      setHolding(null);
      setBusy?.(false);
    }
  }, [holding, item, session, onChange, setBusy]);

  const bookSlot = useCallback(
    async (entry: SlotEntry) => {
      if (holding) return;
      setHolding(entry.block.start);
      setHoldError(null);
      setBusy?.(true);
      const stamped = {
        slot: entry.block.start,
        slotProposal: entry.proposal,
        bmiLineId: null,
        heldQty: null,
        racerCount: qty,
        assignedTo: partyIds,
      };
      try {
        if (item.bmiLineId) await releaseItemBmiLines(session, item);
        onChange(stamped);
        await bookRaceSimOnAdvance(session, { ...item, ...stamped }, dispatch);
      } catch (err) {
        onChange({ slot: null, slotProposal: null, bmiLineId: null, heldQty: null });
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

  /** Track cards: switching track = a different $0 key, so release the held
   *  line, clear the pick, and let the fetch effect load that key's sessions. */
  const switchTrack = useCallback(
    async (key: RaceSimTrackKey) => {
      if (holding || key === item.trackKey) return;
      setHolding(SWITCHING);
      setHoldError(null);
      setBusy?.(true);
      try {
        if (item.bmiLineId) await releaseItemBmiLines(session, item);
      } finally {
        onChange({ trackKey: key, slot: null, slotProposal: null, bmiLineId: null, heldQty: null });
        setHolding(null);
        setBusy?.(false);
      }
    },
    [holding, item, session, onChange, setBusy],
  );

  // Party changed after the hold: BMI holds heldQty seats, the roster says
  // qty — re-hold the same session at the new quantity (racing's per-racer
  // lines re-stamp for free; the sim's single line must re-hold).
  useEffect(() => {
    if (!item.slot || !item.bmiLineId || item.heldQty == null || holding) return;
    if (item.heldQty === qty || scanState !== "done") return;
    const entry = slots.find((s) => s.block.start === item.slot);
    if (entry) void bookSlot(entry);
  }, [item.slot, item.bmiLineId, item.heldQty, qty, holding, scanState, slots, bookSlot]);

  const nowMs = Date.now();
  const leadCutoffMs = nowMs + LEAD_MS;
  const visible = slots.filter(({ block }) => wallClockMs(block.start) >= leadCutoffMs);

  const product = getRaceSimProduct(item.productSlug);
  const productNameKey = item.productSlug ? PRODUCT_NAME_KEYS[item.productSlug] : undefined;
  const productName = productNameKey
    ? t(productNameKey)
    : (product?.name ?? t("racesim.tile.name"));
  const trackName = item.trackKey ? t(TRACK_NAME_KEYS[item.trackKey]) : null;
  const displayDate = new Date(`${today}T12:00:00`).toLocaleDateString(
    locale === "es" ? "es-US" : "en-US",
    { weekday: "long", month: "long", day: "numeric" },
  );

  // Racing's full-day private-event guard — the whole screen, before the grid.
  const privateEvent = raceSimPrivateEventTitle(today);
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

      {/* Track cards — racing's TrackInfoBanner (tinted card, display title,
          ring when active, siblings dimmed); here they switch the key. */}
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
                onClick={() => void switchTrack(track.key)}
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

      {/* Racer count summary — racing's "Booking for N racers" card. */}
      <div className="mx-auto max-w-[520px] rounded-[16px] border border-white/8 bg-white/[0.03] p-[16px] text-center">
        <p className="text-[17px] text-white/50">{t("racesim.slot.bookingFor", { count: qty })}</p>
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
            const isSelected = item.slot === block.start;
            const isHolding = holding === block.start;
            // Racing's gates, in its order. Selected cards are never "full".
            const isEventReserved =
              !isSelected && raceSimSlotEventReserved(today, block.start, block.stop);
            const isBeforeReopen = !isSelected && raceSimSlotBeforeReopen(today, block.start);
            const isCartConflict = !isSelected && raceSimSlotConflicts(startMs, cartOthers);
            const isExistingConflict =
              !isSelected && !isCartConflict && raceSimSlotConflicts(startMs, existing);
            const isConflict = isCartConflict || isExistingConflict;
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
                // Tapping the picked card unpicks it (racing's deselect —
                // releases the hold); any other card switches the hold.
                onClick={() => void (isSelected ? unpick() : bookSlot(entry))}
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
// stepTitle.time, the two reasons → stepReason.kioskSlot / racesimConflict.
export const KioskRaceSimSlotStep: StepDef<RaceSimItem> = {
  id: "racesim-slot",
  title: "Time",
  Component: KioskRaceSimSlotStepComponent,
  isVisible: () => true,
  // Racing's canAdvanceFor re-runs the spacing rule as the wizard gate; the
  // sim gate re-checks the picked session against the rest of the cart.
  canAdvance: (item, session) => {
    if (!item.slot) return { reason: "Pick a time to continue." };
    const others = cartTimedBookings(session.items, item.id);
    if (raceSimSlotConflicts(wallClockMs(item.slot), others)) {
      return { reason: "That time is too close to another activity — pick another." };
    }
    return true;
  },
};
