/**
 * Refund policy alerts — configuration.
 *
 * When a refund shows up in Square on a reservation-linked payment that our
 * own flows did NOT create (someone refunded directly in the Square
 * Dashboard / POS instead of the Reservation Portal), we call it out in the
 * call-center Teams chat. Square-side refunds leave the reservation live on
 * the board (still "paid", heats still booked, settle crons retry forever) —
 * refunds must ALWAYS go through the portal's Cancel & Refund flow.
 *
 * Sent through the shared portal bot (lib/teams-bot.ts) — the bot must be a
 * member of the chat.
 */

/** Call-center staff chat (owner-provided 2026-07-10). */
export const DEFAULT_CHAT_ID = "19:a2976d4c4a6544db8c7839a6016ad86f@thread.v2";

/** Target chat — env override lets a canary point at a test chat without a deploy. */
export function refundAlertsChatId(): string {
  return process.env.REFUND_ALERTS_CHAT_ID || DEFAULT_CHAT_ID;
}

/** Kill switch: set REFUND_ALERTS_ENABLED=false to silence the cron
 *  (server-only env — flippable without a rebuild). Default ON: registering
 *  the cron in vercel.json is the deliberate enable act. */
export function refundAlertsEnabled(): boolean {
  return process.env.REFUND_ALERTS_ENABLED !== "false";
}

/** Deep link to the reservations admin board — the card's action button.
 *  Server-only (embeds the admin token); null when the env is missing so the
 *  pure card builder just omits the button. */
export function reservationsBoardUrl(): string | null {
  const token = process.env.ADMIN_CAMERA_TOKEN;
  return token ? `https://headpinz.com/admin/${token}/reservations` : null;
}

/** Deep link to the WEB SALES board — the deal-pack card's action button. Same
 *  token embedding and same null-when-missing behaviour as its sibling above. */
export function webSalesBoardUrl(): string | null {
  const token = process.env.ADMIN_CAMERA_TOKEN;
  return token ? `https://headpinz.com/admin/${token}/web-sales` : null;
}

/** How far back each run scans Square for refunds. Generous overlap with the
 *  cron cadence — the per-refund dedup key makes re-seeing a refund free, and
 *  a long window self-heals gaps from failed runs. */
export const LOOKBACK_HOURS = 24;

/** Fire-once dedup key lifetime per Square refund id. Must comfortably
 *  outlive LOOKBACK_HOURS so a refund can never re-alert once claimed. */
export const DEDUP_TTL_S = 30 * 24 * 60 * 60;

/** Safety valve: max alerts per day, far above any real day's mistakes. */
export const DAILY_SEND_CAP = 20;
