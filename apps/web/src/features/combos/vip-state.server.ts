/**
 * The BMI STATE half of an Ultimate VIP Experience booking.
 *
 * Owner 2026-08-02: every VIP experience reservation must read
 * **"Confirmation - VIP"** in BMI, on every rail — web, kiosk-booked,
 * express-lane, and kiosk check-in. VIP wins over "Confirmation - Kiosk"
 * wherever the two would collide (owner decision; the waiver fact those rails
 * used to carry in the state column survives in the composed staff memo and the
 * admin board's gold VIP badge).
 *
 * This module is the ONE place that knows the state id, which states it may
 * claim, and how to make the write stick. Every rail calls `stampVipState()`
 * instead of hand-rolling a `setProjectState` — the same reason
 * `express-revoke.ts` owns the express state half. Read
 * tasks/lessons.md § "A status field IS a claim" before adding a writer.
 *
 * TWO TRAPS this module exists to absorb, both already paid for in production:
 *
 * 1. **Custom states go Office-API-first.** Pandora returns 200 and silently
 *    no-ops a custom (non-negative) state id. `setProjectState` already routes
 *    custom ids Office-first — we just must never bypass it.
 * 2. **The inline `-3` lands LATE.** Every reserve/reconcile/edit path confirms
 *    the project by writing `-3` through PANDORA, which propagates to Firebird
 *    asynchronously and can land AFTER our Office PUT — that race reverted ~80%
 *    of kiosk bookings on 2026-07-22. So the VIP stamp always runs with the
 *    `ensureAttempts` self-heal: re-read, and re-assert if a late `-3` clobbered
 *    it. Rails that stamp seconds after a `-3` MUST keep the default window.
 *
 * Server-only (`bmi-office-actions` pulls in node `https`), hence the `.server`
 * suffix and the deliberate absence from `features/combos/index.ts` — the combo
 * registry is imported by client components.
 */
import {
  KIOSK_CONFIRMATION_STATE_IDS,
  VIP_CONFIRMATION_STATE_IDS,
  fetchProject,
  officeProjectIdFromBillId,
  setProjectState,
} from "@/lib/bmi-office-actions";
import { isVipComboBooking } from "./combo-specials";

export { isVipComboBooking };

/** Plain "Confirmation" — where a booked, paid, not-yet-arrived project sits. */
export const CONFIRMATION_STATE_ID = "-3";

/**
 * States a VIP stamp is allowed to overwrite. An ALLOW-list, not a deny-list:
 * "revert/claim a state only from a value you recognise" (lessons 2026-07-28) —
 * a blind write would revive `-4` Cancellation or un-check-in a `-5` guest
 * standing at the counter.
 *
 *  - `-3` plain Confirmation — the overwhelming majority, what every reserve
 *    path leaves behind.
 *  - `-100/-101/-102` the pending-online ladder — a project mid-confirm. The
 *    reconcile/sweep crons write `-3` through Pandora to clear BMI's auto-cancel
 *    and then stamp VIP on top, so the stamp legitimately sees these.
 *  - the per-location kiosk confirmation ids — owner: VIP wins over kiosk.
 */
const CLAIMABLE_STATE_IDS: ReadonlySet<string> = new Set([
  CONFIRMATION_STATE_ID,
  "-100",
  "-101",
  "-102",
  ...Object.values(KIOSK_CONFIRMATION_STATE_IDS),
]);

/** The "Confirmation - VIP" id for a center, or null where BMI has no such
 *  state (Naples). Null is a legitimate answer, not an error — callers leave
 *  the project in plain Confirmation. */
export function vipConfirmationStateId(centerCode: string | null | undefined): string | null {
  return (centerCode && VIP_CONFIRMATION_STATE_IDS[centerCode]) || null;
}

