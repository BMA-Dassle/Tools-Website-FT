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
 * FastTrax duckpin on QAMF (center 11542). LIVE by default (owner 2026-07-22) —
 * `duck-pin` routes to QAMF bowling at 11542 (30/60/90 per lane, no shoes) and
 * the legacy BMI attraction path is bypassed. This is a KILL SWITCH: set
 * `NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN="false"` in Vercel to instantly revert to
 * the BMI duckpin attraction (no deploy needed). `?ftDuckpin=1` also forces it on
 * per-session (harmless now that the default is on). See
 * tasks/fasttrax-qamf-duckpin-plan.md.
 */
export function fasttraxQamfDuckpinEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN !== "false";
}

/** Is FastTrax QAMF duckpin active for THIS session (env flag or preview param)? */
export function fasttraxQamfDuckpinActive(session: Pick<BookingSession, "context">): boolean {
  return fasttraxQamfDuckpinEnabled() || session.context?.ftDuckpin === true;
}

/**
 * "Bowl Now" / "Play Now" per-lane QR flow (FastTrax duckpin, center 11542).
 * ON by default — the ONLY way in is scanning a physical per-lane QR
 * (`?playNow=1&lane=N`); there is no discoverable public route, so there is no
 * exposure risk in leaving it enabled while it bakes. KILL SWITCH: set
 * `NEXT_PUBLIC_FASTTRAX_PLAY_NOW="false"` in Vercel to disable instantly.
 */
export function fasttraxPlayNowEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FASTTRAX_PLAY_NOW !== "false";
}

/**
 * Is "Play Now" active for THIS session? Unlike the flow flags above, Play Now
 * is NEVER globally on — it activates only for a session that entered via a
 * per-lane QR (`context.playNow`); the env flag is purely a kill switch.
 */
export function playNowActive(session: Pick<BookingSession, "context">): boolean {
  return session.context?.playNow === true && fasttraxPlayNowEnabled();
}
