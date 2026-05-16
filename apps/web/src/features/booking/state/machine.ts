/**
 * Booking state machine — a thin reducer over the Draft union.
 *
 * No XState (zero state-machine deps; transitions are mostly linear with
 * conditional skips). Per-activity step ordering lives in steps.ts; this
 * file only handles "where is the cursor" + "mutate the draft."
 *
 * Each activity-specific step component dispatches an action like
 * `{ type: "set", patch: { date: "2026-06-01" } }`. The reducer applies the
 * patch shallow-merge style and the registry recomputes which step is next.
 *
 * The reducer NEVER destroys data on back-nav — only the cursor moves. This
 * is what makes the wizard back-button safe.
 */
import type { Draft } from "./types";

export interface BookingState {
  draft: Draft;
  /** Index into the per-activity step list. */
  stepIndex: number;
}

export type Action =
  /** Shallow-merge a patch into the draft. Identity selections only. */
  | { type: "set"; patch: Partial<Draft> }
  /** Advance the cursor by one step. canAdvance gating is the host's job. */
  | { type: "next" }
  /** Back up the cursor. Draft state is preserved. */
  | { type: "back" }
  /** Jump to a specific step (e.g. from a breadcrumb click). */
  | { type: "goto"; index: number };

export function reducer(state: BookingState, action: Action): BookingState {
  switch (action.type) {
    case "set":
      // Cast is safe at runtime — the patch is constrained to the active
      // activity's fields at the call site. TS can't prove cross-union
      // patches; the StepDef<A> generic guards this at the caller.
      return { ...state, draft: { ...state.draft, ...action.patch } as Draft };
    case "next":
      return { ...state, stepIndex: state.stepIndex + 1 };
    case "back":
      return { ...state, stepIndex: Math.max(0, state.stepIndex - 1) };
    case "goto":
      return { ...state, stepIndex: Math.max(0, action.index) };
  }
}
