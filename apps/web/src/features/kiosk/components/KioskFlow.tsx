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
import { useQueryClient } from "@tanstack/react-query";
import {
  bookingKeys,
  emptySession,
  getActiveItem,
  newItem,
  packageIdForCategory,
  racePackageIds,
  type ActivityOffering,
  type AttractionItem,
  type BowlingItem,
  type PartyMember,
  type RaceHeatAssignment,
  type RaceItem,
  type SessionItem,
  type StepDef,
} from "~/features/booking";
import { clearBookingSession, usePersistedReducer } from "~/features/booking/hooks";
import { fasttraxQamfDuckpinEnabled } from "~/features/booking/flags";
import { appendGrantedCredits } from "~/features/booking/data/race-credits";
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
import { getPackage } from "@/lib/packages";
import { resolvePreselectPatch } from "../service/package-preselect";
import {
  refreshQualifications,
  type QualificationPatch,
} from "../service/qualification-refresh-client";
import { useKioskConfig } from "../KioskConfigContext";
import { useLocale, type MessageKey } from "../i18n";
import { gameZoneCapability } from "../config";
import {
  kioskMergedCheckoutEnabled,
  kioskCheckoutUpsellEnabled,
  kioskGzCartEnabled,
  kioskTerminalEnabled,
} from "../flags";
import { KioskCheckoutScreen } from "./KioskCheckoutScreen";
import { KioskCheckoutUpsell } from "./KioskCheckoutUpsell";
import { TOKEN_PACKAGES } from "~/features/game-cards/constants";
import { clarityEvent, clarityTag } from "~/lib/clarity";
import {
  KIOSK_SCHEMA_VERSION,
  KIOSK_SESSION_STORAGE_KEY,
  KIOSK_STEP_REGISTRY,
} from "../state/registry";
import { KioskCategories } from "./KioskCategories";
import { useKioskAvailability } from "../hooks/useKioskAvailability";
import { KioskHoldBar } from "./KioskHoldBar";
import { KioskVipOverview } from "./KioskVipOverview";
import { KioskGameZone } from "./KioskGameZone";
import { KioskRacePackFlow } from "./KioskRacePackFlow";
import { kioskRacePacksEnabled } from "~/features/booking/service/race-pack-kiosk";
import { IdleWatcher } from "./IdleWatcher";
import { useMobileJoinStatus } from "../hooks/useMobileJoin";
import { closeMobileJoin } from "../join/kiosk-client";
import { BrandedLoader, BrandedLoaderOverlay } from "./BrandedLoader";
import { todayYmd } from "../service/first-available";
import { KIOSK_PHOTOS } from "../assets";
import { useResilientImages } from "../hooks/useResilientImage";
import { BrandLogo } from "./BrandLogo";

/** Every full-bleed backdrop photo `chrome`/`backdropPhoto` can show — preloaded
 *  and self-healed together so a flaky-WiFi failure never blanks a step. */
const KIOSK_BACKDROP_PHOTOS = [
  KIOSK_PHOTOS.race,
  KIOSK_PHOTOS.bowl,
  KIOSK_PHOTOS.kbf,
  KIOSK_PHOTOS.gel,
  KIOSK_PHOTOS.laser,
  KIOSK_PHOTOS.duck,
  KIOSK_PHOTOS.shuf,
  KIOSK_PHOTOS.vip,
  KIOSK_PHOTOS.arcade,
];

/** Walk-up device: every dated item starts on today's OPERATING day (todayYmd
 *  rolls at 2 AM ET, so a post-midnight session stays on its date). Bowling/KBF
 *  are stamped too so they resolve the same operating day as racing/attractions
 *  instead of the calendar date. */
