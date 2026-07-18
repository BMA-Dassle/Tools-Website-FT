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
import { resetToKiosk } from "../version";
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
import { eligiblePackages, scheduleForDate } from "@/lib/packages";
import { holdComboBowling } from "~/features/combos/combo-booking";
import { qamfCenterIdForCode } from "~/features/booking/types";
import { useKioskConfig } from "../KioskConfigContext";
import { gameZoneCapability } from "../config";
import {
  KIOSK_SCHEMA_VERSION,
  KIOSK_SESSION_STORAGE_KEY,
  KIOSK_STEP_REGISTRY,
} from "../state/registry";
import { KioskCategories } from "./KioskCategories";
import { KioskVipOverview } from "./KioskVipOverview";
import { KioskGameZone } from "./KioskGameZone";
import { IdleWatcher } from "./IdleWatcher";
import { BrandedLoader, BrandedLoaderOverlay } from "./BrandedLoader";
import { todayYmd } from "../service/first-available";
import { KIOSK_PHOTOS, KIOSK_LOGOS } from "../assets";

/** Walk-up device: every dated item starts on today (kiosk drops date steps). */
function stampToday(item: SessionItem): SessionItem {
  if (item.kind === "race" || item.kind === "attraction") {
    return { ...item, date: todayYmd() };
  }
  return item;
}

const IDLE_FLOW_MS = 120_000;
const IDLE_CHECKOUT_MS = 180_000;

/** Kiosk-native steps are already authored at canvas px. Every OTHER (reused web)
 *  wizard step is web-rem-sized and reads small on the 1080px canvas, so it gets
 *  the Chromium `zoom` bump to fit the kiosk theme (see .kiosk-zoom). */
