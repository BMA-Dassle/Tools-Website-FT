/**
 * Web-sales kill switches.
 *
 * KILL SWITCHES ONLY — never opt-in gates (owner rule 2026-07-31). Every flag
 * here defaults ON via `!== "false"`, so a merged feature is a live feature and
 * nobody has to remember to turn anything on. If something is not ready to be
 * on, it is not ready to merge; it stays on a branch and gets tested through its
 * preview deployment.
 *
 * These exist for one reason: an emergency off switch for a money surface that is
 * misbehaving at 9pm on a Saturday, without a deploy.
 *
 * Server-only (no `NEXT_PUBLIC_`). They gate route handlers, not rendering — a
 * client-readable kill switch on a refund would be advisory at best.
 */

import { SALE_SOURCE_IDS, type SaleSourceId } from "./types";

/**
 * Comma-separated source ids to drop from the board entirely.
 *
 * Unset or empty = every registered source is live. Set it when one adapter's
 * upstream is down and its rows are noise or, worse, wrong.
 */
export function disabledSaleSources(): Set<SaleSourceId> {
  const raw = process.env.WEB_SALES_SOURCES_OFF || "";
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return new Set(SALE_SOURCE_IDS.filter((id) => wanted.has(id)));
}

/**
 * Money movement, all destinations.
 *
 * OFF still renders the full refund plan — it only refuses to execute. Learning
 * a feature is disabled at the moment you click the money button is the worst
 * possible time to find out; the preview says so up front instead.
 */
export function webSalesRefundsEnabled(): boolean {
  return process.env.WEB_SALES_REFUNDS !== "false";
}

/**
 * The cross-tender gift-card destination specifically.
 *
 * Separate from the master switch because it is the newer, stranger rail: it is
 * the one refund Square will not let us itemize, so being able to drop just that
 * destination while leaving card refunds working is worth its own flag.
 */
export function webSalesGiftCardRefundEnabled(): boolean {
  return process.env.WEB_SALES_REFUND_TO_GC !== "false";
}
