"use client";

/**
 * Kiosk Race Sims schedule — time AND circuit on one screen.
 *
 * Owner 2026-09-15: "The circuit has a picker on the schedule. the block or
 * race session gets blocks." So the separate Track step is GONE and every time
 * block carries its own circuit picker; once a block has a circuit, the block
 * is locked to it and the other circuits disappear from that block.
 *
 * WHY A BLOCK CAN ONLY RUN ONE CIRCUIT. There are four rigs and ONE shared
 * capacity pool — every $0 track key draws the same "Race Sim" resource
 * sessions (race-sims/products.ts). A 10:00 session is therefore four rigs
 * running one circuit. Before this screen existed, two parties could book the
 * same 10:00 on different keys and the desk had to tell one of them no, after
 * they had paid. Now the first booking on a slot fixes its key, the schedule
 * shows that, and reserve guard 2f refuses a stale pick before the charge.
 *
 * THE KEY IS NOT THE CIRCUIT. Keys A/B/C are the three $0 BMI products
 * (59535405 / 59537905 / 59537953) and never change; the CIRCUIT each one runs
 * is this week's lineup (race-sims/circuits.ts) and rotates. Everything a
 * guest reads here comes from the lineup; everything BMI is told comes from
 * the key.
 *
 * AVAILABILITY IS FETCHED PER KEY, ON PURPOSE. All three keys propose the same
 * times, so one fetch would paint the same grid — but the PROPOSAL that books
 * a seat is issued per key, and handing BMI key B a proposal minted for key A
 * is not something to find out about on a live booking. Three parallel fetches,
 * indexed by (key, start), means the proposal we book with is always the one
 * that key issued.
 *
 * Layout otherwise mirrors RaceHeatPickerStep's kiosk render at canvas px:
 * centered heading + "product · date", "Booking for N racers" summary, one
 * flat earliest-first grid of time cards (big time → status line → capacity
 * bar → circuit chips), tap-to-unpick, per-card "Holding…" overlay, hold-error
 * card, loading / error+Retry / empty shells, semi-live 30s refetch.
 *
 * Scheduling rules — race-sims/scheduling.ts, shared with the reserve guard so
 * grid and server agree: sim-vs-sim = the SAME time slot is the same rigs (and
 * is now expressed as the block's lock rather than a greyed sibling card),
 * back-to-back is allowed; sim-vs-kart heat / attraction / bowling = racing's
 * 30-min cross-activity spacing, against the whole cart AND the party's other
 * reservations today (booked-heats); group events (full-day private event
 * blocks the screen, morning buyout greys before the public reopen, event
 * windows grey overlapping sessions); capacity vs party; a 10-min lead.
 *
 * Racing books per (heat × racer) line with racers stamped at the pick; a sim
 * session is ONE $0 line for the whole party, so the tap stamps the roster
 * (racerCount/assignedTo from session.party) and holds with that quantity
 * (heldQty). A party change after the hold re-holds each session at the new
 * quantity; reserve guard 2e refuses a stale hold.
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
import { circuitForTrack, type SimCircuit } from "~/features/race-sims/circuits";
import { bookRaceSimSession } from "~/features/race-sims/service";
import {
  cartSimSlotLocks,
  cartTimedBookings,
  findRaceSimSelfConflict,
  lockedTrackKeyForSlot,
  ownSessionsMissingFromGrid,
  raceSimPrivateEventTitle,
  raceSimSlotBeforeReopen,
  raceSimSlotConflicts,
  raceSimSlotEventReserved,
  simSlotLockIndex,
  wallClockMs,
  type SimSlotLock,
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

const TRACK_KEYS: readonly RaceSimTrackKey[] = ["a", "b", "c"] as const;

/** `synthetic`: a card rebuilt from one of our own picks that BMI no longer
 *  proposes (our hold took the shared rigs) — see ownSessionsMissingFromGrid. */