const NATIVE_STEP_IDS = new Set([
  "race-party",
  "kiosk-who",
  "attraction-slot",
  "bowling-slots",
  "bowling-tier",
  "kiosk-bowling-details",
  "kiosk-bowling-people",
]);

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
  const [vipCombo, setVipCombo] = useState<ComboSpecial | null>(null);
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
          setVipCombo(combo); // show the itinerary overview first
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

  /** Release every vendor hold, wipe the guest session + PII, back to attract.
   *  Soft-navigate (NOT window.location) so the fullscreen the guest engaged
   *  survives — a hard reload drops fullscreen and the browser won't re-enter
   *  without a fresh tap (the "Start Over loses fullscreen" bug). State is
   *  still clean between guests: KioskFlow unmounts on the route change and the
   *  reducer re-inits from the sessionStorage we just cleared. */
  const handleStartOver = useCallback(async () => {
    setResetting(true);
    try {
      await abandonBooking(session);
    } catch {
      /* best-effort — BMI bills self-expire in ~20 min as the backstop */
    }
    clearBookingSession(KIOSK_SESSION_STORAGE_KEY);
    // Self-update between guests: if a newer deploy is live, hard-reload to load
    // it (fullscreen re-engages on the first attract tap); otherwise soft-nav so
    // the engaged fullscreen survives. Owner 2026-07-19: no more close+reopen.
    await resetToKiosk(() => router.replace("/kiosk"));
  }, [session, router]);

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

  // Preselect the tapped Experiences package once the party is known, so the
  // product step can skip. MUST stay above the early return below (hook order).
  // SAFE by construction: resolves via the SAME eligiblePackages() the product
  // step uses (never a package the step wouldn't offer), and ONLY when the party
  // is uniform + all-new with exactly one eligible variant. Any other case
  // (returning racer, mixed adult+junior, no/multiple variants) leaves packageId
  // unset → the product step shows normally.
  useEffect(() => {
    const preferred = session.preferredPackageId;
    if (!preferred) return;
    const race = session.items.find((i) => i.kind === "race") as
      | (SessionItem & { packageId?: string; date?: string })
      | undefined;
    if (!race || race.packageId || !race.date) return;
    const party = session.party;
    if (party.length === 0) return; // wait for the party step
    if (party.some((m) => !m.isNewRacer)) return; // packages are new-racer-only
    const cats = new Set(party.map((m) => m.category ?? "adult"));
    if (cats.size !== 1) return; // mixed adult+junior → let the product step handle it
    const category = [...cats][0] as "adult" | "junior";
    const variants = eligiblePackages({
      racerType: "new",
      schedule: scheduleForDate(race.date),
      category,
    }).filter((p) => p.id.startsWith(preferred));
    if (variants.length === 1) {
      dispatch({
        type: "updateItem",
        id: race.id,
        patch: { packageId: variants[0].id } as Partial<SessionItem>,
      });
    }
  }, [session.preferredPackageId, session.party, session.items, dispatch]);

  if (!hydrated || !config) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
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

  // Experiences → a premium racing PACKAGE tile (Ultimate Qualifier): start a
  // fresh race session with that package family preselected so the product step
  // is skipped (owner: don't make them reselect what they just tapped). The
  // actual variant is resolved after the party is set (see the effect below).
  const pickPackageExperience = (family: string) => {
    if (session.items.length > 0) {
      setKioskError(
        "Finish or remove your current activities before starting a premium racing experience.",
      );
      return;
    }
    dispatch({ type: "setPreferredPackage", id: family });
    const item = stampToday(newItem("race"));
    dispatch({ type: "addItem", item });
    dispatch({ type: "setActiveItem", id: item.id });
  };

  // Show the itinerary overview first (owner: the approved VIP overview screen).
  const pickCombo = (combo: ComboSpecial) => {
    if (session.items.length > 0) {
      setKioskError("Finish or remove your current activities before adding a bundled experience.");
      return;
    }
    setVipCombo(combo);
  };

  // "Let's set it up" from the overview — seed the combo items + enter the flow.
  const startCombo = (combo: ComboSpecial) => {
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
    setVipCombo(null);
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

  const cartCount = session.items.length;
  const openCart = () => {
    setCheckoutActive(false);
    setCartActive(true);
    dispatch({ type: "setActiveItem", id: null });
  };

  // Podium utility strip — pinned bottom zone (Start over · help · cart pill).
  const utilityStrip = (
    <div className="k-z-util">
      <button type="button" onClick={() => void handleStartOver()} className="k-util-btn k-tap">
        <svg
          className="h-[26px] w-[26px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
        Start over
      </button>
      <div className="k-util-help">Need help? A team member at the front desk can assist</div>
      {cartCount > 0 && (
        <button type="button" onClick={openCart} className="k-cart-pill k-tap">
          <svg
            className="h-[28px] w-[28px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="9" cy="20" r="1.4" />
            <circle cx="18" cy="20" r="1.4" />
            <path d="M2 3h3l2.4 12.4a1.6 1.6 0 0 0 1.6 1.3h8.2a1.6 1.6 0 0 0 1.6-1.3L22 7H6" />
          </svg>
          Cart
          <span className="k-cart-badge k-num">{cartCount}</span>
        </button>
      )}
    </div>
  );

  // Podium chrome — the fixed canvas as a flex column: optional full-bleed photo
  // backdrop (z0) · content region (z2) · pinned util strip · overlays.
  const chrome = (children: React.ReactNode, bg?: string | null) => (
    <div className="k-flow">
      {bg ? (
        <div
          // "wizard" = near-solid navy scrim so reused web step bodies (dark
          // cards) stay readable over the activity photo — the photo reads as a
          // faint texture; bright photography lives in the cards/heroes.
          className="k-flow-bg k-ph wizard"
          style={{ ["--k-img"]: `url(${bg})` } as React.CSSProperties}
          aria-hidden="true"
        />
      ) : null}
      <div className="relative z-[2] flex min-h-0 flex-1 flex-col">{children}</div>
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
      // Zoomed to kiosk scale like the other reused web screens. `zoom` scales
      // the Square card iframe like browser zoom (supported); the primary kiosk
      // path is the card-present reader (no iframe) anyway.
      <div ref={contentRef} className="k-flow-body kiosk-step-content kiosk-zoom">
        <CheckoutStep
          session={session}
          dispatch={dispatch}
          onBack={() => setCheckoutActive(false)}
          onStartOver={handleStartOver}
          // Stay inside the kiosk shell after payment — the web confirmation
          // URL rides along so the kiosk confirmation can surface its code.
          navigate={(url) => {
            router.replace(`/kiosk/confirmation?src=${encodeURIComponent(url)}`);
          }}
          // Shared public device: never show or store anyone's card.
          allowCardVault={false}
          // Wallets + loyalty happen at the Square reader, not on the kiosk.
          hideWallets
          hideRewards
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
  // Cart shows ONLY when explicitly opened (the cart pill). After adding an
  // activity we return to the CATEGORY chooser (the "main screen"), not the cart
  // (owner 2026-07-18) — the category chooser carries a "your visit so far" strip
  // to reach the cart.
  if (cartActive) {
    return chrome(
      <div ref={contentRef} className="k-flow-body kiosk-step-content kiosk-zoom">
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
        />
      </div>,
    );
  }

  // ── Game Zone (multi-card token reload — its own money rail, not booking) ──
  if (gzOpen) {
    return chrome(
      <div ref={contentRef} className="k-flow-body">
        <KioskGameZone
          center={config.center}
          brand={config.brand}
          capability={gameZoneCapability(config) === "reload" ? "reload" : "full"}
          onExit={() => setGzOpen(false)}
        />
      </div>,
      KIOSK_PHOTOS.arcade,
    );
  }

  // ── VIP / Experiences overview (itinerary before entering the combo flow) ──
  if (vipCombo && !activeItem) {
    return chrome(
      <KioskVipOverview
        combo={vipCombo}
        onStart={() => startCombo(vipCombo)}
        onBack={() => setVipCombo(null)}
      />,
      KIOSK_PHOTOS.vip,
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
        onPickPackageExperience={pickPackageExperience}
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

  // Full-bleed activity photo backdrop — Podium renders every step over its
  // activity photography with the house navy scrim.
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

  const activityLabel = (() => {
    if (activeItem.kind === "race") return "Racing";
    if (activeItem.kind === "bowling") return "Bowling";
    if (activeItem.kind === "kbf") return "Kids Bowl Free";
    const slug = (activeItem as AttractionItem).slug ?? "";
    return (
      (
        {
          "gel-blaster": "Gel Blaster",
          "laser-tag": "Laser Tag",
          "duck-pin": "Duckpin",
          shuffly: "Shuffleboard",
        } as Record<string, string>
      )[slug] ?? "Attraction"
    );
  })();

  const logo = KIOSK_LOGOS[config.brand === "headpinz" ? "headpinz" : "fasttrax"];
  const ctaLabel = isLastStep ? "Add to my visit" : "Continue";

  return chrome(
    <>
      {/* header zone: logo · activity · hold timer · progress · big title */}
      <div className="k-flow-head">
        <div className="k-fh-top">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} alt="" className="h-[60px] w-auto" />
          <div className="flex items-center gap-5">
            <span className="k-fh-activity">{activityLabel}</span>
            <ReservationTimer
              ref={timerRef}
              bmiBillId={session.bmiBillId}
              qamfHoldId={qamfHoldId}
              qamfCenterId={qamfCenterId}
              onExpired={handleReservationExpired}
            />
          </div>
        </div>
        <div className="k-prog">
          {steps.map((s, i) => (
            <span key={s.id} className={i <= stepIndex ? "done" : ""} />
          ))}
        </div>
        <div className="k-prog-label k-num">
          Step {stepIndex + 1} of {steps.length}
        </div>
        <h1 className="k-display k-fh-title">{currentStep.title}</h1>
      </div>

      {/* body scroll zone */}
      <div ref={contentRef} className="k-flow-body kiosk-step-content">
        {/* Reused web steps are web-rem-sized → zoom them up to the kiosk scale;
            kiosk-native steps are already canvas px, so they render unzoomed. */}
        <div className={NATIVE_STEP_IDS.has(currentStep.id) ? undefined : "kiosk-zoom"}>
          <currentStep.Component
            item={activeItem}
            session={session}
            onChange={(patch) => dispatch({ type: "updateItem", id: activeItem.id, patch })}
            dispatch={dispatch}
            setBusy={setStepBusy}
          />
        </div>

        {kioskError && (
          <div className="mt-8 rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-5 text-[26px] text-red-100">
            {kioskError}
          </div>
        )}

        {bookingHeats && (
          <div className="mt-8 flex items-center justify-center gap-4 rounded-2xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-6">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
            <span className="text-[26px] font-medium text-white/80">{bookingHeatsProgress}</span>
          </div>
        )}

        {!advanceOk && typeof canAdvance === "object" && (
          <p className="mt-6 text-center text-[24px] text-white/45">{canAdvance.reason}</p>
        )}
      </div>

      {/* pinned action zone */}
      <div className="k-z-actions">
        <button
          type="button"
          onClick={() => {
            if (stepIndex === 0) {
              // First step → back to the category chooser ("all activities"),
              // NOT a full Start Over (owner: couldn't get back to activities).
              // The draft item stays in the cart; Start Over (util strip) resets.
              dispatch({ type: "setActiveItem", id: null });
            } else {
              dispatch({ type: "back" });
            }
          }}
          className="k-btn-ghost k-tap"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => void handleNext()}
          disabled={!advanceOk || bookingHeats || stepBusy}
          className="k-btn-primary k-tap"
        >
          {ctaLabel}
        </button>
      </div>

      {showHeightConfirm && (
        <HeightAgeConfirmModal
          adults={
            session.party.filter((m) => (m.category ?? "adult") === "adult" && m.isNewRacer).length
          }
          juniors={session.party.filter((m) => m.category === "junior" && m.isNewRacer).length}
          // Kiosk = walk-up, always today — confirm requirements, then pick a TIME.
          subheading="Quick safety check — confirm each requirement, then pick your race time."
          confirmLabel="Confirm & continue →"
          onConfirm={() => {
            setShowHeightConfirm(false);
            advanceToNextStep();
          }}
          onChangeParty={() => setShowHeightConfirm(false)}
        />
      )}

      {/* Combo schedule confirm books BOTH races + holds the VIP lane — a real
          ~minute of vendor calls. Cover the heat grid with a clear branded
          "Booking…" overlay so it never reads as "stuck on the race screen"
          (owner 2026-07-18: "returned to the race selection for a minute"). */}
      {currentStep.id === "combo-start" && stepBusy && (
        <BrandedLoaderOverlay
          brand={config.brand}
          label="Booking your experience"
          sublabel="Reserving your races and holding your lane…"
        />
      )}
    </>,
    backdropPhoto,
  );
}
