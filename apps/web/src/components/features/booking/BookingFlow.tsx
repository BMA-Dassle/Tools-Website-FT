"use client";

import { useMemo, useReducer } from "react";
import {
  emptyDraft,
  reducer,
  STEP_REGISTRY,
  type Activity,
  type BookingState,
  type CenterCode,
} from "~/features/booking";

/**
 * BookingFlow — orchestrator shell for the unified v2 booking wizard.
 *
 * Reads the per-activity step registry, drives the reducer, renders the
 * current step's component. The host is dumb: it doesn't know about
 * activity-specific logic — that lives in each step's Component.
 *
 * PR-B1 ships the SHELL. Real step components and step transitions land
 * per-activity in PR-B2..B6. For now we just confirm the host wires up:
 *   - emptyDraft seeds the reducer
 *   - STEP_REGISTRY picks the right step list per activity
 *   - Next / Back / step breadcrumb work against placeholder steps
 */
export interface BookingFlowProps {
  activity: Activity;
  /** Optionally preselect a center (from the chooser or URL param). */
  initialCenter?: CenterCode | null;
}

export function BookingFlow({ activity, initialCenter = null }: BookingFlowProps) {
  const initialState: BookingState = useMemo(
    () => ({ draft: { ...emptyDraft(activity), center: initialCenter }, stepIndex: 0 }),
    [activity, initialCenter],
  );
  const [state, dispatch] = useReducer(reducer, initialState);

  const steps = STEP_REGISTRY[activity];
  const currentStep = steps[state.stepIndex];

  if (!currentStep) {
    // Past the last step — this is where the confirmation page would render.
    return (
      <section className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-semibold">Booking complete</h1>
        <p className="mt-2 text-sm text-gray-600">
          Confirmation view ships in the per-activity PR. Order id:{" "}
          <code>{state.draft.squareOrderId ?? "(none)"}</code>
        </p>
      </section>
    );
  }

  const canAdvance = currentStep.canAdvance(state.draft);
  const advanceOk = canAdvance === true;

  return (
    <section className="mx-auto max-w-2xl p-6">
      {/* Breadcrumb */}
      <ol className="mb-6 flex flex-wrap gap-2 text-sm">
        {steps.map((s, i) => (
          <li
            key={s.id}
            className={
              i === state.stepIndex
                ? "font-semibold text-black"
                : i < state.stepIndex
                  ? "text-gray-500"
                  : "text-gray-300"
            }
          >
            {s.title}
            {i < steps.length - 1 && <span className="ml-2 text-gray-300">›</span>}
          </li>
        ))}
      </ol>

      {/* Current step */}
      <div className="rounded-lg border border-gray-200 p-6">
        <h2 className="mb-4 text-xl font-semibold">{currentStep.title}</h2>
        <currentStep.Component draft={state.draft} />
        <p className="mt-4 text-xs text-gray-400">
          PR-B1 scaffold — step body lands in the per-activity PR ({activity}).
        </p>
      </div>

      {/* Navigation */}
      <div className="mt-4 flex justify-between">
        <button
          type="button"
          onClick={() => dispatch({ type: "back" })}
          disabled={state.stepIndex === 0}
          className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "next" })}
          disabled={!advanceOk}
          title={advanceOk ? undefined : canAdvance.reason}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </section>
  );
}