type SlotEntry = { block: BmiBlock; proposal: BmiProposal; synthetic?: boolean };
/** Per-key availability: start ISO → that key's own entry. */
type TrackSlots = Partial<Record<RaceSimTrackKey, Map<string, SlotEntry>>>;

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
  // Racing: the whole party races — quantity comes from the roster, and the
  // tap stamps it onto the item (racing stamps racers at the heat pick).
  const partyIds = session.party.map((m) => m.id);
  const qty = Math.max(1, partyIds.length);
  const personIds = [
    ...new Set(session.party.map((m) => m.bmiPersonId).filter((id): id is string => !!id)),
  ].sort();

  const [trackSlots, setTrackSlots] = useState<TrackSlots>({});
  const [scanState, setScanState] = useState<"loading" | "done" | "error">("loading");
  const [refreshTick, setRefreshTick] = useState(0);
  const [holding, setHolding] = useState<string | null>(null); // block.start being held/released
  const [holdError, setHoldError] = useState<string | null>(null);
  // The party's karting heats + sim sessions in OTHER reservations today
  // (racing's booked-heats signal, matched by bmiPersonId), with their track
  // so the rule can tell a sim row from a kart heat. Fail-open.
  const [existing, setExisting] = useState<TimedBooking[]>([]);
  // Slots OTHER reservations have already locked to a circuit. Fail-open: an
  // empty list just offers every circuit, and guard 2f still refuses at reserve.
  const [serverLocks, setServerLocks] = useState<SimSlotLock[]>([]);
  const lastDateRef = useRef<string | null>(null);
  // Serializes the party-change re-hold (racing's useEagerHeatHold holdingRef):
  // a ref, not state, so the effect never re-fires on its own state write.
  const reholdRef = useRef(false);

  // Kiosk = walk-up: the date is always today.
  const today = todayYmd();
  // The date the grid shows: item.date when it is today or later (the test
  // kiosk may have rolled it forward), otherwise today.
  const gridDate = item.date && item.date >= today ? item.date : today;
  useEffect(() => {
    if (!item.date || item.date < today) onChange({ date: today, sessions: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.date, today]);

  // Fetch EVERY key's sessions in parallel; refetch every 30s. One key's
  // failure is not the screen's failure — the others still offer their
  // circuits, and a circuit with no proposal simply isn't pickable.
  useEffect(() => {
    if (!item.date) {
      setScanState("done");
      setTrackSlots({});
      return;
    }
    let cancelled = false;
    // Show the spinner on first load and on a date change, never on the
    // silent 30s poll.
    if (refreshTick === 0 || lastDateRef.current !== gridDate) setScanState("loading");
    lastDateRef.current = gridDate;
    Promise.all(
      TRACK_KEYS.map(async (key) => {
        const target = raceSimBookingTarget(key);
        if (!target) return [key, null] as const;
        try {
          const res = await bmiAdapter.getAvailability({
            date: gridDate,
            productId: target.productId,
            pageId: target.pageId,
            quantity: qty,
          });
          const byStart = new Map<string, SlotEntry>();
          for (const proposal of res.proposals) {
            const block = proposal.blocks[0]?.block;
            if (block && !byStart.has(block.start)) byStart.set(block.start, { block, proposal });
          }
          return [key, byStart] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: TrackSlots = {};
      for (const [key, map] of pairs) if (map) next[key] = map;
      setTrackSlots(next);
      // Every key failing is a real outage; one failing is not.
      setScanState(Object.keys(next).length === 0 ? "error" : "done");
    });
    const timer = setInterval(() => setRefreshTick((n) => n + 1), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [item.date, gridDate, qty, refreshTick]);

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

  // Which slots are already locked to a circuit by OTHER reservations. Polled
  // on the same tick as the grid so a slot claimed while this guest is looking
  // collapses to its one circuit within 30s rather than at the charge.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ date: gridDate });
    if (session.bmiBillId) params.set("excludeBillId", session.bmiBillId);
    fetch(`/api/booking/v2/sim-slot-circuits?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) return { locks: [] as SimSlotLock[] };
        return (await res.json()) as { locks: SimSlotLock[] };
      })
      .then((data) => {
        if (!cancelled) setServerLocks(data.locks ?? []);
      })
      .catch(() => {
        if (!cancelled) setServerLocks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gridDate, session.bmiBillId, refreshTick]);

  // Other cart activities — racing's cart-conflict gating, via the shared rule.
  const cartOthers = cartTimedBookings(session.items, item.id);

  // Locks the grid renders from: other reservations FIRST (a stranger's
  // booking outranks our cart), then the cart's own picks — which is what
  // stops one cart putting two circuits into one session. Same construction
  // as guard 2f, so the screen and the server agree about who owns a slot.
  const lockIndex = simSlotLockIndex([...serverLocks, ...cartSimSlotLocks(session.items)]);

  /** Tap a picked chip: release its $0 line and drop the session (racing's
   *  deselect). Other picks stay. */
  const unpickSession = useCallback(
    async (sess: RaceSimSession) => {
      if (holding || reholdRef.current) return;
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

  /** Tap a circuit chip on an open block: ADD a session on THAT key and hold
   *  it. The proposal comes from that key's own fetch — never another key's. */
  const bookSlot = useCallback(
    async (trackKey: RaceSimTrackKey, start: string) => {
      if (holding || reholdRef.current) return;
      const entry = trackSlots[trackKey]?.get(start);
      if (!entry) return;
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
      const next = [...item.sessions.filter((s) => s.slot !== start), added];
      // trackKey on the ITEM follows the latest pick: it is only the "current"
      // track for anything still reading it, while the money and the $0 lines
      // live per session.
      const stamped = { sessions: next, racerCount: qty, assignedTo: partyIds, trackKey };
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
    [holding, item, session, onChange, dispatch, setBusy, qty, t, trackSlots],
  );

  // Party changed after a hold: BMI holds heldQty seats, the roster says qty —
  // re-hold that session at the new quantity, one at a time (racing's
  // per-racer lines re-stamp for free; a sim line must re-hold).
  //
  // Serialized through reholdRef and keyed on the stale session's identity
  // only — never on `holding` (a state dep would re-fire the effect on its own
  // setHolding, cancel the in-flight repair after the release and strand the
  // step in "Holding…"; review 2026-08-26). No cancel flag: the teardown in
  // `finally` is unconditional, and each branch leaves the item honest —
  // release failed → the old line is still held (kept as is, guard 2e refuses
  // the stale hold); re-book failed → the session is dropped (its line is gone).
  const stale = item.sessions.find((s) => s.bmiLineId && s.heldQty != null && s.heldQty !== qty);
  useEffect(() => {
    if (!stale || reholdRef.current) return;
    reholdRef.current = true;
    const target = stale;
    const roster = { racerCount: qty, assignedTo: partyIds };
    const reset = item.sessions.map((s) =>
      sameSession(s, target.trackKey, target.slot) ? { ...s, bmiLineId: null, heldQty: null } : s,
    );
    const fail = (err: unknown) =>
      setHoldError(
        err instanceof Error ? `${t("slot.hold.filled")} (${err.message})` : t("slot.hold.filled"),
      );
    (async () => {
      setHolding(target.slot);
      setHoldError(null);
      setBusy?.(true);
      let released = false;
      try {
        await releaseRaceSimSessionLines(session, [target]);
        released = true;
        onChange({ sessions: reset, ...roster });
        await bookRaceSimSession(
          session,
          { ...item, sessions: reset, ...roster },
          target,
          dispatch,
        );
      } catch (err) {
        if (released) {
          onChange({
            sessions: reset.filter((s) => !sameSession(s, target.trackKey, target.slot)),
          });
        }
        fail(err);
      } finally {
        reholdRef.current = false;
        setHolding(null);
        setBusy?.(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stale session identity only
  }, [stale?.slot, stale?.trackKey, stale?.heldQty, qty]);

  const nowMs = Date.now();
  const leadCutoffMs = nowMs + LEAD_MS;

  // One row per START, across every key: the keys propose the same times, and
  // a union means a key that failed its fetch cannot hide a whole time from
  // the schedule — it only removes its own circuit from that block's chips.
  const startsSeen = new Map<string, BmiBlock>();
  for (const key of TRACK_KEYS) {
    const map = trackSlots[key];
    if (!map) continue;
    for (const [start, entry] of map) {
      if (gridDate === today && wallClockMs(start) < leadCutoffMs) continue;
      if (!startsSeen.has(start)) startsSeen.set(start, entry.block);
    }
  }

  // TEST KIOSK ONLY (kiosk 99, context.kioskTest) — racing's rig: when TODAY's
  // grid has settled empty (all sessions past/lead-filtered/none planned) and
  // nothing is picked yet, roll the item ONE day forward so after-close
  // testing has a real grid. One roll per mount; only ever off today. Real
  // kiosks have no kioskTest flag.
  const kioskTestRig = !!session.context?.kioskTest;
  const testRolledRef = useRef(false);
  const visibleCount = startsSeen.size;
  useEffect(() => {
    if (!kioskTestRig || testRolledRef.current) return;
    if (gridDate !== today || scanState !== "done" || visibleCount > 0) return;
    if (item.sessions.length > 0) return;
    testRolledRef.current = true;
    const next = new Date(`${today}T12:00:00`);
    next.setDate(next.getDate() + 1);
    onChange({ date: next.toISOString().slice(0, 10), sessions: [] });
  }, [kioskTestRig, gridDate, today, scanState, visibleCount, item.sessions.length, onChange]);
  const testShowingFutureDay = kioskTestRig && gridDate > today;

  // Own picks BMI no longer proposes on ANY key: every sim key books the same
  // four rigs, so our own hold eats the seats and BMI drops any block with
  // fewer free seats than the party (it never returns a full block). Without
  // this a party of 4 loses its SELECTED card on the next poll and cannot
  // unpick. Rebuild those rows from the pick's own block.
  const synthetic = ownSessionsMissingFromGrid(
    item.sessions,
    [...startsSeen.keys()],
    gridDate,
    null,
  );
  const grid: { start: string; block: BmiBlock; synthetic: boolean }[] = [
    ...[...startsSeen.entries()].map(([start, block]) => ({ start, block, synthetic: false })),
    ...synthetic.map((s) => {
      const b = s.slotProposal.blocks[0]?.block;
      return {
        start: s.slot,
        synthetic: true,
        block: {
          name: b?.name ?? "",
          capacity: b?.capacity ?? qty,
          freeSpots: 0,
          resourceId: b?.resourceId ?? 0,
          prices: b?.prices ?? [],
          start: s.slot,
          stop: b?.stop ?? s.slot,
        } as BmiBlock,
      };
    }),
  ].sort((a, b) => wallClockMs(a.start) - wallClockMs(b.start));

  const product = getRaceSimProduct(item.productSlug);
  const productNameKey = item.productSlug ? PRODUCT_NAME_KEYS[item.productSlug] : undefined;
  const productName = productNameKey
    ? t(productNameKey)
    : (product?.name ?? t("racesim.tile.name"));
  const displayDate = new Date(`${gridDate}T12:00:00`).toLocaleDateString(
    locale === "es" ? "es-US" : "en-US",
    { weekday: "long", month: "long", day: "numeric" },
  );
  const pickedCount = item.sessions.length;
  // This week's lineup, for the legend above the grid.
  const lineup = TRACK_KEYS.map((key) => ({ key, circuit: circuitForTrack(key, gridDate) })).filter(
    (row): row is { key: RaceSimTrackKey; circuit: SimCircuit } => row.circuit != null,
  );

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
    <div className="space-y-[28px]">
      {/* Header — racing's "Pick a Heat" + "product · date" line. */}
      <div className="text-center">
        <h2 className="k-display mb-[6px] text-[32px] tracking-widest text-white">
          {t("racesim.slot.heading")}
        </h2>
        <p className="text-[18px] text-white/50">
          <span className="text-white/80">{productName}</span> · {displayDate}
        </p>
      </div>
      {testShowingFutureDay && (
        <div className="mx-auto max-w-[720px] rounded-[12px] border border-amber-500/40 bg-amber-500/10 px-[16px] py-[8px] text-center text-[15px] font-semibold text-amber-300">
          TEST KIOSK — today&apos;s sessions are done; showing tomorrow&apos;s grid
        </div>
      )}

      {/* This week's circuits — the legend that makes a three-letter chip on a
          time card mean something. Specs come from the real venues. */}
      {lineup.length > 0 && (
        <div className="space-y-[10px]">
          <p className="text-center text-[17px] text-white/45">{t("racesim.circuit.thisWeek")}</p>
          <div className="grid grid-cols-3 gap-[14px]">
            {lineup.map(({ key, circuit }) => (
              <div
                key={key}
                className="rounded-[16px] border-2 px-[20px] py-[16px]"
                style={{ borderColor: `${circuit.accent}66`, background: `${circuit.accent}14` }}
              >
                <div
                  className="k-display text-[24px] leading-tight tracking-wide"
                  style={{ color: circuit.accent }}
                >
                  {circuit.name}
                </div>
                <div className="mt-[4px] text-[16px] text-white/50">
                  {locale === "es" ? circuit.es.eventName : circuit.eventName}
                </div>
                <div className="k-num mt-[8px] text-[15px] text-white/40">
                  {t("racesim.circuit.stats", {
                    length: circuit.lengthMi.toString(),
                    turns: circuit.turns,
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Racer count summary — racing's "Booking for N racers" card, plus the
          running pick count. */}
      <div className="mx-auto max-w-[560px] rounded-[16px] border border-white/8 bg-white/[0.03] p-[16px] text-center">
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
        <div className="mx-auto max-w-[560px] rounded-[16px] border border-red-500/30 bg-red-500/5 p-[16px] text-center text-[17px] text-red-300">
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
      ) : grid.length === 0 ? (
        <div className="rounded-[16px] border border-white/10 bg-white/[0.03] p-[20px] text-center text-[18px] text-white/50">
          {t("racesim.slot.empty")}
        </div>
      ) : (
        /* The schedule — one flat earliest-first grid. Three columns rather
           than racing's four: each block now carries its own circuit picker,
           and the chips need the width to stay tappable. */
        <div className="grid grid-cols-3 gap-[12px]">
          {grid.map(({ start, block, synthetic: isSynthetic }) => {
            const startMs = wallClockMs(start);
            const free = block.freeSpots;
            const cap = Math.max(1, block.capacity ?? free);
            const picked = item.sessions.find((s) => s.slot === start);
            const isSelected = !!picked;
            const isHolding = holding === start;
            // Racing's gates, in its order. Selected cards are never "full".
            const isEventReserved =
              !isSelected && raceSimSlotEventReserved(gridDate, start, block.stop);
            const isBeforeReopen = !isSelected && raceSimSlotBeforeReopen(gridDate, start);
            const isCartConflict = !isSelected && raceSimSlotConflicts(startMs, cartOthers);
            const isExistingConflict =
              !isSelected && !isCartConflict && raceSimSlotConflicts(startMs, existing);
            const isConflict = isCartConflict || isExistingConflict;
            const isLowCap = free < qty;
            const isBlocked =
              !isSelected && (isLowCap || isConflict || isEventReserved || isBeforeReopen);

            // The block's circuit, if someone already fixed it. Our own pick
            // counts — that is what makes the chips collapse the moment the
            // guest chooses, rather than a poll later.
            const lockedTo = lockedTrackKeyForSlot(lockIndex, start);

            // Racing's status matrix, in its precedence.
            let statusKey: MessageKey;
            let statusVars: Record<string, string | number> = {};
            let statusClass: string;
            if (isSelected && isSynthetic) {
              // Our own hold took the rigs — BMI has no live count to show.
              statusKey = "racesim.slot.picked";
              statusClass = "text-[#00E2E5]";
            } else if (isEventReserved || isBeforeReopen) {
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
              : isBlocked
                ? "border-white/5 bg-white/[0.03] opacity-40"
                : "border-white/10 bg-white/5";
            const amberBar = isConflict || isEventReserved || isBeforeReopen;
            const fullBar = amberBar || (isSelected && isSynthetic);
            const barClass =
              isSelected && isSynthetic
                ? "bg-[#00E2E5]/60"
                : isLowCap
                  ? "bg-red-500"
                  : amberBar
                    ? "bg-amber-400/50"
                    : free / cap <= 0.3
                      ? "bg-amber-400"
                      : "bg-emerald-400";

            // Which circuits this block can still offer. Locked → only that
            // one; otherwise every key that actually proposed this start.
            const offered = (lockedTo ? [lockedTo] : TRACK_KEYS).filter(
              (key) => isSelected || !!trackSlots[key]?.get(start),
            );

            return (
              // A DIV, not a button: the chips inside are the buttons now, and
              // nesting them in one would be invalid and untappable.
              <div
                key={start}
                className={`k-tap relative rounded-[16px] border p-[14px] text-left ${cardClass}`}
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
                  {slotLabel(start)}
                </div>
                {/* BMI's own block name — racing's heat picker shows this too,
                    and once BMI restricts which key may enter which slot it is
                    where the session's own identity comes from. */}
                {block.name && (
                  <div className="mb-[4px] text-[14px] font-medium text-white/50">{block.name}</div>
                )}
                <div className={`text-[15px] font-medium ${statusClass}`}>
                  {t(statusKey, statusVars)}
                </div>
                <div className="mt-[8px] h-[5px] overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full ${barClass}`}
                    style={{ width: fullBar ? "100%" : `${Math.min(100, (free / cap) * 100)}%` }}
                  />
                </div>

                {/* The circuit picker, on the block. Once the block has a
                    circuit — from this cart or someone else's booking — the
                    other circuits are gone, because all four rigs run it. */}
                <div className="mt-[10px] space-y-[6px]">
                  {lockedTo && !isSelected && (
                    <p className="text-[13px] font-semibold uppercase tracking-wide text-amber-400/80">
                      {t("racesim.circuit.locked")}
                    </p>
                  )}
                  {offered.length === 0 ? (
                    <p className="text-[14px] text-white/30">{t("racesim.circuit.none")}</p>
                  ) : (
                    offered.map((key) => {
                      const circuit = circuitForTrack(key, gridDate);
                      const chosen = picked?.trackKey === key;
                      const accent = circuit?.accent ?? "#7dd3fc";
                      const label =
                        circuit?.shortName ??
                        RACE_SIM_TRACKS.find((tr) => tr.key === key)?.conflictLabel ??
                        key.toUpperCase();
                      const disabled = holding != null || (!chosen && isBlocked);
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={chosen}
                          disabled={disabled}
                          onClick={() =>
                            void (chosen && picked ? unpickSession(picked) : bookSlot(key, start))
                          }
                          className={`k-tap w-full rounded-[10px] border-2 px-[10px] py-[8px] text-[16px] font-semibold ${
                            disabled && !chosen ? "cursor-not-allowed opacity-40" : ""
                          }`}
                          style={{
                            borderColor: chosen ? accent : `${accent}55`,
                            background: chosen ? `${accent}33` : `${accent}0f`,
                            color: chosen ? "#ffffff" : accent,
                          }}
                        >
                          {label}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
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
