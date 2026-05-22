/**
 * Booking service layer — business logic, orchestration, no React.
 *
 * Per-activity service files (race.ts, bowling.ts, etc.) implement a
 * narrow shared interface (quote / hold / confirm / cancel). `checkout.ts`
 * is the activity-tagged dispatcher and also owns the Square Order
 * lifecycle around each service call.
 *
 * PR-B1 ships the interface + placeholder dispatchers. Real per-activity
 * services land in PR-B2..B6 alongside their data adapters.
 */
import type { Activity, ContactInfo } from "../types";

/**
 * Quote — non-mutating preview of what a booking will cost + reserve. UI
 * uses this to show a Cart summary before the customer commits.
 */
export interface BookingQuote {
  squareOrderId: string;
  totalCents: number;
  lineItems: Array<{ name: string; qty: number; unitCents: number }>;
  /** True iff this booking will create a real Square charge (e.g. KBF + no
   * paid add-ons → false). */
  requiresPayment: boolean;
}

/**
 * The narrow contract each per-activity service must satisfy. The orchestrator
 * (checkout.ts) calls these in the failure-mode sequence from
 * tasks/restructure-plan.md § "Failure modes":
 *
 *   1. quote()    → preview totals (no vendor mutation)
 *   2. hold()     → take vendor hold; returns the holder id for confirm/cancel
 *   3. confirm()  → finalize after payment captures (idempotent retry-safe)
 *   4. cancel()   → release vendor hold + cancel Square Order on user back-out
 */
export interface BookingService {
  quote(input: unknown): Promise<BookingQuote>;
  hold(input: unknown): Promise<{ holdId: string; squareOrderId: string }>;
  confirm(input: { holdId: string; contact: ContactInfo }): Promise<{ ok: true }>;
  cancel(input: { holdId: string; reason?: string }): Promise<{ ok: true }>;
}

/**
 * Activity → service dispatcher. PR-B2..B6 wire each entry to its concrete
 * impl. Until then, calls throw a clear "not implemented" so route handlers
 * fail loudly in dev rather than silently 200.
 */
export function getService(activity: Activity): BookingService {
  if (activity === "race") return raceService;

  const notYet = (op: string) => (): Promise<never> => {
    throw new Error(`booking.${activity}.${op}() not implemented (PR-B1 scaffold)`);
  };
  return {
    quote: notYet("quote"),
    hold: notYet("hold"),
    confirm: notYet("confirm"),
    cancel: notYet("cancel"),
  };
}

// ── Race service (PR-B2) ────────────────────────────────────────────────

import { holdRaceItem, confirmRaceOrder, cancelRaceOrder } from "./race";

const raceService: BookingService = {
  quote: () => {
    throw new Error("race.quote() not needed — checkout uses bill overview");
  },
  hold: (input) => {
    const { session, item, dispatch } = input as {
      session: import("../state/types").BookingSession;
      item: import("../state/types").RaceItem;
      dispatch: import("react").Dispatch<import("../state/machine").Action>;
    };
    return holdRaceItem(session, item, dispatch).then((r) => ({
      holdId: r.bmiBillId,
      squareOrderId: "",
    }));
  },
  confirm: async (input) => {
    await confirmRaceOrder(input.holdId);
    return { ok: true as const };
  },
  cancel: async (input) => {
    await cancelRaceOrder(input.holdId);
    return { ok: true as const };
  },
};
