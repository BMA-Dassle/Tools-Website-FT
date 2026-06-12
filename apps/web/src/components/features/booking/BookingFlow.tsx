"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  emptySession,
  getActiveItem,
  newItem,
  STEP_REGISTRY,
  type Activity,
  type AttractionItem,
  type BookingSession,
  type Brand,
  type EntryContext,
  type SessionItem,
  type StepDef,
} from "~/features/booking";
import { contactIsComplete } from "./steps/ContactStep";
import { CenterPickerModal } from "./CenterPickerModal";
import { clearBookingSession, usePersistedReducer } from "~/features/booking/hooks";
import type { AppliedPromo } from "~/features/discount-codes";
import { CartView, LeaveConfirmModal } from "./CartView";
import { CheckoutStep } from "./steps/checkout/CheckoutStep";
import { HeightAgeConfirmModal } from "./steps/race/HeightAgeConfirmModal";
import { bookHeatsOnAdvance } from "~/features/booking/service/race";
import { bookAttractionOnAdvance } from "~/features/booking/service/attractions";
import {
  releaseItemBmiLines,
  releaseHeatBmiLines,
  abandonBooking,
} from "~/features/booking/service/checkout";
import { ReservationTimer, type ReservationTimerHandle } from "./ReservationTimer";
import { ReservationExpiredModal } from "./ReservationExpiredModal";
import { comboBowlingComponent, getComboSpecial } from "~/features/combos/combo-specials";
import { holdComboBowling, releaseComboBowlingHold } from "~/features/combos/combo-booking";
import { qamfCenterIdForCode } from "~/features/booking/types";
import { clarityTag, clarityEvent } from "~/lib/clarity";

export interface BookingFlowProps {
  activity: Activity;
  slug?: string;
  entryBrand: Brand;
  initialContext?: EntryContext;
  initialPromo?: AppliedPromo | null;
  urlCode?: string | null;
  /** Open straight to checkout (from the landing cart bar's "Checkout →", which
   *  routes to the cart's existing activity with ?checkout=1). Only takes effect
   *  on the cart view (no active item). */
  initialCheckout?: boolean;
  /** Returning to an EXISTING cart from the landing's "View Cart" link
   *  (?cart=1). Like `initialCheckout`, this is a cart-return intent — NOT a
   *  fresh activity entry — so the persisted combo must be preserved, never
   *  torn down as a "stale" session. */
  initialCartView?: boolean;
  /** Combo-special entry (/book/combo/[id]/v2): seed a FRESH session with the
   *  combo's components (race + bowling) and stamp session.comboSpecialId so
   *  checkout charges the flat combo price. Ignored when the customer already
   *  has a non-combo cart in progress. */
  comboSpecialId?: string;
}

/**
 * Do we already have the customer's contact info, so the "Your Info" step can be
 * skipped on the way INTO it? True when the cart already carries it — another
 * item is present (a prior activity collected it) OR a returning racer was
 * verified (their lookup pre-filled it). `contactIsComplete` guards the "before
 * first bill" invariant. This is a STABLE, cart-based signal (it doesn't flip
 * while the customer types), so the skip is only ever applied on forward/initial
 * navigation — never yanking someone off the form mid-edit.
 */
function cartAlreadyHasContact(session: BookingSession, activeItemId: string): boolean {
  if (!contactIsComplete(session.contact)) return false;
  const hasOtherItem = session.items.some((i) => i.id !== activeItemId);
  const hasVerifiedRacer = session.party.some((m) => !!m.bmiPersonId);
  return hasOtherItem || hasVerifiedRacer;
}