export type VipStampResult =
  /** We moved the project onto the VIP state. */
  | { outcome: "stamped"; from: string }
  /** Already sitting in the VIP state — nothing to do (safe re-run). */
  | { outcome: "already" }
  /** Someone else owns this project's state now (-4 cancelled, -5 arrived, a
   *  waiver state, …) — deliberately untouched. */
  | { outcome: "left-alone"; state: string | null }
  /** This center has no VIP state, or the caller gave us nothing to address. */
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

/**
 * Move an Ultimate VIP Experience's BMI project onto "Confirmation - VIP".
 *
 * Read-then-compare: only claims a state in `CLAIMABLE_STATE_IDS`, so it is
 * safe to call from a cron, a retry, or twice in a row. Never throws — the
 * booking/charge it follows has already succeeded, and a vendor hiccup must
 * never surface to the guest.
 */
export async function stampVipState(params: {
  /** Pandora/Office slug. Race projects live under `fasttrax`; `fort-myers`
   *  shares the same BMI client key, so either resolves the state id. */
  centerCode: string;
  /** Office project id. Defaults to `billId + 1`. */
  officeProjectId?: string;
  billId?: string;
  /** Log suffix — which rail stamped it. */
  label?: string;
  /** Self-heal window against a late-landing Pandora `-3` (see module header).
   *  Defaults to 3 × 4s, matching the kiosk rail. Pass 0 ONLY where no `-3`
   *  write can still be in flight (the backfill on historical rows). */
  ensureAttempts?: number;
  ensureGapMs?: number;
}): Promise<VipStampResult> {
  const stateId = vipConfirmationStateId(params.centerCode);
  if (!stateId) {
    return { outcome: "skipped", reason: `no VIP state for center ${params.centerCode}` };
  }
  const projectId =
    params.officeProjectId ??
    (params.billId ? officeProjectIdFromBillId(params.billId) : undefined);
  if (!projectId) return { outcome: "skipped", reason: "no projectId or billId" };

  try {
    // Read-only use of the parsed project: we take `stateId` and nothing else,
    // and never write this object back — so the 17-digit ids it carries are
    // never re-serialized from the rounded parse (BMI ID precision rule).
    const project = await fetchProject(params.centerCode, projectId);
    const current = project?.stateId != null ? String(project.stateId) : null;
    if (current === stateId) return { outcome: "already" };
    if (!current || !CLAIMABLE_STATE_IDS.has(current)) {
      return { outcome: "left-alone", state: current };
    }

    await setProjectState({
      centerCode: params.centerCode,
      projectId,
      stateId,
      label: params.label ?? "Confirmation - VIP",
      ensureAttempts: params.ensureAttempts ?? 3,
      ensureGapMs: params.ensureGapMs ?? 4000,
    });
    return { outcome: "stamped", from: current };
  } catch (err) {
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Convenience for the booking/check-in rails: stamp only when the reservation
 * really is a VIP combo, and log the outcome under the caller's tag. Returns
 * the result so a caller that wants to branch still can; never throws.
 */
export async function stampVipStateIfCombo(params: {
  comboSpecialId: string | null | undefined;
  centerCode: string;
  officeProjectId?: string;
  billId?: string;
  label?: string;
  /** Log tag, e.g. "kiosk-post" / "unified-reserve". */
  tag: string;
  ensureAttempts?: number;
  ensureGapMs?: number;
}): Promise<VipStampResult> {
  if (!isVipComboBooking(params.comboSpecialId)) {
    return { outcome: "skipped", reason: "not a combo booking" };
  }
  const result = await stampVipState(params);
  const projectRef = params.officeProjectId ?? params.billId ?? "?";
  if (result.outcome === "failed") {
    console.error(`[${params.tag}] Confirmation - VIP stamp failed for ${projectRef}:`, result.error);
  } else if (result.outcome === "left-alone") {
    console.log(
      `[${params.tag}] Confirmation - VIP skipped for ${projectRef} — state ${result.state} is not ours`,
    );
  } else if (result.outcome === "stamped") {
    console.log(`[${params.tag}] Confirmation - VIP set for ${projectRef} (was ${result.from})`);
  }
  return result;
}
