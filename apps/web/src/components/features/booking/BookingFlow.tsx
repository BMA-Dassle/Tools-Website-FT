"use client";

import { useEffect, useMemo, useReducer } from "react";
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
import { CartView } from "./CartView";

/**
 * BookingFlow — orchestrator shell for the unified v2 booking session.
 *
 * The customer enters via an activity-specific URL (/book/race/v2,
 * /book/bowling/v2, etc.). BookingFlow creates a fresh session with the
 * entry brand + any prefilled context, seeds the first item for the
 * requested activity, and drives that item's step list.
 *
 * Session-level views (cart with cross-sell, checkout, payment,
 * confirmation) are filled in by later commits in PR-B2:
 *   - commit 5: AdditionalActivities cross-sell rendered alongside the
 *     cart list once activeItemId becomes null.
 *   - commit 9: Square anchor + payment wiring takes over after cart.
 *   - commit 10: confirmation page is a separate route.
 *
 * For now this component handles a single-item sub-wizard cleanly. Real
 * step components plug into STEP_REGISTRY in commit 8 of PR-B2.
 */
export interface BookingFlowProps {
  activity: Activity;
  entryBrand: Brand;
  initialContext?: EntryContext;
}

export function BookingFlow({ activity, entryBrand, initialContext }: BookingFlowProps) {
  const initial = useMemo(
    () => emptySession({ entryBrand, context: initialContext }),
    [entryBrand, initialContext],
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

  const activeItem = getActiveItem(session);

  if (!activeItem) {
    return (
      <CartView
        session={session}
        onEditItem={(id) => dispatch({ type: "setActiveItem", id })}
        onRemoveItem={(id) => dispatch({ type: "removeItem", id })}
      />
    );
  }

  const steps = STEP_REGISTRY[activeItem.kind];
  const stepIndex = session.cursors[activeItem.id] ?? 0;
  const currentStep = steps[stepIndex];
  const isLastStep = stepIndex >= steps.length - 1;

  // Defensive: if the cursor is somehow past the end, snap back to cart.
  if (!currentStep) {
    return (
      <CartView
        session={session}
        onEditItem={(id) => dispatch({ type: "setActiveItem", id })}
        onRemoveItem={(id) => dispatch({ type: "removeItem", id })}
      />
    );
  }

  // canAdvance is item-typed at definition; the registry's union erases
  // that, but the runtime guarantee holds because the step list is
  // selected by item.kind.
  const stepUntyped = currentStep as StepDef;
  const canAdvance = stepUntyped.canAdvance(activeItem, session);
  const advanceOk = canAdvance === true;

  // Last step's "Next" returns to the cart view rather than advancing
  // into oblivion. Commit 5 will fill the cart in; until then this is
  // the natural exit from a sub-wizard.
  const handleNext = () => {
    if (isLastStep) {
      dispatch({ type: "setActiveItem", id: null });
    } else {
      dispatch({ type: "next" });
    }
  };

  return (
    <section className="mx-auto max-w-2xl p-6">
      <Breadcrumb steps={steps} stepIndex={stepIndex} />

      <div className="rounded-lg border border-gray-200 p-6">
        <h2 className="mb-4 text-xl font-semibold">{currentStep.title}</h2>
        <stepUntyped.Component
          item={activeItem}
          session={session}
          onChange={(patch) => dispatch({ type: "updateItem", id: activeItem.id, patch })}
        />
        <p className="mt-4 text-xs text-gray-400">
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

function Breadcrumb({ steps, stepIndex }: { steps: StepDef[]; stepIndex: number }) {
  return (
    <ol className="mb-6 flex flex-wrap gap-2 text-sm">
      {steps.map((s, i) => (
        <li
          key={s.id}
          className={
            i === stepIndex
              ? "font-semibold text-black"
              : i < stepIndex
                ? "text-gray-500"
                : "text-gray-300"
          }
        >
          {s.title}
          {i < steps.length - 1 && <span className="ml-2 text-gray-300">›</span>}
        </li>
      ))}
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
    <div className="mt-4 flex justify-between">
      <button
        type="button"
        onClick={onBack}
        disabled={stepIndex === 0}
        className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40"
      >
        Back
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!canAdvance}
        title={reason}
        className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
      >
        {nextLabel}
      </button>
    </div>
  );
}
