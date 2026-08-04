/**
 * Revoking express lane — the BMI STATE half of the demotion.
 *
 * Express-lane WEB bookings are stamped into BMI's custom "Confirmation Kiosk"
 * state at confirmation time (`app/api/notifications/booking-confirmation`),
 * because an express party skips Guest Services and staff work both "skip the
 * desk" rails from the same state. On the kiosk rail that state is only ever
 * reached AFTER everyone has signed, so to the front desk and the track it reads
 * as "waivers are done, send them to the karts."
 *
 * That makes the stamp a claim about waivers — and a demotion that only clears
 * `fastLane` on the Redis record and rewrites the memo leaves the reservation
 * asserting the opposite of its own memo: W54793 (7/28) sat in
 * "Confirmation - Kiosk" with "** NO VALID WAIVER **" written underneath it.
 * Nothing on the operational screens contradicts the state, so the guest walks
 * to the track unsigned.
 *
 * Rule: express is granted as (memo + state) and must be revoked as (memo +
 * state). This module owns the state half so every demoter — the race-day
 * re-verify sweep today, a cron later — gets it right by construction.
 */
import {
  KIOSK_CONFIRMATION_STATE_IDS,
  fetchProject,
  officeProjectIdFromBillId,
  setProjectState,
} from "@/lib/bmi-office-actions";

/** Plain "Confirmation" — where a booked, paid, not-yet-arrived reservation sits. */
export const CONFIRMATION_STATE_ID = "-3";

export type ExpressStateRevert =
  /** We owned the state (it was the kiosk id) and moved it back to Confirmation. */
  | { outcome: "reverted"; from: string }
  /** Someone else owns this row's state now — deliberately untouched. */
  | { outcome: "left-alone"; state: string | null }
  | { outcome: "failed"; error: string };

/**
 * Move a demoted express reservation off the kiosk confirmation state back to
 * plain Confirmation (-3) — but ONLY if it is still sitting in the state we
 * stamped. Anything else (-4 cancelled, -5 arrived, a waiver state, an already
 * plain -3) is left alone: writing -3 over those would revive a cancel or
 * un-check-in a guest standing at the counter.
 *
 * Safe to call repeatedly — a second call reports `left-alone`.
 */
export async function revertExpressKioskState(params: {
  billId: string;
  /**
   * Pandora/Office slug. RACE projects live under the FastTrax Pandora location
   * (`fasttrax` → LAB52GY480CJF), which is what the -3 write needs — the same
   * slug unified-reserve uses for its inline confirm. `fort-myers` and
   * `fasttrax` share the BMI client key, so the Office read works either way.
   */
  centerCode?: "fort-myers" | "fasttrax" | "naples";
  /** Defaults to billId + 1 (the Office project id). */
  officeProjectId?: string;
  label?: string;
}): Promise<ExpressStateRevert> {
  const centerCode = params.centerCode ?? "fasttrax";
  const kioskStateId = KIOSK_CONFIRMATION_STATE_IDS[centerCode];
  const projectId = params.officeProjectId ?? officeProjectIdFromBillId(params.billId);

  try {
    // Read-only use of the parsed project: we take `stateId` and nothing else,
    // and never write this object back — so the 17-digit ids it carries are
    // never re-serialized from the rounded parse.
    const project = await fetchProject(centerCode, projectId);
    const current = project?.stateId != null ? String(project.stateId) : null;
    if (!current || !kioskStateId || current !== kioskStateId) {
      return { outcome: "left-alone", state: current };
    }
    await setProjectState({
      centerCode,
      projectId,
      stateId: CONFIRMATION_STATE_ID,
      label: params.label ?? "Express lane revoked — needs Guest Services",
    });
    return { outcome: "reverted", from: current };
  } catch (err) {
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
