"use client";

/**
 * Kiosk booking flow orchestrator — the kiosk-shaped sibling of
 * components/features/booking/BookingFlow.tsx.
 *
 * Reused UNCHANGED: the booking session model + reducer, every service
 * (eager BMI heat holds, attraction slot booking, combo itinerary + QAMF
 * lane hold, checkout/reserve), ReservationTimer/ExpiredModal, CartView,
 * CheckoutStep, and (for now) the web step components via
 * KIOSK_STEP_REGISTRY — later kiosk stages swap individual steps there.
 *
 * Kiosk-specific: category-first landing (KioskCategories), device config
 * as the source of center/brand (never hostname, never a center picker),
 * separate sessionStorage key, idle watchdog with hold release, big-touch
 * navigation, inline error card instead of alert(), and every exit path
 * staying inside /kiosk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  emptySession,
  getActiveItem,
  newItem,
  type ActivityOffering,
  type AttractionItem,
  type BowlingItem,
  type RaceItem,
  type SessionItem,
  type StepDef,
} from "~/features/booking";
import { clearBookingSession, usePersistedReducer } from "~/features/booking/hooks";
import { CartView } from "~/components/features/booking/CartView";
import { CheckoutStep } from "~/components/features/booking/steps/checkout/CheckoutStep";
import { HeightAgeConfirmModal } from "~/components/features/booking/steps/race/HeightAgeConfirmModal";
import {
  ReservationTimer,
  type ReservationTimerHandle,
} from "~/components/features/booking/ReservationTimer";
import { ReservationExpiredModal } from "~/components/features/booking/ReservationExpiredModal";
import { contactIsComplete } from "~/components/features/booking/steps/ContactStep";
import { bookHeatsOnAdvance } from "~/features/booking/service/race";
import { bookAttractionOnAdvance } from "~/features/booking/service/attractions";
import {
  abandonBooking,
  releaseItemBmiLines,
  releaseHeatBmiLines,
} from "~/features/booking/service/checkout";
import { comboBowlingComponent, getComboSpecial, type ComboSpecial } from "~/features/combos";
import { holdComboBowling } from "~/features/combos/combo-booking";
import { qamfCenterIdForCode } from "~/features/booking/types";
import { useKioskConfig } from "../KioskConfigContext";
import {
  KIOSK_SCHEMA_VERSION,
  KIOSK_SESSION_STORAGE_KEY,
  KIOSK_STEP_REGISTRY,
} from "../state/registry";
import { KioskCategories } from "./KioskCategories";
import { KioskGameZone } from "./KioskGameZone";
import { IdleWatcher } from "./IdleWatcher";
import { BrandedLoader, BrandedLoaderOverlay } from "./BrandedLoader";
import { todayYmd } from "../service/first-available";
import { KIOSK_PHOTOS } from "../assets";

/** Walk-up device: every dated item starts on today (kiosk drops date steps). */
function stampToday(item: SessionItem): SessionItem {
  if (item.kind === "race" || item.kind === "attraction") {
    return { ...item, date: todayYmd() };
  }
  return item;
}

const IDLE_FLOW_MS = 120_000;
const IDLE_CHECKOUT_MS = 180_000;

/** ?goto= deep links from the attract screen's quick chips. */
function seedForGoto(goto: string): { kind: SessionItem["kind"]; slug?: string } | "vip" | null {
  if (goto === "race") return { kind: "race" };
  if (goto === "bowl" || goto === "bowling") return { kind: "bowling" };
  if (goto === "kbf") return { kind: "kbf" };
  if (goto === "vip") return "vip";
  if (["gel-blaster", "laser-tag", "duck-pin", "shuffly"].includes(goto)) {
    return { kind: "attraction", slug: goto };
  }
  return null;
}

