/**
 * Deal-pack kill switches. Both default ON — a flag here exists to turn
 * something OFF in a hurry, never to hold a merged feature back.
 *
 * Read on the SERVER, deliberately, and passed down as props. A `NEXT_PUBLIC_`
 * variable is baked into the bundle at build time, so flipping one means a
 * redeploy and a round of "did it actually rebuild?" — which is exactly what an
 * emergency switch must not require.
 */

/**
 * The countdown and the packs-remaining line.
 *
 * PRESENTATION ONLY. It never touches `resolveDealOffer`: a switch that
 * silently raised a price we are actively advertising would not be a safety
 * mechanism, it would be the incident. Turning this off hides the urgency
 * furniture and leaves the launch price running exactly as promised.
 */
export function dealsUrgencyUiEnabled(): boolean {
  return process.env.DEALS_URGENCY_UI !== "false";
}

/** The abandoned-checkout recovery sweep. Off = the cron does nothing. */
export function dealsAbandonEmailEnabled(): boolean {
  return process.env.DEALS_ABANDON_EMAIL !== "false";
}