function stampToday(item: SessionItem): SessionItem {
  if (
    item.kind === "race" ||
    item.kind === "attraction" ||
    item.kind === "bowling" ||
    item.kind === "kbf"
  ) {
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

/** Guest-facing activity name for an item — wizard header + exit-confirm copy. */
function activityLabelFor(item: SessionItem): string {
  if (item.kind === "race") return "Racing";
  if (item.kind === "bowling") return "Bowling";
  if (item.kind === "kbf") return "Kids Bowl Free";
  const slug = (item as AttractionItem).slug ?? "";
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
}

const IDLE_FLOW_MS = 120_000;
const IDLE_CHECKOUT_MS = 180_000;

/** The checkout-upsell token pack (owner 2026-07-21: "100 tokens for $5,
 *  50% off") — the single offer on the post-"Review & Pay" upsell page.
 *  Registry-driven: the first `upsell`-flagged pack wins; none = no page. */
const CHECKOUT_UPSELL_PACK = TOKEN_PACKAGES.find((p) => p.upsell) ?? null;

/** Kiosk-native steps are already authored at canvas px. Every OTHER (reused web)
 *  wizard step is web-rem-sized and reads small on the 1080px canvas, so it gets
 *  the Chromium `zoom` bump to fit the kiosk theme (see .kiosk-zoom). */
const NATIVE_STEP_IDS = new Set([
  "race-party",
  "kiosk-who",
  "attraction-slot",
  "bowling-slots",
  "bowling-tier",
  "bowling-offer",
  // v3 single-time-pick steps render their own kiosk variant at canvas px.
  "bowling-experience",
  "bowling-time",
  "kiosk-bowling-details",
  "kiosk-bowling-people",
]);

/** ?goto= deep links from the attract screen's quick chips. */
function seedForGoto(
  goto: string,
  ftDuckpinActive: boolean,
): { kind: SessionItem["kind"]; slug?: string; duckpin?: boolean } | "vip" | null {
  if (goto === "race") return { kind: "race" };
  if (goto === "bowl" || goto === "bowling") return { kind: "bowling" };
  if (goto === "kbf") return { kind: "kbf" };
  if (goto === "vip") return "vip";
  // FastTrax duckpin on QAMF: a bowling item (center 11542), not a BMI
  // attraction, when the flag is active. Flag-off keeps the attraction path.
  if (goto === "duck-pin" && ftDuckpinActive) return { kind: "bowling", duckpin: true };
  if (["gel-blaster", "laser-tag", "duck-pin", "shuffly"].includes(goto)) {
    return { kind: "attraction", slug: goto };
  }
  return null;
}

/** Module-scope StepDef titles can't reach useT(); map the English title to a
 *  message key at the render site (unmapped titles fall back to raw English). */
const STEP_TITLE_KEYS: Record<string, MessageKey> = {
  Lanes: "stepTitle.lanes",
  Time: "stepTitle.time",
  Bowlers: "stepTitle.bowlers",
  Package: "stepTitle.package",
  "Who's bowling?": "stepTitle.whosBowling",
  "Who's playing?": "stepTitle.whosPlaying",
  "Who's racing?": "stepTitle.whosRacing",
};

export function KioskFlow({ goto, bowlingV3 }: { goto: string | null; bowlingV3?: boolean }) {
  const router = useRouter();
  const { config } = useKioskConfig();
  // Reset the guest's language override on Start-Over — the LocaleProvider is
  // mounted in KioskShell (survives the soft-nav to /kiosk), so without this the
  // next guest would inherit the previous guest's chosen language.
  const { t, resetLocale } = useLocale();
  // Bookable-today availability for the Experiences (VIP combo + Ultimate
  // Qualifier), from the cached server endpoint — locks their entry points when
  // nothing fits today.
  const { available: availableFor, firstOpenFor } = useKioskAvailability(config?.center ?? null);
  const vipAvailable = availableFor("race-bowl");
  const uqAvailable = availableFor("ultimate-qualifier");

  // Self-heal the full-bleed step backdrops if a flaky-WiFi fetch fails — they
  // paint as CSS background-images (see `chrome`), which never retry on their
  // own, so on an unattended kiosk one failed load otherwise leaves the flow
  // photo-less until a reload. Every backdrop `chrome` can use is healed here.
  const resolveBackdrop = useResilientImages(KIOSK_BACKDROP_PHOTOS);

  const initial = useMemo(
    () =>
      emptySession({
        entryBrand: config?.brand ?? "fasttrax",
        context: {
          ...(config ? { center: config.center } : {}),
          kiosk: true,
          ...(bowlingV3 ? { bowlingV3: true } : {}),
        },
      }),
    [config, bowlingV3],
  );
  const [session, dispatch, hydrated] = usePersistedReducer(initial, {
    storageKey: KIOSK_SESSION_STORAGE_KEY,
    schemaVersion: KIOSK_SCHEMA_VERSION,
  });
  const queryClient = useQueryClient();
  // Always-latest handleNext for steps' requestAdvance — the picker calls it
  // after an await, from a closure created renders ago; the ref guarantees the
  // CURRENT session/item advance (and the unracered sheet still intercepts).
  // setTimeout(0) lets React flush the hold's final state first. Hooks live up
  // here (the config early-return sits below); the ref is assigned by a plain
  // statement right AFTER handleNext's declaration — NEVER by an effect
  // registered up here: on a loading-screen render the early return means
  // handleNext is still in its temporal dead zone, and an effect touching it
  // crashed /kiosk/flow on first paint (live find 2026-07-19).
  const handleNextRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const requestAdvance = useCallback(() => {
    setTimeout(() => void handleNextRef.current(), 0);
  }, []);

  // `?bowlingV3=1` preview opt-in must also reach a PERSISTED kiosk session —
  // context is only seeded at creation (same fix as BookingFlow).
  useEffect(() => {
    if (!hydrated) return;
    if (bowlingV3 && !session.context?.bowlingV3) {
      dispatch({ type: "enableBowlingV3" });
    }
  }, [hydrated, bowlingV3, session.context?.bowlingV3, dispatch]);

  const [cartActive, setCartActive] = useState(false);
  const [checkoutActive, setCheckoutActive] = useState(false);
  // Checkout upsell page (merged flow): shown between "Review & Pay" and the
  // pay screen when eligible; once per guest session (state remounts with the
  // start-over route change, so the next guest sees it again).
  const [upsellActive, setUpsellActive] = useState(false);
  const upsellSeenRef = useRef(false);
  const [gzOpen, setGzOpen] = useState(false);
  // Standalone race-pack purchase (attract "Race Packs" chip) — a LOCKED
  // pack-only flow; its party is local until "Race today" adopts it here.
  const [packsOpen, setPacksOpen] = useState(false);
  // True while the Game Zone dispenser is mid-operation/holding — pauses the
  // idle watchdog so a guest isn't reset mid-dispense or during a fault hold.
  const [gzBusy, setGzBusy] = useState(false);
  const [vipCombo, setVipCombo] = useState<ComboSpecial | null>(null);
  // The ref twin is the SYNCHRONOUS truth for handleNext's guard: a step's
  // requestAdvance fires right after its hold clears busy, before React has
  // flushed the state update.
  const [stepBusy, setStepBusyState] = useState(false);
  const stepBusyRef = useRef(false);
  const setStepBusy = useCallback((busy: boolean) => {
    stepBusyRef.current = busy;
    setStepBusyState(busy);
  }, []);
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
  // Guarded exits (owner 2026-07-18): Start over wipes the whole session; Main
  // menu abandons the item mid-configuration — both destructive enough for an
  // explicit confirm sheet before anything is lost.
  const [confirmExit, setConfirmExit] = useState<null | "startOver" | "mainMenu" | "cart">(null);
  // Guest assistance (owner 2026-07-18): flashes the whole screen red as a
  // staff beacon and HOLDS the kiosk exactly where it is (idle reset paused)
  // until Clear is tapped.
  const [assistActive, setAssistActive] = useState(false);
  // Why the beacon is up — picks the overlay copy + the radio message. A card
  // error (dispenser hold fault) auto-raises the beacon; Clear reveals the
  // underlying hold screen for staff (owner 2026-07-20).
  const [assistReason, setAssistReason] = useState<"help" | "card-error">("help");
  // Mobile join (people-step QR): live session snapshot — drives the
  // "phone sign-in in progress → continuing cancels it" confirm sheet and
  // pauses the idle watchdog while phones are actively signing in.
  const mobileJoin = useMobileJoinStatus();
  const [confirmMobileJoin, setConfirmMobileJoin] = useState(false);
  const timerRef = useRef<ReservationTimerHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const seededGotoRef = useRef(false);

  // No device config → this URL was opened outside a provisioned kiosk.
  useEffect(() => {
    if (config === null && hydrated) router.replace("/kiosk");
  }, [config, hydrated, router]);

  // Guest assistance → staff radios (owner 2026-07-20): while the beacon is
  // up, speak an alert on the venue's FOH Zello radios immediately and then
  // every 30s until Clear is tapped. Fire-and-forget — radio trouble must
  // never affect the on-screen beacon.
  useEffect(() => {
    if (!assistActive || !config) return;
    // Clarity friction milestone: the beacon went up (help tap or card error).
    clarityTag("kiosk_assist", assistReason);
    clarityEvent("kiosk:assist");
    const send = () =>
      void fetch("/api/kiosk/assist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          center: config.center,
          brand: config.brand,
          kioskNumber: config.kioskNumber ?? 1,
          reason: assistReason,
        }),
      }).catch(() => {});
    send();
    const timer = setInterval(send, 30_000);
    return () => clearInterval(timer);
  }, [assistActive, assistReason, config]);

  // Silent qualification refresh for the review→pay boundary (the last stop
  // before money): fire-and-forget — the live memberships/credits/waiver
  // patches land within a couple of seconds, before the pay tap builds charge
  // lines, so discounts and credit offers price off current data. Fail-open by
  // construction (refreshQualifications never throws). The people-step exit
  // does the BLOCKING variant inside handleNextInner.
  const refreshPartyQualificationsSilently = () => {
    if (session.party.length === 0) return;
    const brandLocation =
      session.center === "naples"
        ? "naples"
        : session.entryBrand === "headpinz"
          ? "headpinz"
          : "fasttrax";
    void refreshQualifications(session.party, brandLocation).then((fresh) => {
      for (const [id, patch] of fresh) {
        dispatch({ type: "updatePartyMember", id, patch });
      }
    });
  };

  // Post-hydration seeding: center from device config; ?goto= deep link.
  useEffect(() => {
    if (!hydrated || !config) return;
    if (!session.center) dispatch({ type: "setCenter", center: config.center });
    if (goto && !seededGotoRef.current) {
      seededGotoRef.current = true;
      if (goto === "packs") {
        // Standalone race packs (FastTrax kiosks; kill-switch aware). Deferred
        // a microtask so the effect body stays setState-free (hooks-lint).
        if (kioskRacePacksEnabled() && config.brand === "fasttrax") {
          clarityEvent("kiosk:packs:open");
          void Promise.resolve().then(() => setPacksOpen(true));
        }
        return;
      }
      const seed = seedForGoto(goto, fasttraxQamfDuckpinEnabled());
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
          if (item.kind === "bowling" && seed.duckpin) {
            item.variant = "hourly";
            item.isDuckpin = true;
          }
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
   *  reducer re-inits from the sessionStorage we just cleared.
   *
   *  Confirmation lives in requestStartOver (the util-strip path). Direct
   *  callers stay unconfirmed ON PURPOSE — each already has its own warning
   *  context: IdleWatcher (the "Still there?" countdown), the expired-
   *  reservation modal, CheckoutStep's "Cancel & clear cart" two-step, and
   *  CartView's leave modal (web-only; the kiosk passes onAllActivities). */
  const handleStartOver = useCallback(async () => {
    // End any live phone sign-in session FIRST — phones show "session ended"
    // within one poll instead of spinning against a dead code.
    closeMobileJoin("start-over");
    resetLocale();
    setResetting(true);
    // abandonBooking retries + verifies the BMI cancel (7/19 incident: silent
    // cancel failures stacked abandoned holds onto live heats). false = BMI's
    // ~20-min self-expire is the last resort; the /api/bmi log line has detail.
    const released = await abandonBooking(session).catch(() => false);
    if (!released) console.error("[kiosk] start-over could not confirm hold release");
    clearBookingSession(KIOSK_SESSION_STORAGE_KEY);
    // Self-update between guests: if a newer deploy is live, hard-reload to load
    // it (fullscreen re-engages on the first attract tap); otherwise soft-nav so
    // the engaged fullscreen survives. Owner 2026-07-19: no more close+reopen.
    await resetToKiosk(() => router.replace("/kiosk"));
  }, [session, router, resetLocale]);

  const handleReservationExpired = useCallback(() => {
    setReservationExpired(true);
    clarityEvent("kiosk:hold:expired");
  }, []);
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

  // Clarity smart-event breadcrumbs: one milestone per step VIEW (including
  // the first step of a flow), plus the activity as a session tag — funnels
  // per activity are built from these in the Clarity dashboard. Keyed on
  // item+step so re-renders never re-fire.
  const stepViewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeItem) return;
    const visible = KIOSK_STEP_REGISTRY[activeItem.kind].filter((s) =>
      s.isVisible(activeItem, session),
    );
    if (visible.length === 0) return;
    const idx = Math.min(session.cursors[activeItem.id] ?? 0, visible.length - 1);
    const key = `${activeItem.id}:${visible[idx].id}`;
    if (stepViewKeyRef.current === key) return;
    stepViewKeyRef.current = key;
    const activity =
      activeItem.kind === "attraction"
        ? ((activeItem as AttractionItem).slug ?? "attraction")
        : activeItem.kind;
    clarityTag("kiosk_activity", activity);
    clarityTag("kiosk_step", visible[idx].id);
    clarityEvent(`kiosk:step:${activity}:${visible[idx].id}`);
  }, [activeItem, session]);

  // Friction breadcrumb: every inline kiosk error is a Clarity milestone (the
  // message rides along as a tag) — segment for sessions that hit trouble.
  useEffect(() => {
    if (!kioskError) return;
    clarityTag("kiosk_error", kioskError.slice(0, 60));
    clarityEvent("kiosk:error");
  }, [kioskError]);

  // Preselect the tapped Experiences package once the party is known, so the
  // product step(s) can skip. MUST stay above the early return below (hook
  // order). Per-category (packageIdAdult/Junior): a mixed adult+junior party
  // gets BOTH variants stamped and skips both product steps (owner 2026-07-19);
  // any category that doesn't resolve to exactly one all-new eligible variant
  // stays unstamped → its product step shows normally (see package-preselect.ts).
  useEffect(() => {
    const preferred = session.preferredPackageId;
    if (!preferred) return;
    const race = session.items.find((i) => i.kind === "race") as
      | (SessionItem & {
          packageIdAdult?: string | null;
          packageIdJunior?: string | null;
          date?: string;
        })
      | undefined;
    if (!race || !race.date) return;
    const patch = resolvePreselectPatch({
      party: session.party,
      date: race.date,
      preferredFamily: preferred,
      current: race,
    });
    if (patch) {
      dispatch({ type: "updateItem", id: race.id, patch: patch as Partial<SessionItem> });
    }
  }, [session.preferredPackageId, session.party, session.items, dispatch]);

  // Mixed party (a returning racer + new racer(s)): the product step hides packs
  // for a mixed group (packs are new-racer-only), so the new racer's Rookie Pack
  // can't be chosen there and the license/POV step is the only picker. Owner
  // 2026-07-19: auto-enroll the new racer(s) in the FULL Rookie Pack (license +
  // POV + appetizer) and skip that step (see skipLicenseForMixedParty in the
  // registry). The license already charges per new racer; POV needs povQuantity;
  // the appetizer needs rookiePack. Gated on the Rookie flow flag.
  // Game Zone cards never ride an EMPTY cart (owner 2026-07-21: "if you remove
  // all attractions the cards need removed too") — they pay with the booking
  // deposit, so there's nothing to charge them against. handleRemoveItem clears
  // them on its last-item path; this guard covers every OTHER route to an empty
  // cart (combo removal, unfinished-draft clearing, future paths).
  useEffect(() => {
    if (!hydrated) return;
    if (session.items.length === 0 && session.gameCardPurchase) {
      dispatch({ type: "setGameCardPurchase", purchase: null });
    }
  }, [hydrated, session.items.length, session.gameCardPurchase, dispatch]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_ROOKIE_PACK_ENABLED !== "1") return;
    const race = session.items.find((i): i is RaceItem => i.kind === "race");
    // ANY selected package variant (adult or junior) means a package flow —
    // the bundle carries license/POV/appetizer itself, so never auto-enroll.
    if (!race || racePackageIds(race).length > 0) return;
    const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
    const hasReturning = session.party.some((m) => !m.isNewRacer);
    if (newRacerCount === 0 || !hasReturning) return; // only the mixed case
    if (race.rookiePack === true && race.povQuantity === newRacerCount) return; // already applied
    dispatch({
      type: "updateItem",
      id: race.id,
      patch: { rookiePack: true, povQuantity: newRacerCount } as Partial<SessionItem>,
    });
  }, [session.items, session.party, dispatch]);

  if (!hydrated || !config) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418]">
        <BrandedLoader brand={config?.brand ?? "fasttrax"} label="Warming up…" />
      </div>
    );
  }

  // Merged cart+checkout (owner 2026-07-21), OPT-IN via
  // NEXT_PUBLIC_KIOSK_MERGED_CHECKOUT: the cart surface becomes the ONE
  // "review your order" screen (order + booking-as + rewards, pinned Review &
  // Pay) and CheckoutStep skips its contact phase. Flag off = the proven
  // two-screen path, byte-identical.
  const mergedCheckout = kioskMergedCheckoutEnabled();

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
    // FastTrax duckpin on QAMF: the duck-pin tile seeds a bowling item at center
    // 11542 (isDuckpin), NOT a BMI attraction, when the flag is active. Flag-off
    // falls through to the normal attraction path below.
    if (offering.slug === "duck-pin" && fasttraxQamfDuckpinEnabled()) {
      const existingDuckpin = session.items.find((i) => i.kind === "bowling" && i.isDuckpin);
      if (existingDuckpin) {
        dispatch({ type: "setActiveItem", id: existingDuckpin.id });
        return;
      }
      const dp = stampToday(newItem("bowling")) as BowlingItem;
      dp.variant = "hourly";
      dp.isDuckpin = true;
      dispatch({ type: "addItem", item: dp });
      return;
    }
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
    const existing = session.items.find((i) => {
      if (i.kind !== offering.kind) return false;
      if (offering.kind === "attraction") {
        return (i as AttractionItem).slug === offering.attractionSlug;
      }
      // HeadPinz bowling and FastTrax duckpin are BOTH kind:"bowling". The
      // duck-pin tile returns via the isDuckpin branch above, so reaching here
      // with kind "bowling" is always the HeadPinz Bowling tile — it must NOT
      // re-open a duckpin item left in the cart, or tapping "HeadPinz Bowling"
      // brings up duckpin (owner 2026-07-25, FastTrax kiosks).
      if (i.kind === "bowling") return !(i as BowlingItem).isDuckpin;
      return true;
    });
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
    clarityEvent("kiosk:vip:overview");
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
    clarityEvent("kiosk:vip:start");
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
    clarityEvent("kiosk:cart:open");
    setCheckoutActive(false);
    setUpsellActive(false);
    setCartActive(true);
    dispatch({ type: "setActiveItem", id: null });
  };

  // ── Guarded exits (owner 2026-07-18: confirm before anything is lost) ──
  // Which surface is showing follows the render precedence below: checkout →
  // cart → game zone → VIP overview → categories → wizard.
  const inWizard = !!activeItem && !cartActive && !checkoutActive && !gzOpen;
  const onCategories = !activeItem && !cartActive && !checkoutActive && !gzOpen && !vipCombo;

  /** Close every screen, back to the category chooser. Cart contents are kept. */
  const goHome = () => {
    setCartActive(false);
    setCheckoutActive(false);
    setUpsellActive(false);
    setGzOpen(false);
    setVipCombo(null);
    setKioskError(null);
    setConfirmExit(null);
    dispatch({ type: "setActiveItem", id: null });
  };

  const requestStartOver = () => {
    // Never reset while a booking call is in flight (same set that pauses the
    // IdleWatcher): the whole-bill cancel would race the in-flight book and the
    // fresh line would land on a bill nobody owns anymore.
    if (bookingHeats || stepBusy) return;
    // Nothing guest-visible to lose (no names, empty cart) — skip the ceremony.
    if (session.party.length === 0 && cartCount === 0) {
      clarityEvent("kiosk:start-over");
      void handleStartOver();
      return;
    }
    setConfirmExit("startOver");
  };

  const requestMainMenu = () => {
    if (inWizard) {
      setConfirmExit("mainMenu");
      return;
    }
    goHome(); // cart / Game Zone / VIP overview: nothing is destroyed, no dialog
  };

  /** Cart pill / session banner: same guard as Main menu (owner 2026-07-19) —
   *  openCart mid-wizard silently orphaned the unfinished draft in the cart. */
  const requestOpenCart = () => {
    if (inWizard) {
      setConfirmExit("cart");
      return;
    }
    openCart();
  };

  /** Drop the unfinished draft (combo-aware — a combo leg takes the whole
   *  bundle; vendor releases run in the background, the reducer dispatches
   *  land first), and clear the package stamp so it can't re-seed the next
   *  race draft (see the variant-resolve effect above). */
  const abandonActiveDraft = () => {
    if (!activeItem) return;
    clarityEvent("kiosk:abandon:item");
    void handleRemoveItem(activeItem.id);
    if (activeItem.kind === "race" && session.preferredPackageId) {
      dispatch({ type: "setPreferredPackage", id: null });
    }
  };

  const abandonActiveAndGoHome = () => {
    abandonActiveDraft();
    goHome();
  };

  /** Cart-pill confirm: drop the draft, then land on the cart — or the
   *  category chooser when nothing else would be left in it (an empty cart is
   *  a dead end on the kiosk). Destination is computed BEFORE the async
   *  removal so it can't race handleRemoveItem's own wasLast cart-close. */
  const abandonActiveAndShowCart = () => {
    setConfirmExit(null);
    const comboLeg =
      !!session.comboSpecialId &&
      !!activeItem &&
      (activeItem.kind === "race" || activeItem.kind === "bowling");
    const anythingLeft = session.items.some(
      (i) =>
        !!activeItem &&
        i.id !== activeItem.id &&
        !(comboLeg && (i.kind === "race" || i.kind === "bowling")),
    );
    abandonActiveDraft();
    // Game Zone cards don't count: they ride the booking deposit, so
    // handleRemoveItem clears them with the last item anyway.
    if (anythingLeft) openCart();
    else goHome();
  };

  // Podium utility strip — pinned bottom zone (Start over · Main menu · help · cart pill).
  const utilityStrip = (
    <div className="k-z-util">
      <button
        type="button"
        onClick={requestStartOver}
        disabled={gzBusy}
        className="k-util-btn k-tap disabled:opacity-40"
      >
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
        {t("util.startOver")}
      </button>
      {/* Back to the category chooser (the kiosk "main page") — session and
          finished cart items are kept; an unfinished flow confirms first. Hidden
          when already there, and on checkout (navigating away mid-payment is
          risky — same rule as the session banner; checkout has its own exits). */}
      {!onCategories && !checkoutActive && (
        <button
          type="button"
          onClick={requestMainMenu}
          disabled={gzBusy}
          className="k-util-btn k-tap disabled:opacity-40"
        >
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
            <path d="m3 10 9-7 9 7" />
            <path d="M5 9v11h5v-6h4v6h5V9" />
          </svg>
          {t("util.mainMenu")}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          setAssistReason("help");
          setAssistActive(true);
        }}
        className="k-util-btn k-tap mr-auto"
        style={{ borderColor: "rgba(239,68,68,0.5)", color: "#fca5a5" }}
      >
        {t("util.guestAssistance")}
      </button>
      {/* Help hint removed (owner 2026-07-26) — redundant with the Guest
          assistance button. `mr-auto` on that button now pins the cart pill right. */}
      {cartCount > 0 && (
        <button
          type="button"
          onClick={requestOpenCart}
          className="k-cart-pill k-tap ml-auto shrink-0"
        >
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
          {t("util.cart")}
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
    !checkoutActive &&
    !upsellActive ? (
      <button
        type="button"
        onClick={requestOpenCart}
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

  // Exit-confirm sheet (owner 2026-07-18: "are you sure" before Start over /
  // before Main menu drops an unfinished flow). Same canvas-native pattern as
  // the unracered sheet below; the SAFE choice is the big primary, the
  // destructive one is the ghost. No tap-outside dismiss (kiosk convention).
  const confirmSheet = (() => {
    if (!confirmExit) return null;
    const isReset = confirmExit === "startOver";
    // A combo leg never leaves alone — handleRemoveItem drops the whole bundle,
    // so the copy names the bundle, not the leg.
    const comboName =
      session.comboSpecialId &&
      activeItem &&
      (activeItem.kind === "race" || activeItem.kind === "bowling")
        ? (getComboSpecial(session.comboSpecialId)?.name ?? null)
        : null;
    const draftLabel = comboName ?? (activeItem ? activityLabelFor(activeItem) : "activity");
    // Removing the LAST cart item also drops Game Zone cards riding it (cards
    // can't pay without a booking deposit — see handleRemoveItem) — say so.
    const dropsCards =
      !isReset &&
      !!session.gameCardPurchase?.cards.length &&
      !session.comboSpecialId &&
      session.items.length <= 1;
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
        <div className="k-glass w-full max-w-[860px] space-y-[24px] p-[44px]">
          <div className="k-eyebrow text-[#f0b341]">
            {isReset
              ? "Start over?"
              : confirmExit === "cart"
                ? "Go to your cart?"
                : "Back to the main page?"}
          </div>
          <div className="k-display text-[46px] leading-[1.05]">
            {isReset ? "This clears your whole visit" : `Your ${draftLabel} isn't finished`}
          </div>
          <p className="text-[26px] leading-snug text-white/60">
            {isReset
              ? "We'll clear everyone's names, empty your cart, release any held times, and sign you out of this kiosk."
              : `We'll remove the unfinished ${draftLabel} from your cart${dropsCards ? " (and the Game Zone cards riding with it)" : ""}. Everything else in your cart stays, and your group stays signed in.`}
          </p>
          <div className="flex flex-col gap-[16px] pt-[4px]">
            {/* Inline flex per the .kiosk-canvas cascade gotcha (see the
                unracered sheet): k-btn-primary's flex:1 squashes its height in
                a column layout. */}
            <button
              type="button"
              onClick={() => setConfirmExit(null)}
              className="k-btn-primary k-tap"
              style={{ flex: "0 0 auto" }}
            >
              {isReset ? "Keep my visit" : "Keep working on it"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (isReset) {
                  // Same in-flight guard as requestStartOver — a booking call
                  // could have started while the sheet was up.
                  if (bookingHeats || stepBusy) return;
                  clarityEvent("kiosk:start-over");
                  // Close first so the sheet doesn't sit over the z-40
                  // "Clearing this session…" loader.
                  setConfirmExit(null);
                  void handleStartOver();
                } else if (confirmExit === "cart") {
                  abandonActiveAndShowCart();
                } else {
                  abandonActiveAndGoHome();
                }
              }}
              className="k-btn-ghost k-tap"
              style={{ flex: "0 0 auto" }}
            >
              {isReset
                ? "Yes — start over"
                : confirmExit === "cart"
                  ? "Remove it & view cart"
                  : "Remove it & go to main page"}
            </button>
          </div>
        </div>
      </div>
    );
  })();

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
          style={{ ["--k-img"]: `url(${resolveBackdrop(bg)})` } as React.CSSProperties}
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
      {/* Before <IdleWatcher/>: the idle "Still there?" sheet is the same
          z-[80] — as the later sibling it must paint ON TOP of this confirm. */}
      {confirmSheet}
      <IdleWatcher
        // The merged cart+checkout screen is checkout dwell too (rewards
        // verify, contact edits) — give it the longer leash.
        timeoutMs={
          checkoutActive || (cartActive && mergedCheckout) ? IDLE_CHECKOUT_MS : IDLE_FLOW_MS
        }
        // A guest signing in on their PHONE generates no kiosk touches — pause
        // the watchdog while phones are actively connected. Bounded by
        // construction: heartbeats expire server-side in ~30s, so an abandoned
        // phone unpauses within one heartbeat window; an untouched QR with no
        // phones still idle-resets normally.
        paused={
          bookingHeats ||
          stepBusy ||
          resetting ||
          assistActive ||
          gzBusy ||
          (mobileJoin.status === "open" && mobileJoin.activeClients > 0)
        }
        onReset={() => {
          clarityEvent("kiosk:idle:reset");
          closeMobileJoin("idle");
          void handleStartOver();
        }}
      />
      {assistActive && (
        <div className="k-assist-overlay">
          <div className="k-display text-[110px] leading-none text-white">
            {assistReason === "card-error" ? "Card error" : "Help is on the way"}
          </div>
          <p className="max-w-[26ch] text-[34px] font-semibold text-white/90">
            {assistReason === "card-error"
              ? "There's a problem with the card dispenser — a team member will be right with you. Stay right here."
              : "Stay right here — a team member is coming to assist you. Your booking is held exactly where you left it."}
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

  // ── Checkout upsell (merged flow): discounted Game Zone card page ──
  if (upsellActive && CHECKOUT_UPSELL_PACK) {
    return chrome(
      <KioskCheckoutUpsell
        pack={CHECKOUT_UPSELL_PACK}
        partySize={session.party.length}
        onAdd={(packageId, quantity) => {
          clarityEvent("kiosk:upsell:accepted");
          dispatch({
            type: "setGameCardPurchase",
            purchase: {
              mode: "new_card",
              cards: Array.from({ length: quantity }, () => ({ packageId })),
            },
          });
          clarityEvent("kiosk:checkout:start");
          setUpsellActive(false);
          setCheckoutActive(true);
        }}
        onSkip={() => {
          clarityEvent("kiosk:upsell:declined");
          clarityEvent("kiosk:checkout:start");
          setUpsellActive(false);
          setCheckoutActive(true);
        }}
      />,
      KIOSK_PHOTOS.arcade,
    );
  }

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
          // Merged flow: Back (review/error) returns to the merged review
          // screen; legacy keeps today's behavior (close checkout, land per
          // render precedence).
          onBack={() => {
            setCheckoutActive(false);
            if (mergedCheckout) setCartActive(true);
          }}
          // Merged flow: contact + rewards were confirmed on the merged
          // screen — book immediately, land on review.
          skipContactPhase={mergedCheckout}
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
    // Merged cart+checkout (flag-gated): the ONE review-your-order screen —
    // order items + booking-as + rewards, Review & Pay pinned in the reach
    // band. Review & Pay hands off to CheckoutStep with the contact phase
    // skipped (booking starts immediately).
    if (mergedCheckout) {
      return chrome(
        <KioskCheckoutScreen
          session={session}
          dispatch={dispatch}
          brand={config.brand}
          center={config.center}
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
          onRemoveCombo={session.comboSpecialId ? handleRemoveCombo : undefined}
          onRemoveGameCards={
            session.gameCardPurchase
              ? () => dispatch({ type: "setGameCardPurchase", purchase: null })
              : undefined
          }
          onReviewAndPay={() => {
            // Upsell page (owner 2026-07-21): between Review & Pay and the pay
            // screen — BOWLING carts only for now (owner: "they need bowling
            // in cart to trigger upsell"; KBF counts — it's a lane booking),
            // only when NO Game Zone cards ride the cart, once per session,
            // and only when this kiosk can actually sell + fulfill a new card
            // (cart rail + reader rail + dispenser "full" capability — the
            // dispenser is a hard requirement, owner re-confirmed 7/21).
            // Every gate is named so a device console shows exactly why the
            // page didn't appear (NEXT_PUBLIC_KIOSK_TERMINAL_ENABLED must be
            // scoped to the Vercel PREVIEW env or preview builds bake it off).
            // `?upsellPreview=1` on the flow URL bypasses ONLY the hardware
            // gates so the page can be SEEN on any rig (bowling still
            // required in the cart); accepting still rides the real rails —
            // a readerless checkout fails closed at pay time, so this never
            // risks a broken sale (staff-typed URL only).
            // Live qualifications for the pay screen (discounts/credit offers).
            refreshPartyQualificationsSilently();
            const upsellPreview =
              typeof window !== "undefined" &&
              new URLSearchParams(window.location.search).get("upsellPreview") === "1";
            const failedGates = (
              [
                ["upsell-flag", kioskCheckoutUpsellEnabled()],
                ["upsell-pack", CHECKOUT_UPSELL_PACK != null],
                [
                  "bowling-in-cart",
                  session.items.some((i) => i.kind === "bowling" || i.kind === "kbf"),
                ],
                ["once-per-session", !upsellSeenRef.current],
                ["no-cards-in-cart", !session.gameCardPurchase?.cards.length],
                ["gz-cart-flag", kioskGzCartEnabled()],
                ["terminal-flag", upsellPreview || kioskTerminalEnabled()],
                ["reader-paired", upsellPreview || !!config.readerId],
                ["dispenser-full", upsellPreview || gameZoneCapability(config) === "full"],
              ] as const
            )
              .filter(([, ok]) => !ok)
              .map(([name]) => name);
            setCartActive(false);
            if (failedGates.length === 0) {
              upsellSeenRef.current = true;
              clarityEvent("kiosk:upsell:shown");
              setUpsellActive(true);
              return;
            }
            console.log(`[kiosk] checkout upsell skipped: ${failedGates.join(", ")}`);
            clarityTag("kiosk_upsell_skip", failedGates.join(",").slice(0, 60));
            clarityEvent("kiosk:checkout:start");
            setCheckoutActive(true);
          }}
        />,
      );
    }
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
            // Live qualifications for the pay screen (discounts/credit offers).
            refreshPartyQualificationsSilently();
            clarityEvent("kiosk:checkout:start");
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

  // ── Standalone race packs (attract chip — LOCKED pack-only flow) ──
  if (packsOpen) {
    return chrome(
      <div ref={contentRef} className="k-flow-body">
        <KioskRacePackFlow
          brand={config.brand}
          center={config.center}
          onExit={() => setPacksOpen(false)}
          onRaceToday={(members, grants) => {
            // Adopt the pack buyers into the session party (skip anyone already
            // there by person id) so racing never re-prompts a sign-in, then
            // open the race flow exactly like the attract "Race now" chip.
            // The FIRST buyer becomes the MAIN contact (owner 2026-07-19) when
            // the session doesn't have one yet — their name/phone/email seed
            // the booking contact so the contact step never re-asks what we
            // already know (email may still be missing; that step fills it).
            // Each buyer's just-granted pack merges into their creditBalances
            // snapshot (taken at sign-in, BEFORE the purchase) so the product
            // step's "covered by credits" preview and the checkout's default-ON
            // redeem opt-in both see the fresh credits without a refetch.
            const known = new Set(
              session.party.map((m) => m.bmiPersonId).filter((id): id is string => !!id),
            );
            const hasMain = session.party.some((m) => m.isBillingCustomer);
            const grantFor = (personId: string | null | undefined) =>
              personId ? grants.find((g) => g.bmiPersonId === personId) : undefined;
            members.forEach((m, i) => {
              const makeMain = i === 0 && !hasMain;
              const grant = grantFor(m.bmiPersonId);
              if (m.bmiPersonId && known.has(m.bmiPersonId)) {
                const existing = session.party.find((p) => p.bmiPersonId === m.bmiPersonId);
                if (existing && (makeMain || grant)) {
                  dispatch({
                    type: "updatePartyMember",
                    id: existing.id,
                    patch: {
                      ...(makeMain ? { isBillingCustomer: true } : {}),
                      ...(grant
                        ? {
                            creditBalances: appendGrantedCredits(
                              existing.creditBalances,
                              grant.depositKindId,
                              grant.raceCount,
                            ),
                          }
                        : {}),
                    },
                  });
                }
              } else {
                const withCredits = grant
                  ? {
                      ...m,
                      creditBalances: appendGrantedCredits(
                        m.creditBalances,
                        grant.depositKindId,
                        grant.raceCount,
                      ),
                    }
                  : m;
                dispatch({
                  type: "addPartyMember",
                  member: makeMain ? { ...withCredits, isBillingCustomer: true } : withCredits,
                });
              }
              if (makeMain) {
                dispatch({
                  type: "setContact",
                  patch: {
                    firstName: m.firstName,
                    lastName: m.lastName ?? "",
                    ...(m.phone ? { phone: m.phone } : {}),
                    ...(m.email ? { email: m.email } : {}),
                    // OTP-proven phone rides along — kiosk rewards redemption
                    // keys on this to skip its SMS verify.
                    phoneVerified: !!(m.phone && m.phoneVerified),
                  },
                });
              }
            });
            setPacksOpen(false);
            const existingRace = session.items.find((i) => i.kind === "race");
            if (existingRace) {
              dispatch({ type: "setActiveItem", id: existingRace.id });
            } else {
              dispatch({ type: "addItem", item: stampToday(newItem("race")) });
            }
          }}
        />
      </div>,
      KIOSK_PHOTOS.race,
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
          onCardFault={() => {
            setAssistReason("card-error");
            setAssistActive(true);
          }}
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
        available={vipAvailable}
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
        vipComboAvailable={vipAvailable}
        uqAvailable={uqAvailable}
        offeringAvailable={availableFor}
        offeringFirstOpen={firstOpenFor}
        onPickOffering={pickOffering}
        onPickCombo={pickCombo}
        onPickPackageExperience={pickPackageExperience}
        onOpenCart={() => setCartActive(true)}
        onOpenGameZone={() => {
          clarityEvent("kiosk:gamezone:open");
          setGzOpen(true);
        }}
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
      if (hasUnbooked) clarityEvent("kiosk:heats:booked");
      // Booking consumed capacity the 60s-stale availability cache doesn't
      // know about — refresh so the next grid (the junior leg after the adult
      // leg books on advance) reads post-booking occupancy.
      queryClient.invalidateQueries({ queryKey: bookingKeys.bmi.availabilityAll });
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

  /** Unracered sheet, PACKAGE flow → append the skipped member(s) onto the
   *  already-picked package heats and book: a racer does the WHOLE package or
   *  none of it, so mirror every distinct picked (product, heat) of this
   *  category. The product-clearing path above would dead-end here — on a
   *  preselected-package launch the product step is hidden. Capacity is
   *  enforced at book time: a full heat surfaces the kiosk error and nothing
   *  partial books. */
  const addToPackageForUnracered = async () => {
    if (!unraceredPrompt || !activeItem || activeItem.kind !== "race") return;
    const raceItem = activeItem as RaceItem;
    const catHeats = raceItem.heats.filter(
      (h) => h.heatId && (h.category ?? "adult") === unraceredPrompt.category,
    );
    const distinct = new Map<string, RaceHeatAssignment>();
    for (const h of catHeats) distinct.set(`${h.productId}|${h.heatId}`, h);
    const additions: RaceHeatAssignment[] = unraceredPrompt.members.flatMap((m) =>
      [...distinct.values()].map((h) => ({
        productId: h.productId,
        track: h.track,
        tier: h.tier,
        category: h.category,
        heatId: h.heatId,
        bmiLineId: null,
        assignedTo: m.id,
      })),
    );
    setUnraceredPrompt(null);
    if (additions.length === 0) return;
    const updatedItem: RaceItem = { ...raceItem, heats: [...raceItem.heats, ...additions] };
    // Store first, then book against the local copy (the dispatch hasn't
    // re-rendered yet) — the ComboSteps confirm uses the same pattern.
    dispatch({
      type: "updateItem",
      id: raceItem.id,
      patch: { heats: updatedItem.heats } as Partial<SessionItem>,
    });
    await bookHeatsAndAdvance(updatedItem);
  };

  /** Unracered sheet → explicit "they're not racing" opt-out (spectators are
   *  legitimate) — book what's picked and move on. */
  const continueWithoutUnracered = async () => {
    if (!activeItem || activeItem.kind !== "race") return;
    setUnraceredPrompt(null);
    await bookHeatsAndAdvance(activeItem as RaceItem);
  };

  // The active category's package while the unracered sheet is up — drives the
  // sheet's package-flavored copy + the append-to-package primary action.
  const unraceredPkg =
    unraceredPrompt && activeItem?.kind === "race"
      ? getPackage(packageIdForCategory(activeItem as RaceItem, unraceredPrompt.category))
      : null;

  /** The advance body — everything Continue does once any mobile-join
   *  confirmation is settled. Called directly by the confirm sheet's
   *  "Continue anyway". */
  const handleNextInner = async () => {
    setKioskError(null);

    // QUALIFICATION REFRESH (owner 2026-07-23): a member's tier/memberships,
    // waiver, and credits can change WHILE the party stands at the kiosk (a
    // license bought at the desk, a waiver signed on a phone, a credit granted
    // or spent). Re-pull the live values at the people-step exit so the
    // product/heat steps gate on current data, not the sign-in snapshot.
    // Field-scoped patches only (safe alongside the mobile-join poll); a
    // refresh hiccup returns an empty map — the flow proceeds on the snapshot.
    if (currentStep.id === "race-party" || currentStep.id === "kiosk-who") {
      let fresh: Map<string, QualificationPatch> = new Map();
      setBookingHeatsProgress("Checking everyone’s latest info…");
      setBookingHeats(true);
      try {
        const brandLocation =
          session.center === "naples"
            ? "naples"
            : session.entryBrand === "headpinz"
              ? "headpinz"
              : "fasttrax";
        fresh = await refreshQualifications(session.party, brandLocation);
      } finally {
        setBookingHeats(false);
      }
      for (const [id, patch] of fresh) {
        dispatch({ type: "updatePartyMember", id, patch });
      }
      // Gate on the RETURNED values — the dispatches above aren't visible in
      // this closure. A racer whose waiver just came back INVALID (revoked /
      // expired since sign-in) must re-sign before the race flow advances; the
      // patched member card shows the "waiver needed" setup path.
      if (activeItem.kind === "race") {
        const downgraded = session.party.filter(
          (m) => m.waiverValid && fresh.get(m.id)?.waiverValid === false,
        );
        if (downgraded.length > 0) {
          setKioskError(
            `${downgraded.map((m) => m.firstName).join(", ")} need${
              downgraded.length === 1 ? "s" : ""
            } a new waiver — the one on file is no longer valid.`,
          );
          return;
        }
      }
    }

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
      // past a guest with no race — offer a way to add them (the path back the
      // guest "couldn't find") or an explicit not-racing opt-out. Packages are
      // covered too since the picker's roster checklist can deselect members
      // (the old "packages own their race selections" exemption predates real
      // selection); their sheet's primary action appends onto the picked
      // package heats instead of the product-clearing back-nav.
      const category = currentStep.id === "race-heat-adult" ? "adult" : "junior";
      const assigned = new Set(
        raceItem.heats.filter((h) => h.heatId && h.assignedTo).map((h) => h.assignedTo),
      );
      const unracered = session.party.filter(
        (m) => (m.category ?? "adult") === category && !assigned.has(m.id),
      );
      if (unracered.length > 0 && raceItem.heats.some((h) => h.heatId)) {
        setUnraceredPrompt({ category, members: unracered });
        clarityEvent("kiosk:unracered:prompt");
        return;
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
          clarityEvent("kiosk:slot:booked");
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

  const handleNext = async () => {
    // Ref, not state: requestAdvance can fire before the state flush.
    if (stepBusyRef.current) return;
    // Phone sign-in in progress → confirm before continuing, because
    // continuing CANCELS it (owner requirement: make that very clear —
    // never silently kill someone mid-OTP on their own phone). Finished
    // phones (already merged into the roster) don't count.
    if (
      (currentStep.id === "race-party" || currentStep.id === "kiosk-who") &&
      mobileJoin.status === "open" &&
      mobileJoin.inProgressClients > 0
    ) {
      setConfirmMobileJoin(true);
      return;
    }
    await handleNextInner();
  };
  // Latest-closure handoff for requestAdvance (see the ref's declaration above
  // the early return) — a plain render-time assignment, deliberately not an
  // effect: it must only run on renders that actually initialize handleNext.
  handleNextRef.current = handleNext;

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

  const activityLabel = activityLabelFor(activeItem);

  const ctaLabel = isLastStep ? "Add to my visit" : "Continue";

  return chrome(
    <>
      {/* header zone: logo · activity · hold timer · progress · big title */}
      <div className="k-flow-head">
        <div className="k-fh-top">
          <BrandLogo brand={config.brand} className="h-[60px] w-auto" />
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
        <h1 className="k-display k-fh-title">
          {STEP_TITLE_KEYS[currentStep.title]
            ? t(STEP_TITLE_KEYS[currentStep.title])
            : currentStep.title}
        </h1>
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
            requestAdvance={requestAdvance}
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
              // The draft item stays in the cart; Main menu (util strip) offers
              // removing it, Start over resets — both confirm first.
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
          add-them path obvious instead of silently dropping them. Package
          flows get an append-to-package primary action (the product-clearing
          back-nav would dead-end on a preselected-package launch). */}
      {unraceredPrompt && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
          <div className="k-glass w-full max-w-[860px] space-y-[24px] p-[44px]">
            <div className="k-eyebrow text-[#f0b341]">Before you continue</div>
            <div className="k-display text-[46px] leading-[1.05]">
              {unraceredPrompt.members.map((m) => m.firstName).join(" & ")}{" "}
              {unraceredPrompt.members.length === 1 ? "isn't" : "aren't"} in a race yet
            </div>
            <p className="text-[26px] leading-snug text-white/60">
              {unraceredPkg
                ? `They weren't included in the ${unraceredPkg.name}. Add them to the same heats, or continue without racing them.`
                : "This race is above their level or they weren't added to a heat. Add a race that fits them — your picked heats are saved — or continue without racing them."}
            </p>
            <div className="flex flex-col gap-[16px] pt-[4px]">
              {/* k-btn-primary's flex:1 squashes its height in this column
                  layout (the ghost keeps its full 112px, so the pair rendered
                  uneven — owner 2026-07-18 "make buttons even"). Inline style
                  because the unlayered .kiosk-canvas rules out-cascade Tailwind
                  utilities. */}
              <button
                type="button"
                onClick={() =>
                  unraceredPkg ? void addToPackageForUnracered() : addRaceForUnracered()
                }
                className="k-btn-primary k-tap"
                style={{ flex: "0 0 auto" }}
              >
                {unraceredPkg
                  ? `Add ${unraceredPrompt.members.map((m) => m.firstName).join(" & ")} to the ${unraceredPkg.name}`
                  : `Add a race for ${unraceredPrompt.members.map((m) => m.firstName).join(" & ")}`}
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

      {/* Phone sign-in in progress — Continue cancels it, so confirm first
          (owner requirement). If every phone finishes while the sheet is up,
          it flips to an all-clear with a one-tap Continue (the live count
          drives the copy). Same z-[80] pattern as the sheets above. */}
      {confirmMobileJoin &&
        (mobileJoin.inProgressClients > 0 ? (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
            <div className="k-glass w-full max-w-[860px] space-y-[24px] p-[44px]">
              <div className="k-eyebrow text-[#f0b341]">Phone sign-in in progress</div>
              <div className="k-display text-[46px] leading-[1.05]">
                {mobileJoin.inProgressClients === 1
                  ? "Someone's still signing in on their phone"
                  : `${mobileJoin.inProgressClients} people are still signing in on their phones`}
              </div>
              <p className="text-[26px] leading-snug text-white/60">
                Continuing now cancels{" "}
                {mobileJoin.inProgressClients === 1 ? "that sign-in" : "those sign-ins"} —
                they&rsquo;d need to be added here at the kiosk instead. Anyone who already finished
                is on your list.
              </p>
              <div className="flex flex-col gap-[16px] pt-[4px]">
                {/* Inline flex per the .kiosk-canvas cascade gotcha (see the
                    unracered sheet above). */}
                <button
                  type="button"
                  onClick={() => setConfirmMobileJoin(false)}
                  className="k-btn-primary k-tap"
                  style={{ flex: "0 0 auto" }}
                >
                  Wait for them to finish
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmMobileJoin(false);
                    closeMobileJoin("continued");
                    void handleNextInner();
                  }}
                  className="k-btn-ghost k-tap"
                  style={{ flex: "0 0 auto" }}
                >
                  Continue anyway — cancel phone sign-in
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
            <div className="k-glass w-full max-w-[860px] space-y-[24px] p-[44px]">
              <div className="k-eyebrow text-[#46d68c]">All set</div>
              <div className="k-display text-[46px] leading-[1.05]">
                They finished — everyone&rsquo;s on your list
              </div>
              <p className="text-[26px] leading-snug text-white/60">
                The phone sign-in wrapped up while you waited. You&rsquo;re good to continue.
              </p>
              <div className="flex flex-col gap-[16px] pt-[4px]">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmMobileJoin(false);
                    void handleNextInner();
                  }}
                  className="k-btn-primary k-tap"
                  style={{ flex: "0 0 auto" }}
                >
                  Continue
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmMobileJoin(false)}
                  className="k-btn-ghost k-tap"
                  style={{ flex: "0 0 auto" }}
                >
                  Stay on this step
                </button>
              </div>
            </div>
          </div>
        ))}

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