export function BookingFlow({
  activity,
  slug,
  entryBrand,
  initialContext,
  initialPromo,
  urlCode,
  initialCheckout = false,
  initialCartView = false,
  comboSpecialId,
}: BookingFlowProps) {
  const initial = useMemo(
    () => emptySession({ entryBrand, context: initialContext, appliedPromo: initialPromo ?? null }),
    [entryBrand, initialContext, initialPromo],
  );
  const [session, dispatch, hydrated] = usePersistedReducer(initial);
  // Seed from ?checkout=1 — opens checkout directly when arriving from the
  // landing cart bar (only meaningful on the cart view, i.e. no active item).
  const [checkoutActive, setCheckoutActive] = useState(initialCheckout);
  const [showHeightConfirm, setShowHeightConfirm] = useState(false);
  const [bookingHeats, setBookingHeats] = useState(false);
  const [bookingHeatsProgress, setBookingHeatsProgress] = useState<string>("Reserving your heats…");
  // True while a step is mid-async (e.g. an eager BMI hold). Disables Next so the
  // customer can't advance — and the advance-time booker can't double-book —
  // while a hold is still resolving.
  const [stepBusy, setStepBusy] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [reservationExpired, setReservationExpired] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevCursorRef = useRef<number | null>(null);
  const timerRef = useRef<ReservationTimerHandle>(null);

  // Seed first item or detect cross-sell arrival — runs after storage hydration
  useEffect(() => {
    if (!hydrated) return;
    // Combo-special entry: seed a FRESH session with the combo's components —
    // one race item (heat count enforced via session.comboSpecialId) + one
    // bowling item preset to the combo's duration — at the combo's center, and
    // stamp comboSpecialId (once, like appliedPromo). A resumed combo session
    // is left alone; an existing NON-combo cart is also left alone (we never
    // clobber a cart in progress — the customer can finish or start over).
    if (comboSpecialId) {
      const combo = getComboSpecial(comboSpecialId);
      if (combo && combo.enabled && session.items.length === 0) {
        if (!session.center) {
          dispatch({ type: "setCenter", center: combo.center });
        }
        dispatch({ type: "setComboSpecial", id: combo.id });
        const raceItem = newItem("race");
        dispatch({ type: "addItem", item: raceItem });
        const bowlComp = comboBowlingComponent(combo);
        const bowlingItem: SessionItem = {
          ...(newItem("bowling") as Extract<SessionItem, { kind: "bowling" }>),
          variant: "hourly",
          durationMinutes: bowlComp?.durationMinutes ?? null,
        };
        dispatch({ type: "addItem", item: bowlingItem });
        // Race first: addItem activates the LAST added item (bowling).
        dispatch({ type: "setActiveItem", id: raceItem.id });
      }
      return;
    }
    // URGENT FIX (owner repro): entering a NORMAL activity route (e.g. the
    // Karting tile → /book/race/v2) while a stale COMBO session persists in
    // sessionStorage hijacked the flow with the Ultimate VIP steps —
    // comboSpecialId gates the combo wizard, and it survived the navigation.
    // A normal-entry click is intent to leave the combo: release it as a unit
    // (same as the cart's "Remove combo" — BMI heats + QAMF lane, best-effort)
    // and seed the requested activity on a clean cart.
    //
    // EXCEPTION (combo checkout bug, 2026-06-12): a CART RETURN is NOT a fresh
    // entry. The landing's "Checkout →" (?checkout=1) and "View Cart" (?cart=1)
    // both route through the combo's first item (a race) → /book/race/v2, which
    // looks identical to the Karting tile. Tearing the combo down here orphaned
    // the booked BMI heats + QAMF lane and dropped a paying customer back at
    // step 1 of a race — making the Ultimate VIP impossible to check out. When
    // the customer is returning to their cart, leave the combo intact and fall
    // through (the requested race is already in the cart, so nothing re-seeds).
    if (session.comboSpecialId && !initialCheckout && !initialCartView) {
      const comboRace = session.items.find((i) => i.kind === "race");
      const comboBowling = session.items.find((i) => i.kind === "bowling") as
        | import("~/features/booking").BowlingItem
        | undefined;
      dispatch({ type: "setComboSpecial", id: null });
      if (comboRace) {
        dispatch({ type: "removeItem", id: comboRace.id });
        void releaseItemBmiLines(session, comboRace);
      }
      if (comboBowling) {
        dispatch({ type: "removeItem", id: comboBowling.id });
        void releaseComboBowlingHold(comboBowling);
      }
      if (initialContext?.center && !session.center) {
        dispatch({ type: "setCenter", center: initialContext.center });
      }
      const fresh = newItem(activity);
      if (fresh.kind === "attraction" && slug) {
        (fresh as AttractionItem).slug = slug;
      }
      dispatch({ type: "addItem", item: fresh });
      return;
    }
    // Seed the center from the entry URL (?location=, parsed into initialContext)
    // on a FRESH session so the picked activity books at the right complex
    // (Naples → headpinznaples clientKey) and the cart cross-sell scopes
    // correctly. Guarded on an unset center so a resumed session isn't clobbered
    // — setCenter to a DIFFERENT center clears the cart.
    if (initialContext?.center && !session.center) {
      dispatch({ type: "setCenter", center: initialContext.center });
    }
    const makeItem = (): SessionItem => {
      const created = newItem(activity);
      if (created.kind === "attraction" && slug) {
        (created as AttractionItem).slug = slug;
      }
      return created;
    };

    let added: SessionItem | null = null;
    if (session.items.length === 0) {
      added = makeItem();
      dispatch({ type: "addItem", item: added });
    } else {
      const alreadyInCart = session.items.some((i) => {
        if (i.kind !== activity) return false;
        if (i.kind === "attraction") return (i as AttractionItem).slug === slug;
        return true;
      });
      if (!alreadyInCart) {
        added = makeItem();
        dispatch({ type: "addItem", item: added });
      }
    }

    // Skip a LEADING "Your Info" step when the cart already carries contact (a
    // prior item collected it). Forward-only — opening an item is never a "back"
    // action — so a first-time customer still gets the step.
    if (added && cartAlreadyHasContact(session, added.id)) {
      const visible = STEP_REGISTRY[added.kind].filter((s) => s.isVisible(added!, session));
      if (visible.length > 1 && visible[0].id === "contact") {
        dispatch({ type: "goto", index: 1 });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const brandClass = entryBrand === "fasttrax" ? "brand-fasttrax" : "brand-headpinz";
  const activeItem = getActiveItem(session);

  // Reservation-hold info, computed once and reused by every view's timer bar
  // (wizard header, cart, and checkout) so the countdown follows the customer
  // everywhere a live hold exists — not just inside the wizard.
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

  const backCode = session.appliedPromo?.code ?? urlCode ?? null;
  const backToLandingHref = backCode ? `/book/v2?code=${encodeURIComponent(backCode)}` : "/book/v2";

  const handleReservationExpired = useCallback(() => {
    clarityEvent("hold:expired");
    setReservationExpired(true);
  }, []);

  const handleExtendReservation = useCallback(async (): Promise<boolean> => {
    const ok = await timerRef.current?.refresh();
    if (ok) setReservationExpired(false);
    return !!ok;
  }, []);

  // Abandon the in-progress booking and start fresh: release every early-created
  // vendor hold (BMI reservation + any QAMF bowling/KBF hold) so nothing orphans,
  // clear the local session, then return to the landing. Shared by the
  // reservation-expiry modal and the leave modal's "Start new booking" action.
  const handleStartOver = useCallback(async () => {
    await abandonBooking(session);
    clearBookingSession();
    window.location.href = backToLandingHref;
  }, [session, backToLandingHref]);

  // A compact sticky timer bar for the cart + checkout pages (the wizard has its
  // own richer header). Renders nothing when there's no live hold.
  const timerBar = hasActiveHold ? (
    <div className="sticky top-18 z-30 border-b border-white/8 bg-[#000418] sm:top-20">
      <div className="mx-auto flex max-w-4xl items-center justify-end gap-2 px-4 py-2.5">
        <span className="text-[11px] uppercase tracking-wider text-white/30">
          Holding your spot
        </span>
        <ReservationTimer
          ref={timerRef}
          bmiBillId={session.bmiBillId}
          qamfHoldId={qamfHoldId}
          qamfCenterId={qamfCenterId}
          onExpired={handleReservationExpired}
        />
      </div>
    </div>
  ) : null;

  // Auto-scroll to top on step change (v1 parity: page.tsx:263).
  const currentCursor = activeItem ? (session.cursors[activeItem.id] ?? 0) : null;
  useEffect(() => {
    if (prevCursorRef.current !== null && currentCursor !== prevCursorRef.current) {
      contentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setStepBusy(false); // clear any stale busy flag when the step changes
    }
    prevCursorRef.current = currentCursor;
  }, [currentCursor]);

  // ── Microsoft Clarity: tag the session by flow / step / center so replays and
  // funnels can be followed through the whole booking flow. ──
  const tagFlow = checkoutActive ? "checkout" : (activeItem?.kind ?? "cart");
  const tagStep = (() => {
    if (checkoutActive) return "checkout";
    if (!activeItem) return "cart";
    const visible = STEP_REGISTRY[activeItem.kind].filter((s) => s.isVisible(activeItem, session));
    const idx = Math.min(session.cursors[activeItem.id] ?? 0, Math.max(0, visible.length - 1));
    return visible[idx]?.id ?? "unknown";
  })();
  const tagCenter = session.center ?? "unset";
  const tagCartItems = session.items.length;
  const tagParty = (() => {
    if (activeItem?.kind === "bowling") return activeItem.playerCount;
    if (activeItem?.kind === "kbf") return activeItem.bowlers.length + activeItem.paidAdults;
    return session.party.length;
  })();
  const prevCartCountRef = useRef(0);
  useEffect(() => {
    clarityTag("booking_flow", tagFlow);
    clarityTag("booking_step", tagStep);
    clarityTag("booking_center", tagCenter);
    clarityTag("cart_items", String(tagCartItems));
    clarityTag("party_size", String(tagParty));
    clarityEvent(`step:${tagFlow}:${tagStep}`);
    // Cross-sell: a second (or further) activity was added to the visit.
    if (tagCartItems > prevCartCountRef.current && tagCartItems > 1) {
      clarityEvent("cart:item_added");
    }
    prevCartCountRef.current = tagCartItems;
  }, [tagFlow, tagStep, tagCenter, tagCartItems, tagParty]);

  // Don't render the flow until the persisted session has hydrated (AFTER all
  // hooks — never early-return above a hook). Otherwise a deep entry (e.g. the
  // landing's "Checkout →" → ?checkout=1) mounts CheckoutStep against the EMPTY
  // initial session, capturing blank contact fields in state — so the customer
  // re-types info they already entered. One tick of loader also avoids the
  // empty-cart flash.
  if (!hydrated) {
    return (
      <div className={`${brandClass} flex min-h-[60vh] items-center justify-center`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
      </div>
    );
  }

  // Remove the WHOLE combo as a unit: both seeded items + the combo stamp,
  // releasing the BMI heats and the QAMF lane hold. Removing only one half
  // would silently fall back to item-sum pricing — a charge surprise, not a
  // feature. Extra attraction items the customer added stay in the cart.
  const handleRemoveCombo = async () => {
    const raceItem = session.items.find((i) => i.kind === "race");
    const bowlingItem = session.items.find((i) => i.kind === "bowling") as
      | import("~/features/booking").BowlingItem
      | undefined;
    const remaining = session.items.filter((i) => i.kind !== "race" && i.kind !== "bowling");
    dispatch({ type: "setComboSpecial", id: null });
    if (raceItem) dispatch({ type: "removeItem", id: raceItem.id });
    if (bowlingItem) dispatch({ type: "removeItem", id: bowlingItem.id });
    if (raceItem) await releaseItemBmiLines(session, raceItem);
    if (bowlingItem) await releaseComboBowlingHold(bowlingItem);
    if (remaining.length === 0) {
      window.location.href = "/book/v2";
    }
  };

  // Remove a whole cart item, releasing any BMI bill lines it booked early (race
  // heats / attraction slot) so it isn't still confirmed at checkout. Last item
  // → back to the activity picker. On a combo session, removing either combo
  // half removes the COMBO (see handleRemoveCombo).
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
      window.location.href = "/book/v2";
    }
  };

  // Remove a SINGLE heat (all racer entries for that product + time) from a race
  // item in the cart. Releases its early-booked BMI line so the bill matches the
  // cart; if it was the item's last heat, drops the whole item.
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

  if (!activeItem) {
    if (checkoutActive) {
      return (
        <div className={brandClass}>
          {timerBar}
          <div className="mx-auto max-w-4xl px-4 py-8">
            <CheckoutStep
              session={session}
              dispatch={dispatch}
              onBack={() => {
                setCheckoutActive(false);
              }}
              onStartOver={handleStartOver}
            />
          </div>
          {reservationExpired && hasActiveHold && (
            <ReservationExpiredModal
              onExtend={handleExtendReservation}
              onStartOver={handleStartOver}
            />
          )}
        </div>
      );
    }

    return (
      <div className={brandClass}>
        {timerBar}
        <CartView
          session={session}
          urlCode={urlCode ?? null}
          onEditItem={(id) => dispatch({ type: "setActiveItem", id })}
          onRemoveItem={handleRemoveItem}
          onRemoveHeat={handleRemoveHeat}
          onCheckout={() => setCheckoutActive(true)}
          onNewBooking={handleStartOver}
          onRemoveCombo={session.comboSpecialId ? handleRemoveCombo : undefined}
        />
        {reservationExpired && hasActiveHold && (
          <ReservationExpiredModal
            onExtend={handleExtendReservation}
            onStartOver={handleStartOver}
          />
        )}
      </div>
    );
  }

  const allSteps = STEP_REGISTRY[activeItem.kind];
  const steps = allSteps.filter((s) => s.isVisible(activeItem, session));
  const rawCursor = session.cursors[activeItem.id] ?? 0;
  const stepIndex = Math.min(rawCursor, Math.max(0, steps.length - 1));
  const currentStep = steps[stepIndex];
  const isLastStep = stepIndex >= steps.length - 1;

  if (!currentStep) {
    return (
      <div className={brandClass}>
        <CartView
          session={session}
          urlCode={urlCode ?? null}
          onEditItem={(id) => dispatch({ type: "setActiveItem", id })}
          onRemoveItem={handleRemoveItem}
          onRemoveHeat={handleRemoveHeat}
          onCheckout={() => setCheckoutActive(true)}
          onNewBooking={handleStartOver}
          onRemoveCombo={session.comboSpecialId ? handleRemoveCombo : undefined}
        />
      </div>
    );
  }

  const stepUntyped = currentStep as StepDef;
  const canAdvance = stepUntyped.canAdvance(activeItem, session);
  const advanceOk = canAdvance === true;

  const advanceToNextStep = () => {
    if (isLastStep) {
      dispatch({ type: "setActiveItem", id: null });
      // Navigate to the landing page which shows "Add to Your Visit"
      // when the session has items. Session survives via sessionStorage.
      window.location.href = "/book/v2";
      return;
    }
    // Skip "Your Info" on the way FORWARD when the cart already carries contact
    // (returning-racer pre-fill or a prior item). The step stays visible in the
    // breadcrumb so the customer can click back to review/edit it.
    let target = stepIndex + 1;
    while (
      target < steps.length - 1 &&
      steps[target].id === "contact" &&
      cartAlreadyHasContact(session, activeItem.id)
    ) {
      target += 1;
    }
    dispatch(target === stepIndex + 1 ? { type: "next" } : { type: "goto", index: target });
  };

  const handleNext = async () => {
    // Never advance while a step is mid-hold (the Next button is also disabled,
    // but guard here too so the advance-time booker can't race the eager hold).
    if (stepBusy) return;

    // HeightAgeConfirmModal: intercept party→date transition for race items
    // when the party has any new racers (v1 parity: page.tsx:789-792).
    if (
      currentStep.id === "race-party" &&
      activeItem.kind === "race" &&
      session.party.some((m) => m.isNewRacer)
    ) {
      setShowHeightConfirm(true);
      return;
    }

    // Book heats with BMI when advancing past a heat picker step.
    // Heats are picked locally (no BMI call); the actual BMI booking
    // happens here so the customer's spots are held before they move
    // on to POV/addons/other activities.
    if (
      (currentStep.id === "race-heat-adult" || currentStep.id === "race-heat-junior") &&
      activeItem.kind === "race"
    ) {
      const raceItem = activeItem as import("~/features/booking").RaceItem;
      // Eager click-time holding usually leaves every heat already booked, but
      // bookHeatsOnAdvance is also where POV is sold + the package disclaimer
      // memo is written (idempotent via item.povSold), and it backstops any heat
      // not yet held. So always run it; only show the spinner when there's real
      // heat-booking work to wait on.
      const hasUnbooked = raceItem.heats.some((h) => h.heatId && !h.bmiLineId);
      if (hasUnbooked) {
        setBookingHeatsProgress("Reserving your heats…");
        setBookingHeats(true);
      }
      try {
        await bookHeatsOnAdvance(session, raceItem, dispatch, setBookingHeatsProgress);
        advanceToNextStep();
      } catch (err) {
        alert(
          err instanceof Error
            ? `Failed to reserve heats: ${err.message}`
            : "Failed to reserve heats. Please try again.",
        );
      } finally {
        setBookingHeats(false);
      }
      return;
    }

    // Combo special: confirming the itinerary books the BMI heats AND creates
    // the QAMF lane hold for the programmatically-configured bowling item —
    // both under the reservation timer. All-or-nothing UX: a lane-hold failure
    // keeps the customer on the schedule (heats stay held; they can re-pick).
    if (currentStep.id === "combo-itinerary" && activeItem.kind === "race") {
      const raceItem = activeItem as import("~/features/booking").RaceItem;
      setBookingHeatsProgress("Reserving your races…");
      setBookingHeats(true);
      try {
        await bookHeatsOnAdvance(session, raceItem, dispatch, setBookingHeatsProgress);
        const bowlingItem = session.items.find((i) => i.kind === "bowling") as
          | import("~/features/booking").BowlingItem
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
        alert(
          err instanceof Error
            ? `Couldn't lock in your schedule: ${err.message}`
            : "Couldn't lock in your schedule. Please try again.",
        );
      } finally {
        setBookingHeats(false);
      }
      return;
    }

    // Book attraction slot with BMI when advancing past the slot step.
    if (currentStep.id === "attraction-slot" && activeItem.kind === "attraction") {
      const attractionItem = activeItem as AttractionItem;
      if (attractionItem.slotProposal && !attractionItem.bmiLineId) {
        setBookingHeatsProgress("Reserving your slot…");
        setBookingHeats(true);
        try {
          await bookAttractionOnAdvance(session, attractionItem, dispatch);
          advanceToNextStep();
        } catch (err) {
          alert(
            err instanceof Error
              ? `Failed to reserve slot: ${err.message}`
              : "Failed to reserve slot. Please try again.",
          );
        } finally {
          setBookingHeats(false);
        }
        return;
      }
    }

    advanceToNextStep();
  };

  const handleGoToStep = (index: number) => {
    if (index < stepIndex) {
      dispatch({ type: "goto", index });
    }
  };

  return (
    <div className={brandClass}>
      {/* Bowling/KBF needs a specific complex. If the session has no resolved
          center (generic entry, nothing in cart to infer from), confirm it
          rather than silently defaulting — picking stamps the item's center. */}
      {(activeItem.kind === "bowling" || activeItem.kind === "kbf") && !session.center && (
        <CenterPickerModal onSelect={(center) => dispatch({ type: "setCenter", center })} />
      )}

      {/* Sticky step indicator — matches v1: sticky below fixed nav */}
      <div className="sticky top-18 z-30 border-b border-white/8 bg-[#000418] sm:top-20">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-0 overflow-x-auto">
            {steps.map((s, i) => {
              const isActive = i === stepIndex;
              const isComplete = i < stepIndex;
              const isFuture = i > stepIndex;
              return (
                <div key={s.id} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => handleGoToStep(i)}
                    disabled={isFuture}
                    className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors ${
                      isActive
                        ? "text-[#00E2E5]"
                        : isComplete
                          ? "cursor-pointer text-white/50 hover:text-white/80"
                          : "cursor-default text-white/20"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${
                        isActive
                          ? "bg-[#00E2E5] text-[#000418]"
                          : isComplete
                            ? "bg-white/20 text-white/60"
                            : "border border-white/20 text-white/30"
                      }`}
                    >
                      {isComplete ? "✓" : i + 1}
                    </span>
                    <span className="hidden text-sm sm:inline">{s.title}</span>
                  </button>
                  {i < steps.length - 1 && <span className="mx-0.5 text-white/15">›</span>}
                </div>
              );
            })}
          </div>
          <ReservationTimer
            ref={timerRef}
            bmiBillId={session.bmiBillId}
            qamfHoldId={qamfHoldId}
            qamfCenterId={qamfCenterId}
            onExpired={handleReservationExpired}
          />
        </div>
      </div>

      {/* Main content — v1: max-w-4xl mx-auto px-4 py-8, no card wrapper */}
      <div ref={contentRef} className="scroll-mt-45 mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() =>
              session.items.length > 1
                ? dispatch({ type: "setActiveItem", id: null })
                : setLeaveConfirm(true)
            }
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
          >
            {session.items.length > 1 ? "← Back to cart" : "← All activities"}
          </button>
          {/* Progress hint — keeps "where am I / how much more" visible.
              The sticky step bar shows numbered steps; this adds the
              human-readable next-step name + count for scanability. */}
          <p className="hidden text-xs text-white/40 sm:block">
            Step <span className="text-white/70">{stepIndex + 1}</span> of {steps.length}
            {!isLastStep && steps[stepIndex + 1] && (
              <span> · Next: {steps[stepIndex + 1].title}</span>
            )}
          </p>
        </div>

        <stepUntyped.Component
          item={activeItem}
          session={session}
          onChange={(patch) => dispatch({ type: "updateItem", id: activeItem.id, patch })}
          dispatch={dispatch}
          setBusy={setStepBusy}
        />

        {bookingHeats && (
          <div className="mt-6 flex items-center justify-center gap-3 rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
            <span className="text-sm font-medium text-white/80">{bookingHeatsProgress}</span>
          </div>
        )}

        <NavigationButtons
          stepIndex={stepIndex}
          canAdvance={advanceOk && !bookingHeats && !stepBusy}
          reason={
            bookingHeats || stepBusy
              ? "Holding your spot…"
              : advanceOk
                ? undefined
                : canAdvance.reason
          }
          nextLabel={isLastStep ? "Add to cart" : "Next"}
          onBack={() => dispatch({ type: "back" })}
          onBackToCart={
            session.items.length > 1
              ? () => dispatch({ type: "setActiveItem", id: null })
              : undefined
          }
          onAllActivities={() => setLeaveConfirm(true)}
          onNext={handleNext}
        />
      </div>

      {leaveConfirm && (
        <LeaveConfirmModal
          backHref={backToLandingHref}
          onCancel={() => setLeaveConfirm(false)}
          onNewBooking={handleStartOver}
        />
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

      {reservationExpired && session.bmiBillId && (
        <ReservationExpiredModal onExtend={handleExtendReservation} onStartOver={handleStartOver} />
      )}
    </div>
  );
}

function NavigationButtons({
  stepIndex,
  canAdvance,
  reason,
  nextLabel,
  onBack,
  onBackToCart,
  onAllActivities,
  onNext,
}: {
  stepIndex: number;
  canAdvance: boolean;
  reason?: string;
  nextLabel: string;
  onBack: () => void;
  onBackToCart?: () => void;
  onAllActivities?: () => void;
  onNext: () => void;
}) {
  // First step + single-item cart: there's no prior step and no cart hub to go
  // back to, so offer "All activities" instead of a disabled Back (which reads
  // as broken — "something I shouldn't touch"). Otherwise: step 0 with a
  // multi-item cart → back to the cart hub; any later step → the previous step.
  const atStart = stepIndex === 0 && !onBackToCart;
  const handleBack = () => {
    if (atStart) onAllActivities?.();
    else if (stepIndex === 0 && onBackToCart) onBackToCart();
    else onBack();
  };

  return (
    <div className="mt-4 flex items-center justify-between">
      <button
        type="button"
        onClick={handleBack}
        className="rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
      >
        {atStart ? "← All activities" : "Back"}
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!canAdvance}
        title={reason}
        className="rounded-xl bg-[#00E2E5] px-6 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {nextLabel}
      </button>
    </div>
  );
}
