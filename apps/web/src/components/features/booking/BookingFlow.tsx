"use client";

import { useEffect, useMemo, useReducer } from "react";
import Link from "next/link";
import {
  emptySession,
  getActiveItem,
  newItem,
  reducer,
  STEP_REGISTRY,
  type Activity,
  type Brand,
  type EntryContext,
  type StepDef,
} from "~/features/booking";
import type { AppliedPromo } from "~/features/discount-codes";
import { CartView } from "./CartView";

/**
 * BookingFlow — orchestrator shell for the unified v2 booking session.
 *
 * The customer enters via an activity-specific URL (/book/race/v2,
 * /book/bowling/v2, etc.). BookingFlow creates a fresh session with the
 * entry brand + any prefilled context, seeds the first item for the
 * requested activity, and drives that item's step list.
 *
 * Styling tracks v1's dark booking theme: navy body bg (from globals.css),
 * cyan #00E2E5 primary CTAs, `bg-white/5` cards with `border-white/10`
 * borders, numbered step circles with cyan glow on active. The .brand-*
 * class on the root cascades the brand font (Exo2 / Outfit) from globals.css.
 */
export interface BookingFlowProps {
  activity: Activity;
  entryBrand: Brand;
  initialContext?: EntryContext;
  /**
   * Promo captured at session start — from the `/book/v2` landing or a
   * `?code=` URL seed on this slug's page. Once seeded it never mutates.
   */
  initialPromo?: AppliedPromo | null;
  /**
   * The raw `?code=` value from the URL, REGARDLESS of whether it
   * resolved into `initialPromo` (a wrong-domain code on this activity
   * still arrives here so back-to-landing carries it through).
   */
  urlCode?: string | null;
}

export function BookingFlow({
  activity,
  entryBrand,
  initialContext,
  initialPromo,
  urlCode,
}: BookingFlowProps) {
  const initial = useMemo(
    () => emptySession({ entryBrand, context: initialContext, appliedPromo: initialPromo ?? null }),
    [entryBrand, initialContext, initialPromo],
  );
  const [session, dispatch] = useReducer(reducer, initial);

  // Seed an initial item for the entry activity on first mount. The reducer
  // owns the item id and step cursor; we just kick it off here.
  useEffect(() => {
    if (session.items.length === 0) {
      dispatch({ type: "addItem", item: newItem(activity) });
    }
    // We only want this to fire once per BookingFlow mount; subsequent
    // session edits don't need to re-seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const brandClass = entryBrand === "fasttrax" ? "brand-fasttrax" : "brand-headpinz";
  const activeItem = getActiveItem(session);

  if (!activeItem) {
    return (
      <div className={brandClass}>
        <CartView
          session={session}
          urlCode={urlCode ?? null}
          onEditItem={(id) => dispatch({ type: "setActiveItem", id })}
          onRemoveItem={(id) => dispatch({ type: "removeItem", id })}
        />
      </div>
    );
  }

  const steps = STEP_REGISTRY[activeItem.kind];
  const stepIndex = session.cursors[activeItem.id] ?? 0;
  const currentStep = steps[stepIndex];
  const isLastStep = stepIndex >= steps.length - 1;

  // Defensive: if the cursor is somehow past the end, snap back to cart.
  if (!currentStep) {
    return (
      <div className={brandClass}>
        <CartView
          session={session}
          urlCode={urlCode ?? null}
          onEditItem={(id) => dispatch({ type: "setActiveItem", id })}
          onRemoveItem={(id) => dispatch({ type: "removeItem", id })}
        />
      </div>
    );
  }

  // canAdvance is item-typed at definition; the registry's union erases
  // that, but the runtime guarantee holds because the step list is
  // selected by item.kind.
  const stepUntyped = currentStep as StepDef;
  const canAdvance = stepUntyped.canAdvance(activeItem, session);
  const advanceOk = canAdvance === true;

  // Last step's "Next" returns to the cart view rather than advancing
  // into oblivion.
  const handleNext = () => {
    if (isLastStep) {
      dispatch({ type: "setActiveItem", id: null });
    } else {
      dispatch({ type: "next" });
    }
  };

  // Back-to-landing carries the customer's `?code=` even when the code
  // wasn't applied to THIS activity (e.g. a bowling-only code typed at a
  // /book/race/v2 URL). Prefer the validated `appliedPromo.code` when
  // it's set, else fall back to whatever the URL had so the landing's
  // chip + tile highlights are restored on return.
  const backCode = session.appliedPromo?.code ?? urlCode ?? null;
  const backToLandingHref = backCode ? `/book/v2?code=${encodeURIComponent(backCode)}` : "/book/v2";

  return (
    <section className={`${brandClass} mx-auto max-w-2xl p-4 sm:p-6`}>
      <div className="mb-4">
        <Link
          href={backToLandingHref}
          className="inline-flex items-center gap-1 text-xs text-white/40 transition-colors hover:text-white/80"
        >
          ← All activities
        </Link>
      </div>
      <StepIndicator steps={steps} stepIndex={stepIndex} />

      <div className="rounded-2xl border border-white/10 bg-white/3 p-4 sm:p-8">
        <h2 className="mb-4 text-xl font-semibold text-white">{currentStep.title}</h2>
        <stepUntyped.Component
          item={activeItem}
          session={session}
          onChange={(patch) => dispatch({ type: "updateItem", id: activeItem.id, patch })}
          dispatch={dispatch}
        />
        <p className="mt-4 text-xs text-white/30">
          PR-B2 scaffold — step body lands later this PR ({activeItem.kind}).
        </p>
      </div>

      <NavigationButtons
        stepIndex={stepIndex}
        canAdvance={advanceOk}
        reason={advanceOk ? undefined : canAdvance.reason}
        nextLabel={isLastStep ? "Add to cart" : "Next"}
        onBack={() => dispatch({ type: "back" })}
        onNext={handleNext}
      />
    </section>
  );
}

/**
 * Numbered step circles with connecting lines. Mirrors v1's StepIndicator
 * shape (8x8 circles, cyan glow for active, checkmark hint for complete).
 * Horizontal-scroll on overflow because step lists can be long.
 */
function StepIndicator({ steps, stepIndex }: { steps: StepDef[]; stepIndex: number }) {
  return (
    <ol className="mb-6 flex items-center gap-2 overflow-x-auto pb-2 text-xs sm:text-sm">
      {steps.map((s, i) => {
        const isActive = i === stepIndex;
        const isComplete = i < stepIndex;
        return (
          <li key={s.id} className="flex shrink-0 items-center gap-2">
            <span
              className={
                isActive
                  ? "flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#00E2E5] bg-[#00E2E5] text-sm font-bold text-[#000418] shadow-[0_0_20px_rgba(0,226,229,0.4)]"
                  : isComplete
                    ? "flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/20 bg-white/20 text-sm font-bold text-white/60"
                    : "flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/20 text-sm font-bold text-white/40"
              }
            >
              {isComplete ? "✓" : i + 1}
            </span>
            <span
              className={
                isActive
                  ? "font-semibold text-white"
                  : isComplete
                    ? "text-white/60"
                    : "text-white/30"
              }
            >
              {s.title}
            </span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-white/10" />}
          </li>
        );
      })}
    </ol>
  );
}

function NavigationButtons({
  stepIndex,
  canAdvance,
  reason,
  nextLabel,
  onBack,
  onNext,
}: {
  stepIndex: number;
  canAdvance: boolean;
  reason?: string;
  nextLabel: string;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        disabled={stepIndex === 0}
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
