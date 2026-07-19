"use client";

/**
 * Kiosk booking flow orchestrator — the kiosk-shaped sibling of
 * components/features/booking/BookingFlow.tsx.
 *
 * Reused UNCHANGED: the booking session model + reducer, every service
 * (eager BMI heat holds, attraction slot booking, combo itinerary + QAMF
 * lane hold, checkout/reserve), useReservationHold/ExpiredModal, CartView,
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
  type PartyMember,
  type RaceItem,
  type SessionItem,
  type StepDef,
} from "~/features/booking";
import { clearBookingSession, usePersistedReducer } from "~/features/booking/hooks";
import { resetToKiosk } from "../version";
import { CartView } from "~/components/features/booking/CartView";
import { CheckoutStep } from "~/components/features/booking/steps/checkout/CheckoutStep";
import { HeightAgeConfirmModal } from "~/components/features/booking/steps/race/HeightAgeConfirmModal";
import { type ReservationTimerHandle } from "~/components/features/booking/ReservationTimer";
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
import { useKioskConfig } from "../KioskConfigContext";
import { gameZoneCapability } from "../config";
import {
  KIOSK_SCHEMA_VERSION,
  KIOSK_SESSION_STORAGE_KEY,
  KIOSK_STEP_REGISTRY,
} from "../state/registry";
import { KioskCategories } from "./KioskCategories";
import { KioskHoldBar } from "./KioskHoldBar";
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

/** Short cart labels for the session banner. */
function itemLabel(kind: string): string {
  if (kind === "race") return "Racing";
  if (kind === "bowling") return "Bowling";
  if (kind === "kbf") return "Kids Bowl Free";
  return "Attraction";
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
  // True while the Game Zone dispenser is mid-operation/holding — pauses the
  // idle watchdog so a guest isn't reset mid-dispense or during a fault hold.
  const [gzBusy, setGzBusy] = useState(false);
  const [vipCombo, setVipCombo] = useState<ComboSpecial | null>(null);
  const [stepBusy, setStepBusy] = useState(false);
  const [bookingHeats, setBookingHeats] = useState(false);
  const [bookingHeatsProgress, setBookingHeatsProgress] = useState("Holding your spot…");
  const [kioskError, setKioskError] = useState<string | null>(null);
  const [showHeightConfirm, setShowHeightConfirm] = useState(false);
  // Mixed-tier guard (owner 2026-07-18): guests in the category with NO heat
  // assigned when Continue is tapped on a heat step — the flow used to advance
  // silently with them dropped (e.g. the Starter-level racer crossed out of an
  // Intermediate heat). The sheet offers the add-another-race loop or an
  // explicit "not racing" opt-out.
  const [unraceredPrompt, setUnraceredPrompt] = useState<{
    category: "adult" | "junior";
    members: PartyMember[];
  } | null>(null);
  const [reservationExpired, setReservationExpired] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Guest assistance (owner 2026-07-18): flashes the whole screen red as a
  // staff beacon and HOLDS the kiosk exactly where it is (idle reset paused)
  // until Clear is tapped.
  const [assistActive, setAssistActive] = useState(false);
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
  // Bar only while something is actually held: releaseItemBmiLines never clears
  // session.bmiBillId, so an emptied cart still has a (now line-less) bill id —
  // without the items gate the countdown would show over the category chooser.
  const showHoldBar = hasActiveHold && session.items.length > 0;

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

  /** True when anything in the cart holds real vendor state — a booked BMI
   *  line (race heat / attraction slot) or a QAMF lane hold. Everything else
   *  is a local draft the guest merely started and backed out of. */
  const cartHasVendorHolds = (): boolean =>
    session.items.some((i) => {
      if (i.kind === "race") return i.heats.some((h) => !!h.bmiLineId);
      if (i.kind === "attraction") return !!(i as AttractionItem).bmiLineId;
      if (i.kind === "bowling") return !!(i as BowlingItem).qamfReservationId;
      return false; // kbf holds nothing until checkout
    });

  /** Drop every DRAFT item so a new pick starts clean — owner 2026-07-18:
   *  "shouldn't we just remove any unfinished flows from cart?" (a guest who
   *  backed out of a half-built VIP was locked out of plain racing by its
   *  leftovers). Only called when cartHasVendorHolds() is false, so this is
   *  pure state surgery — nothing anywhere to release. */
  const clearUnfinishedCart = () => {
    for (const i of session.items) dispatch({ type: "removeItem", id: i.id });
    if (session.comboSpecialId) dispatch({ type: "setComboSpecial", id: null });
    // A stale preferred package would silently re-seed itself onto the next
    // race item (the variant-resolve effect above keys off it).
    if (session.preferredPackageId) dispatch({ type: "setPreferredPackage", id: null });
  };

  const pickOffering = (offering: ActivityOffering) => {
    // A bundle owns its race + bowling legs: the individual tiles used to
    // RE-OPEN those seeded items (racing re-entered the combo wizard, bowling
    // has no visible steps → dead cart bounce) — "gets all messed up" (owner
    // 2026-07-18). Racing is covered by the bundle outright. A SECOND lane for
    // extra guests is a real ask (owner: "don't block it") — until the second
    // lane can live in the same cart (needs the combo pricing collapse to
    // ignore it — separate verified change), steer to a follow-on booking.
    // Independent attractions (gel/laser/duckpin/shuffleboard) stay available.
    // An UNFINISHED bundle (nothing actually held with a vendor) doesn't block
    // anything: drop the leftovers and start the tapped activity clean.
    if (session.comboSpecialId && offering.kind === "race") {
      if (!cartHasVendorHolds()) {
        clearUnfinishedCart();
        dispatch({ type: "addItem", item: stampToday(newItem("race")) });
        return;
      }
      setKioskError(
        "Your Ultimate VIP experience already includes racing — it's all in one price.",
      );
      return;
    }
    if (session.comboSpecialId && (offering.kind === "bowling" || offering.kind === "kbf")) {
      if (!cartHasVendorHolds()) {
        clearUnfinishedCart();
        dispatch({ type: "addItem", item: stampToday(newItem(offering.kind)) });
        return;
      }
      setKioskError(
        "Your Ultimate VIP includes a VIP lane. To add a separate lane for extra guests, finish this checkout first, then book bowling as its own order — takes under a minute.",
      );
      return;
    }
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
    // Re-entry: tapping the tile, backing out, then tapping it again used to
    // dead-end ("finish or remove…") because the draft race item was already in
    // the cart (owner 2026-07-18: "you cannot click it again"). If the cart is
    // JUST that same preseeded draft, re-open it instead of erroring.
    const existingRace = session.items.find((i) => i.kind === "race");
    if (existingRace && session.items.length === 1 && session.preferredPackageId === family) {
      dispatch({ type: "setActiveItem", id: existingRace.id });
      return;
    }
    if (session.items.length > 0) {
      if (cartHasVendorHolds()) {
        setKioskError(
          "Finish or remove your current activities before starting a premium racing experience.",
        );
        return;
      }
      // Drafts only — clear the leftovers and proceed (owner 2026-07-18).
      clearUnfinishedCart();
    }
    dispatch({ type: "setPreferredPackage", id: family });
    const item = stampToday(newItem("race"));
    dispatch({ type: "addItem", item });
    dispatch({ type: "setActiveItem", id: item.id });
  };

  // Show the itinerary overview first (owner: the approved VIP overview screen).
  const pickCombo = (combo: ComboSpecial) => {
    // Re-entry: this combo is already seeded in the cart (guest backed out
    // mid-flow) — re-open its race item instead of dead-ending on the error.
    if (session.comboSpecialId === combo.id) {
      const race = session.items.find((i) => i.kind === "race");
      if (race) {
        dispatch({ type: "setActiveItem", id: race.id });
        return;
      }
    }
    if (session.items.length > 0) {
      if (cartHasVendorHolds()) {
        setKioskError(
          "Finish or remove your current activities before adding a bundled experience.",
        );
        return;
      }
      // Drafts only — clear the leftovers and proceed (owner 2026-07-18).
      clearUnfinishedCart();
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
    if (wasLast) {
      // Cards can't ride an empty cart (they pay with the booking deposit) —
      // clear them too; the guest can buy them standalone from Game Zone.
      if (session.gameCardPurchase) dispatch({ type: "setGameCardPurchase", purchase: null });
      setCartActive(false);
    }
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

  // Game Zone cards count as a cart entry (owner 2026-07-18: race + cards
  // showed "1 item") — they're paid at the same checkout, so the pill/banner
  // must reflect them.
  const cartCount = session.items.length + (session.gameCardPurchase?.cards.length ? 1 : 0);
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
      <button
        type="button"
        onClick={() => setAssistActive(true)}
        className="k-util-btn k-tap"
        style={{ borderColor: "rgba(239,68,68,0.5)", color: "#fca5a5" }}
      >
        Guest assistance
      </button>
      <div className="k-util-help">A team member can help — tap Guest assistance</div>
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

  // Session banner (owner 2026-07-18: "make it more clear when someone is
  // logged into account and has open cart"): slim persistent strip on every
  // kiosk screen while a guest session is live — who's signed in + what's in
  // the cart, tap → cart. Hidden on the cart/checkout screens themselves
  // (navigating away mid-payment would be risky, and it's redundant there).
  const mainGuest = session.party.find((m) => m.isBillingCustomer) ?? session.party[0];
  const hasGameCards = !!session.gameCardPurchase?.cards.length;
  const sessionBanner =
    (session.party.length > 0 || cartCount > 0 || hasGameCards) &&
    !cartActive &&
    !checkoutActive ? (
      <button
        type="button"
        onClick={openCart}
        disabled={cartCount === 0}
        className="k-glass k-tap mx-[48px] mt-[20px] flex shrink-0 items-center justify-between gap-[20px] px-[28px] py-[16px] text-left"
      >
        <span className="flex min-w-0 items-center gap-[14px] text-[24px] text-white/75">
          <span
            className="h-[14px] w-[14px] shrink-0 rounded-full bg-[#46d68c]"
            aria-hidden="true"
          />
          {mainGuest ? (
            <span className="truncate">
              Signed in · <strong className="text-white">{mainGuest.firstName}</strong>
              {session.party.length > 1
                ? ` + ${session.party.length - 1} guest${session.party.length > 2 ? "s" : ""}`
                : ""}
            </span>
          ) : (
            <span className="truncate">Visit in progress</span>
          )}
        </span>
        {(cartCount > 0 || hasGameCards) && (
          <span className="shrink-0 text-[24px] font-bold text-[#00e2e5]">
            {[
              ...session.items.map((i) => itemLabel(i.kind)),
              ...(hasGameCards ? ["Game cards"] : []),
            ].join(" · ")}{" "}
            · View cart ›
          </span>
        )}
      </button>
    ) : null;

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
      <div className="relative z-[2] flex min-h-0 flex-1 flex-col">
        {showHoldBar && (
          <KioskHoldBar
            ref={timerRef}
            bmiBillId={session.bmiBillId}
            qamfHoldId={qamfHoldId}
            qamfCenterId={qamfCenterId}
            onExpired={handleReservationExpired}
          />
        )}
        {sessionBanner}
        {children}
      </div>
      {utilityStrip}
      <IdleWatcher
        timeoutMs={checkoutActive ? IDLE_CHECKOUT_MS : IDLE_FLOW_MS}
        paused={bookingHeats || stepBusy || resetting || assistActive || gzBusy}
        onReset={() => void handleStartOver()}
      />
      {assistActive && (
        <div className="k-assist-overlay">
          <div className="k-display text-[110px] leading-none text-white">Help is on the way</div>
          <p className="max-w-[26ch] text-[34px] font-semibold text-white/90">
            Stay right here — a team member is coming to assist you. Your booking is held exactly
            where you left it.
          </p>
          <button
            type="button"
            onClick={() => setAssistActive(false)}
            className="k-tap h-[112px] rounded-full border-4 border-white bg-white/10 px-[72px] text-[36px] font-extrabold uppercase tracking-widest text-white"
          >
            All set — clear
          </button>
        </div>
      )}
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
          // "← All activities" goes straight to the category chooser, cart kept
          // (owner 2026-07-18: the web leave-confirm modal's buttons were dead
          // on the kiosk — its "Add more activities" is a blocked web link).
          onAllActivities={() => {
            setCartActive(false);
            dispatch({ type: "setActiveItem", id: null });
          }}
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
          onRemoveGameCards={
            session.gameCardPurchase
              ? () => dispatch({ type: "setGameCardPurchase", purchase: null })
              : undefined
          }
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
          onBusyChange={setGzBusy}
          // With activities in the cart, cards JOIN the booking (owner
          // 2026-07-18) — one payment at the shared checkout, fulfillment on
          // the confirmation screen.
          cartHasItems={session.items.length > 0}
          onAddToVisit={(purchase) => {
            dispatch({ type: "setGameCardPurchase", purchase });
            setGzOpen(false);
          }}
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

  // Combo: the schedule-confirm modal books the races + lane and self-advances
  // (dispatch "next"). With the redundant "Your Schedule" review dropped from the
  // kiosk registry (owner 2026-07-18: "shouldn't exist — just return to main
  // menu"), that advance lands the cursor past the last visible step. Treat it as
  // combo-flow-complete: normalize the cursor (so a later cart Edit reopens the
  // time picker) and return to the category chooser. Render-phase update — same
  // pattern as the !currentStep fallback below. Non-combo items keep the clamp.
  if (
    session.comboSpecialId &&
    activeItem.kind === "race" &&
    steps.length > 0 &&
    rawCursor >= steps.length
  ) {
    dispatch({ type: "goto", index: steps.length - 1 });
    dispatch({ type: "setActiveItem", id: null });
    return chrome(null);
  }

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

  /** Book the picked (unbooked) heats with BMI, then advance — shared by the
   *  normal heat-step Continue and the unracered-sheet "continue anyway". */
  const bookHeatsAndAdvance = async (raceItem: RaceItem) => {
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
  };

  /** Unracered sheet → "Add a race for X": the exact add-another-race loop the
   *  heat picker offers — clear the category's product (fresh pick), back to the
   *  product step. Picked heats persist on item.heats and accumulate. */
  const addRaceForUnracered = () => {
    if (!unraceredPrompt || !activeItem || activeItem.kind !== "race") return;
    const patch =
      unraceredPrompt.category === "adult"
        ? { productIdAdult: null, productTrackAdult: null }
        : { productIdJunior: null, productTrackJunior: null };
    dispatch({ type: "updateItem", id: activeItem.id, patch: patch as Partial<SessionItem> });
    dispatch({ type: "back" });
    setUnraceredPrompt(null);
  };

  /** Unracered sheet → explicit "they're not racing" opt-out (spectators are
   *  legitimate) — book what's picked and move on. */
  const continueWithoutUnracered = async () => {
    if (!activeItem || activeItem.kind !== "race") return;
    setUnraceredPrompt(null);
    await bookHeatsAndAdvance(activeItem as RaceItem);
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
      // Mixed-tier guard (owner 2026-07-18): the product step offers the tier the
      // HIGHEST racer earned, so a lower-tier guest gets crossed out of the heat
      // and the flow used to advance with them silently dropped. Never advance
      // past a guest with no race — offer the add-another-race loop (the path
      // back the guest "couldn't find") or an explicit not-racing opt-out.
      // Packages own their race selections, so they're exempt.
      if (!raceItem.packageId) {
        const category = currentStep.id === "race-heat-adult" ? "adult" : "junior";
        const assigned = new Set(
          raceItem.heats.filter((h) => h.heatId && h.assignedTo).map((h) => h.assignedTo),
        );
        const unracered = session.party.filter(
          (m) => (m.category ?? "adult") === category && !assigned.has(m.id),
        );
        if (unracered.length > 0 && raceItem.heats.some((h) => h.heatId)) {
          setUnraceredPrompt({ category, members: unracered });
          return;
        }
      }
      await bookHeatsAndAdvance(raceItem);
      return;
    }

    // (combo-itinerary advance branch removed — the step is dropped from the
    // kiosk registry; the schedule-confirm modal is the ONE place a combo books,
    // and the overflow redirect above returns the guest to the main menu.)

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

      {/* Mixed-tier guard: someone in this category has no race yet — make the
          add-another-race path obvious instead of silently dropping them. */}
      {unraceredPrompt && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
          <div className="k-glass w-full max-w-[860px] space-y-[24px] p-[44px]">
            <div className="k-eyebrow text-[#f0b341]">Before you continue</div>
            <div className="k-display text-[46px] leading-[1.05]">
              {unraceredPrompt.members.map((m) => m.firstName).join(" & ")}{" "}
              {unraceredPrompt.members.length === 1 ? "isn't" : "aren't"} in a race yet
            </div>
            <p className="text-[26px] leading-snug text-white/60">
              This race is above their level or they weren&rsquo;t added to a heat. Add a race that
              fits them — your picked heats are saved — or continue without racing them.
            </p>
            <div className="flex flex-col gap-[16px] pt-[4px]">
              {/* k-btn-primary's flex:1 squashes its height in this column
                  layout (the ghost keeps its full 112px, so the pair rendered
                  uneven — owner 2026-07-18 "make buttons even"). Inline style
                  because the unlayered .kiosk-canvas rules out-cascade Tailwind
                  utilities. */}
              <button
                type="button"
                onClick={addRaceForUnracered}
                className="k-btn-primary k-tap"
                style={{ flex: "0 0 auto" }}
              >
                Add a race for {unraceredPrompt.members.map((m) => m.firstName).join(" & ")}
              </button>
              <button
                type="button"
                onClick={() => void continueWithoutUnracered()}
                className="k-btn-ghost k-tap"
                style={{ flex: "0 0 auto" }}
              >
                Not racing today — continue
              </button>
            </div>
          </div>
        </div>
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

      {/* Booking the picked heats/slot takes real vendor seconds — and for race
          PACKAGES the picker re-mounts its GRID beneath (once every heat carries
          a bmiLineId, the "already picked" gate flips back to the grid), which
          read as "it sent me back to the race screen for ~10 seconds" (owner
          2026-07-18, Ultimate Qualifier). Cover the step until the advance
          lands — bookingHeats stays true through advanceToNextStep. */}
      {bookingHeats &&
        (currentStep.id === "race-heat-adult" ||
          currentStep.id === "race-heat-junior" ||
          currentStep.id === "attraction-slot") && (
          <BrandedLoaderOverlay
            brand={config.brand}
            label={activeItem.kind === "race" ? "Locking in your races" : "Reserving your time"}
            sublabel={bookingHeatsProgress || "One moment…"}
          />
        )}
    </>,
    backdropPhoto,
  );
}
