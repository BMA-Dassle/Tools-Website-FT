/**
 * Booking feature flags (house env-flag pattern — see
 * src/features/world-cup/flags.ts). Env reads happen at CALL time so vitest
 * can stub them; Next.js still inlines NEXT_PUBLIC_* in client bundles.
 */
import type { BookingSession } from "./state/types";

/**
 * Single-time-pick bowling flow (v3): Date → Experience (merged tier+package+
 * duration) → Time ("Next Available" hero + accurate slot grid, tap = hold).
 * Replaces the classic Slots → Tier → Offer double-time-pick flow.
 *
 * DARK while the flow bakes: opt-in via `NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW=
 * "true"` in Vercel, or per-session via `?bowlingV3=1` (EntryContext.bowlingV3)
 * for preview-URL testing without env changes. The FLIP PR changes this to a
 * default-on kill switch (`!== "false"`) after ops sign-off — see
 * tasks/bowling-reservation-flow-plan.md §11.
 */
export function bowlingOneTimeFlowEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW === "true";
}

/** Is the v3 bowling flow active for THIS session (env flag or preview param)?
 *  Sessions never switch flows mid-flight: context is seeded at creation. */
export function bowlingV3Active(session: Pick<BookingSession, "context">): boolean {
  return bowlingOneTimeFlowEnabled() || session.context?.bowlingV3 === true;
}

/**
 * FastTrax duckpin on QAMF (center 11542). DARK by default — while off, the
 * `duck-pin` offering stays the legacy BMI attraction and NOTHING routes to
 * QAMF/11542, so the flag-off state is byte-identical to today. Flip via
 * `NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN="true"` in Vercel (or `?ftDuckpin=1` per
 * session for preview testing) once the catalog is seeded and ops signs off.
 * See tasks/fasttrax-qamf-duckpin-plan.md.
 */
export function fasttraxQamfDuckpinEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN === "true";
}

/** Is FastTrax QAMF duckpin active for THIS session (env flag or preview param)? */
export function fasttraxQamfDuckpinActive(session: Pick<BookingSession, "context">): boolean {
  return fasttraxQamfDuckpinEnabled() || session.context?.ftDuckpin === true;
}
