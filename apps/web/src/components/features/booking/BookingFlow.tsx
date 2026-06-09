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

export interface BookingFlowProps {
  activity: Activity;
  slug?: string;
  entryBrand: Brand;
  initialContext?: EntryContext;
  initialPromo?: AppliedPromo | null;
  urlCode?: string | null;
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
}: BookingFlowProps) {
  const initial = useMemo(
    () => emptySession({ entryBrand, context: initialContext, appliedPromo: initialPromo ?? null }),
    [entryBrand, initialContext, initialPromo],
  );
  const [session, dispatch, hydrated] = usePersistedReducer(initial);
  const [checkoutActive, setCheckoutActive] = useState(false);
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

  // Remove a whole cart item, releasing any BMI bill lines it booked early (race
  // heats / attraction slot) so it isn't still confirmed at checkout. Last item
  // → back to the activity picker.
  const handleRemoveItem = async (id: string) => {
    const item = session.items.find((i) => i.id === id);
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
  onNext,
}: {
  stepIndex: number;
  canAdvance: boolean;
  reason?: string;
  nextLabel: string;
  onBack: () => void;
  onBackToCart?: () => void;
  onNext: () => void;
}) {
  const backDisabled = stepIndex === 0 && !onBackToCart;
  const handleBack = () => {
    if (stepIndex === 0 && onBackToCart) {
      onBackToCart();
    } else {
      onBack();
    }
  };

  return (
    <div className="mt-4 flex items-center justify-between">
      <button
        type="button"
        onClick={handleBack}
        disabled={backDisabled}
        className="rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
      >
        Back
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