export function KioskFlow({ goto }: { goto: string | null }) {
  const router = useRouter();
  const { config } = useKioskConfig();

  const initial = useMemo(
    () =>
      emptySession({
        entryBrand: config?.brand ?? "fasttrax",
        context: config ? { center: config.center, kiosk: true } : { kiosk: true },
      }),
    [config],
  );
  const [session, dispatch, hydrated] = usePersistedReducer(initial, {
    storageKey: KIOSK_SESSION_STORAGE_KEY,
    schemaVersion: KIOSK_SCHEMA_VERSION,
  });

  const [cartActive, setCartActive] = useState(false);
  const [checkoutActive, setCheckoutActive] = useState(false);
  const [gzOpen, setGzOpen] = useState(false);
  const [stepBusy, setStepBusy] = useState(false);
  const [bookingHeats, setBookingHeats] = useState(false);
  const [bookingHeatsProgress, setBookingHeatsProgress] = useState("Holding your spot…");
  const [kioskError, setKioskError] = useState<string | null>(null);
  const [showHeightConfirm, setShowHeightConfirm] = useState(false);
  const [reservationExpired, setReservationExpired] = useState(false);
  const [resetting, setResetting] = useState(false);
  const timerRef = useRef<ReservationTimerHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const seededGotoRef = useRef(false);

  // No device config → this URL was opened outside a provisioned kiosk.
  useEffect(() => {
    if (config === null && hydrated) router.replace("/kiosk");
  }, [config, hydrated, router]);

  // Post-hydration seeding: center from device config; ?goto= deep link.
  useEffect(() => {
    if (!hydrated || !config) return;
    if (!session.center) dispatch({ type: "setCenter", center: config.center });
    if (goto && !seededGotoRef.current) {
      seededGotoRef.current = true;
      const seed = seedForGoto(goto);
      if (seed === "vip") {
        const combo = getComboSpecial("race-bowl");
        if (
          combo &&
          combo.enabled &&
          combo.center === config.center &&
          session.items.length === 0
        ) {
          dispatch({ type: "setComboSpecial", id: combo.id });
          const raceItem = stampToday(newItem("race"));
          dispatch({ type: "addItem", item: raceItem });
          const bowlComp = comboBowlingComponent(combo);
          const bowlingItem: SessionItem = {
            ...(newItem("bowling") as Extract<SessionItem, { kind: "bowling" }>),
            variant: "hourly",
            durationMinutes: bowlComp?.durationMinutes ?? null,
          };
          dispatch({ type: "addItem", item: bowlingItem });
          dispatch({ type: "setActiveItem", id: raceItem.id });
        }
      } else if (seed) {
        const already = session.items.find(
          (i) =>
            i.kind === seed.kind &&
            (seed.kind !== "attraction" || (i as AttractionItem).slug === seed.slug),
        );
        if (already) {
          dispatch({ type: "setActiveItem", id: already.id });
        } else {
          const item = stampToday(newItem(seed.kind));
          if (item.kind === "attraction" && seed.slug) (item as AttractionItem).slug = seed.slug;
          dispatch({ type: "addItem", item });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, config]);

  /** Release every vendor hold, wipe the guest session + PII, back to attract. */
  const handleStartOver = useCallback(async () => {
    setResetting(true);
    try {
      await abandonBooking(session);
    } catch {
      /* best-effort — BMI bills self-expire in ~20 min as the backstop */
    }
    clearBookingSession(KIOSK_SESSION_STORAGE_KEY);
    window.location.href = "/kiosk"; // full reload = zero React state carryover between guests
  }, [session]);

  const handleReservationExpired = useCallback(() => setReservationExpired(true), []);
  const handleExtendReservation = useCallback(async (): Promise<boolean> => {
    const ok = await timerRef.current?.refresh();
    if (ok) setReservationExpired(false);
    return !!ok;
  }, []);

  const activeItem = getActiveItem(session);

  const bowlingHoldItem = session.items.find((i) => i.kind === "bowling" || i.kind === "kbf");
  const qamfHoldId =
    bowlingHoldItem && (bowlingHoldItem.kind === "bowling" || bowlingHoldItem.kind === "kbf")
      ? bowlingHoldItem.qamfReservationId
      : null;
  const qamfCenterId =
    bowlingHoldItem && (bowlingHoldItem.kind === "bowling" || bowlingHoldItem.kind === "kbf")
      ? bowlingHoldItem.qamfCenterId
      : null;
  const hasActiveHold = !!(session.bmiBillId || qamfHoldId);

  // Scroll to top on step change; clear stale busy flags.
  const currentCursor = activeItem ? (session.cursors[activeItem.id] ?? 0) : null;
  const prevCursorRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevCursorRef.current !== null && currentCursor !== prevCursorRef.current) {
      contentRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
      setStepBusy(false);
      setKioskError(null);
    }
    prevCursorRef.current = currentCursor;
  }, [currentCursor]);

  if (!hydrated || !config) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#000418]">
        <BrandedLoader brand={config?.brand ?? "fasttrax"} label="Warming up…" />
      </div>
    );
  }

  const cartAlreadyHasContact = (activeId: string): boolean => {
    if (!contactIsComplete(session.contact)) return false;
    const hasOtherItem = session.items.some((i) => i.id !== activeId);
    const hasVerifiedRacer = session.party.some((m) => !!m.bmiPersonId);
    return hasOtherItem || hasVerifiedRacer;
  };

  const pickOffering = (offering: ActivityOffering) => {
    const existing = session.items.find(
      (i) =>
        i.kind === offering.kind &&
        (offering.kind !== "attraction" || (i as AttractionItem).slug === offering.attractionSlug),
    );
    if (existing) {
      dispatch({ type: "setActiveItem", id: existing.id });
      return;
    }
    const item = stampToday(newItem(offering.kind));
    if (item.kind === "attraction" && offering.attractionSlug) {
      (item as AttractionItem).slug = offering.attractionSlug;
    }
    dispatch({ type: "addItem", item });
  };

  const pickCombo = (combo: ComboSpecial) => {
    if (session.items.length > 0) {
      setKioskError("Finish or remove your current activities before adding a bundled experience.");
      return;
    }
    dispatch({ type: "setComboSpecial", id: combo.id });
    const raceItem = stampToday(newItem("race"));
    dispatch({ type: "addItem", item: raceItem });
    const bowlComp = comboBowlingComponent(combo);
    const bowlingItem: SessionItem = {
      ...(newItem("bowling") as Extract<SessionItem, { kind: "bowling" }>),
      variant: "hourly",
      durationMinutes: bowlComp?.durationMinutes ?? null,
    };
    dispatch({ type: "addItem", item: bowlingItem });
    dispatch({ type: "setActiveItem", id: raceItem.id });
  };

  const handleRemoveCombo = async () => {
    const raceItem = session.items.find((i) => i.kind === "race");
    const bowlingItem = session.items.find((i) => i.kind === "bowling") as BowlingItem | undefined;
    dispatch({ type: "setComboSpecial", id: null });
    if (raceItem) dispatch({ type: "removeItem", id: raceItem.id });
    if (bowlingItem) dispatch({ type: "removeItem", id: bowlingItem.id });
    if (raceItem) await releaseItemBmiLines(session, raceItem);
    if (bowlingItem) {
      const { releaseComboBowlingHold } = await import("~/features/combos/combo-booking");
      await releaseComboBowlingHold(bowlingItem);
    }
    setCartActive(false);
  };

  const handleRemoveItem = async (id: string) => {
    const item = session.items.find((i) => i.id === id);
    if (session.comboSpecialId && item && (item.kind === "race" || item.kind === "bowling")) {
      await handleRemoveCombo();
      return;
    }
    const wasLast = session.items.length <= 1;
    dispatch({ type: "removeItem", id });
    if (item) await releaseItemBmiLines(session, item);
    if (wasLast) setCartActive(false);
  };

  const handleRemoveHeat = async (itemId: string, productId: string, heatId: string) => {
    const item = session.items.find((i) => i.id === itemId);
    if (!item || item.kind !== "race") return;
    const removed = item.heats.filter((h) => h.productId === productId && h.heatId === heatId);
    if (removed.length === 0) return;
    const remaining = item.heats.filter((h) => !(h.productId === productId && h.heatId === heatId));
    if (remaining.length === 0) {
      await handleRemoveItem(itemId);
      return;
    }
    dispatch({ type: "updateItem", id: itemId, patch: { heats: remaining } });
    await releaseHeatBmiLines(session, removed);
  };

  const utilityStrip = (
    <div className="fixed inset-x-0 bottom-0 z-[60] flex h-[7.5vh] items-center gap-4 border-t border-white/10 bg-[#000418]/85 px-6 backdrop-blur-lg">
      <button
        type="button"
        onClick={() => void handleStartOver()}
        className="font-heading h-[4.8vh] rounded-full border border-white/15 px-6 text-[1.7vh] font-bold uppercase tracking-widest text-white/55"
      >
        ⟲ Start over
      </button>
      <div className="flex-1 text-center text-[1.6vh] text-white/40">
        Need help? A team member at the front desk can assist
      </div>
      <button
        type="button"
        onClick={() => {
          setCheckoutActive(false);
          setCartActive(true);
          dispatch({ type: "setActiveItem", id: null });
        }}
        className="font-heading flex h-[4.8vh] items-center gap-3 rounded-full border border-[#00e2e5]/50 px-6 text-[1.9vh] font-bold text-[#00e2e5]"
      >
        Cart
        <span className="grid h-[3vh] min-w-[3vh] place-items-center rounded-full bg-[#00e2e5] px-1 text-[1.6vh] font-bold text-[#04252b] tabular-nums">
          {session.items.length}
        </span>
      </button>
    </div>
  );

  const chrome = (children: React.ReactNode) => (
    <div className="relative flex h-screen flex-col overflow-hidden bg-[#000418]">
      <div ref={contentRef} className="kiosk-scroll min-h-0 flex-1 pb-[9vh]">
        {children}
      </div>
      {utilityStrip}
      <IdleWatcher
        timeoutMs={checkoutActive ? IDLE_CHECKOUT_MS : IDLE_FLOW_MS}
        paused={bookingHeats || stepBusy || resetting}
        onReset={() => void handleStartOver()}
      />
      {resetting && <BrandedLoaderOverlay brand={config.brand} label="Clearing this session…" />}
      {reservationExpired && hasActiveHold && (
        <ReservationExpiredModal onExtend={handleExtendReservation} onStartOver={handleStartOver} />
      )}
    </div>
  );

  // ── Checkout ──
  if (checkoutActive) {
    return chrome(
      <div className="mx-auto max-w-4xl px-4 py-8">
        <CheckoutStep
          session={session}
          dispatch={dispatch}
          onBack={() => setCheckoutActive(false)}
          onStartOver={handleStartOver}
          // Stay inside the kiosk shell after payment — the web confirmation
          // URL rides along so the kiosk confirmation can surface its code.
          navigate={(url) => {
            window.location.href = `/kiosk/confirmation?src=${encodeURIComponent(url)}`;
          }}
          // Shared public device: never show or store anyone's card.
          allowCardVault={false}
          storageKey={KIOSK_SESSION_STORAGE_KEY}
          // Card-present: when a reader is configured, capture on it (SAVE_CARD)
          // instead of the typed-card iframe. Manual entry when unset.
          readerDeviceId={
            config.cardInputMethod === "reader" || config.cardInputMethod === "swipe"
              ? (config.readerId ?? null)
              : null
          }
        />
      </div>,
    );
  }

  // ── Cart ──
  if (cartActive || (!activeItem && session.items.length > 0)) {
    return chrome(
      <CartView
        session={session}
        urlCode={null}
        onEditItem={(id) => {
          setCartActive(false);
          dispatch({ type: "setActiveItem", id });
        }}
        onRemoveItem={handleRemoveItem}
        onRemoveHeat={handleRemoveHeat}
        onCheckout={() => {
          setCartActive(false);
          setCheckoutActive(true);
        }}
        onNewBooking={handleStartOver}
        onRemoveCombo={session.comboSpecialId ? handleRemoveCombo : undefined}
      />,
    );
  }

  // ── Game Zone (multi-card token reload — its own money rail, not booking) ──
  if (gzOpen) {
    return chrome(
      <KioskGameZone center={config.center} brand={config.brand} onExit={() => setGzOpen(false)} />,
    );
  }

  // ── Category chooser (no active item) ──
  if (!activeItem) {
    return chrome(
      <KioskCategories
        brand={config.brand}
        center={config.center}
        session={session}
        onPickOffering={pickOffering}
        onPickCombo={pickCombo}
        onOpenCart={() => setCartActive(true)}
        onOpenGameZone={() => setGzOpen(true)}
      />,
    );
  }

  // ── Wizard ──
  const steps = KIOSK_STEP_REGISTRY[activeItem.kind].filter((s) =>
    s.isVisible(activeItem, session),
  );
  const rawCursor = session.cursors[activeItem.id] ?? 0;
  const stepIndex = Math.min(rawCursor, Math.max(0, steps.length - 1));
  const currentStep = steps[stepIndex] as StepDef | undefined;
  const isLastStep = stepIndex >= steps.length - 1;

  if (!currentStep) {
    // Shouldn't happen (registry always has ≥1 visible step) — fall back to cart.
    setCartActive(true);
    return chrome(null);
  }

  const canAdvance = currentStep.canAdvance(activeItem, session);
  const advanceOk = canAdvance === true;

  const advanceToNextStep = () => {
    if (isLastStep) {
      // Kiosk rule: adding an item returns to the CATEGORY chooser for easy
      // multi-add (owner decision) — never a web navigation.
      dispatch({ type: "setActiveItem", id: null });
      return;
    }
    let target = stepIndex + 1;
    while (
      target < steps.length - 1 &&
      steps[target].id === "contact" &&
      cartAlreadyHasContact(activeItem.id)
    ) {
      target += 1;
    }
    dispatch(target === stepIndex + 1 ? { type: "next" } : { type: "goto", index: target });
  };

  const handleNext = async () => {
    if (stepBusy) return;
    setKioskError(null);

    if (
      currentStep.id === "race-party" &&
      activeItem.kind === "race" &&
      session.party.some((m) => m.isNewRacer)
    ) {
      setShowHeightConfirm(true);
      return;
    }

    if (
      (currentStep.id === "race-heat-adult" || currentStep.id === "race-heat-junior") &&
      activeItem.kind === "race"
    ) {
      const raceItem = activeItem as RaceItem;
      const hasUnbooked = raceItem.heats.some((h) => h.heatId && !h.bmiLineId);
      if (hasUnbooked) {
        setBookingHeatsProgress("Reserving your heats…");
        setBookingHeats(true);
      }
      try {
        await bookHeatsOnAdvance(session, raceItem, dispatch, setBookingHeatsProgress);
        advanceToNextStep();
      } catch (err) {
        setKioskError(
          err instanceof Error
            ? `Couldn't reserve those heats: ${err.message}`
            : "Couldn't reserve those heats. Please try again.",
        );
      } finally {
        setBookingHeats(false);
      }
      return;
    }

    if (currentStep.id === "combo-itinerary" && activeItem.kind === "race") {
      const raceItem = activeItem as RaceItem;
      setBookingHeatsProgress("Reserving your races…");
      setBookingHeats(true);
      try {
        await bookHeatsOnAdvance(session, raceItem, dispatch, setBookingHeatsProgress);
        const bowlingItem = session.items.find((i) => i.kind === "bowling") as
          | BowlingItem
          | undefined;
        if (bowlingItem && !bowlingItem.qamfReservationId) {
          setBookingHeatsProgress("Holding your bowling lane…");
          const centerId = bowlingItem.qamfCenterId ?? qamfCenterIdForCode(session.center) ?? 9172;
          const qamfReservationId = await holdComboBowling({
            session,
            item: bowlingItem,
            centerId,
          });
          dispatch({
            type: "setBowlingHold",
            itemId: bowlingItem.id,
            qamfReservationId,
            qamfCenterId: centerId,
          });
        }
        advanceToNextStep();
      } catch (err) {
        setKioskError(
          err instanceof Error
            ? `Couldn't lock in your schedule: ${err.message}`
            : "Couldn't lock in your schedule. Please try again.",
        );
      } finally {
        setBookingHeats(false);
      }
      return;
    }

    if (currentStep.id === "attraction-slot" && activeItem.kind === "attraction") {
      const attractionItem = activeItem as AttractionItem;
      if (attractionItem.slotProposal && !attractionItem.bmiLineId) {
        setBookingHeatsProgress("Reserving your slot…");
        setBookingHeats(true);
        try {
          await bookAttractionOnAdvance(session, attractionItem, dispatch);
          advanceToNextStep();
        } catch (err) {
          setKioskError(
            err instanceof Error
              ? `Couldn't reserve that time: ${err.message}`
              : "Couldn't reserve that time. Please try again.",
          );
        } finally {
          setBookingHeats(false);
        }
        return;
      }
    }

    advanceToNextStep();
  };

  // ── Pit Crew variant: photo backdrop + left progress rail + question-style
  // header over the SAME shared step components (presentation-only diff).
  const isPitcrew = config.variant === "pitcrew";
  const backdropPhoto = (() => {
    if (activeItem.kind === "race") return KIOSK_PHOTOS.race;
    if (activeItem.kind === "bowling") return KIOSK_PHOTOS.bowl;
    if (activeItem.kind === "kbf") return KIOSK_PHOTOS.kbf;
    const slug = (activeItem as AttractionItem).slug ?? "";
    if (slug === "gel-blaster") return KIOSK_PHOTOS.gel;
    if (slug === "laser-tag") return KIOSK_PHOTOS.laser;
    if (slug === "duck-pin") return KIOSK_PHOTOS.duck;
    if (slug === "shuffly") return KIOSK_PHOTOS.shuf;
    return KIOSK_PHOTOS.race;
  })();

  return chrome(
    <div className={`relative mx-auto max-w-4xl px-4 pb-8 ${isPitcrew ? "pl-16" : ""}`}>
      {isPitcrew && (
        <>
          {/* Blurred activity photo backdrop (fixed, behind everything) */}
          <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden="true">
            <div
              className="absolute -inset-[4%] bg-cover bg-center [filter:blur(7px)_saturate(0.6)_brightness(0.55)]"
              style={{ backgroundImage: `url(${backdropPhoto})` }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#000418] from-[22%] via-[#000418]/90 to-[#020a22]/80" />
          </div>
          {/* Left progress rail */}
          <div className="pointer-events-none fixed bottom-[12vh] left-4 top-[16vh] z-20 flex w-8 flex-col items-center">
            <div className="relative w-1.5 flex-1 rounded-full bg-white/10">
              <div
                className="absolute inset-x-0 top-0 rounded-full bg-[#00e2e5] shadow-[0_0_14px_rgba(0,226,229,0.5)]"
                style={{ height: `${((stepIndex + 1) / steps.length) * 100}%` }}
              />
            </div>
          </div>
        </>
      )}
      {/* Kiosk step header: progress segments + hold timer */}
      <div className="sticky top-0 z-30 -mx-4 border-b border-white/10 bg-[#000418]/95 px-4 pb-3 pt-5 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() =>
              session.items.length > 1
                ? dispatch({ type: "setActiveItem", id: null })
                : void handleStartOver()
            }
            className="font-heading rounded-full border border-white/15 px-5 py-2.5 text-sm font-bold uppercase tracking-widest text-white/60"
          >
            {session.items.length > 1 ? "‹ Cart" : "‹ Activities"}
          </button>
          <div className="font-heading text-sm font-bold uppercase tracking-[0.2em] text-white/45">
            Step {stepIndex + 1} of {steps.length} · {currentStep.title}
          </div>
          <ReservationTimer
            ref={timerRef}
            bmiBillId={session.bmiBillId}
            qamfHoldId={qamfHoldId}
            qamfCenterId={qamfCenterId}
            onExpired={handleReservationExpired}
          />
        </div>
        <div className="mt-3 flex gap-2">
          {steps.map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 flex-1 rounded-full ${i <= stepIndex ? "bg-[#00e2e5]" : "bg-white/10"}`}
            />
          ))}
        </div>
      </div>

      {isPitcrew && (
        <div className="font-heading pt-8 text-6xl font-extrabold italic leading-none">
          {currentStep.title}.
        </div>
      )}
      <div className="kiosk-step-content pt-6">
        <currentStep.Component
          item={activeItem}
          session={session}
          onChange={(patch) => dispatch({ type: "updateItem", id: activeItem.id, patch })}
          dispatch={dispatch}
          setBusy={setStepBusy}
        />
      </div>

      {kioskError && (
        <div className="mt-6 rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-5 text-lg text-red-100">
          {kioskError}
        </div>
      )}

      {bookingHeats && (
        <div className="mt-6 flex items-center justify-center gap-3 rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-6">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
          <span className="text-sm font-medium text-white/80">{bookingHeatsProgress}</span>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => {
            if (stepIndex === 0) {
              if (session.items.length > 1) dispatch({ type: "setActiveItem", id: null });
              else void handleStartOver();
            } else {
              dispatch({ type: "back" });
            }
          }}
          className="font-heading h-16 rounded-full border-2 border-white/15 px-10 text-lg font-bold uppercase tracking-widest text-white/65"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => void handleNext()}
          disabled={!advanceOk || bookingHeats || stepBusy}
          title={
            bookingHeats || stepBusy
              ? "Holding your spot…"
              : advanceOk
                ? undefined
                : canAdvance.reason
          }
          className="font-heading h-16 flex-1 rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic tracking-wide text-[#04252b] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLastStep ? "Add to my visit" : "Next"}
        </button>
      </div>
      {!advanceOk && typeof canAdvance === "object" && (
        <p className="mt-3 text-center text-base text-white/45">{canAdvance.reason}</p>
      )}

      {showHeightConfirm && (
        <HeightAgeConfirmModal
          adults={
            session.party.filter((m) => (m.category ?? "adult") === "adult" && m.isNewRacer).length
          }
          juniors={session.party.filter((m) => m.category === "junior" && m.isNewRacer).length}
          onConfirm={() => {
            setShowHeightConfirm(false);
            advanceToNextStep();
          }}
          onChangeParty={() => setShowHeightConfirm(false)}
        />
      )}
    </div>,
  );
}
