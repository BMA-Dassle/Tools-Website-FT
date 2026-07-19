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
