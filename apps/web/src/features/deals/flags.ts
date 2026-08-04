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
 * The URGENCY furniture only: the ticking countdown and the packs-remaining
 * counter, on `/deals` and its hub.
 *
 * It does NOT hide the bonus itself, and deliberately so. What a pack contains
 * is a fact about what someone is buying and belongs in front of them at the
 * moment they buy it; the clock is a persuasion device. Those are different
 * things and they get different switches — turning the pressure off must not
 * quietly stop telling a buyer what is in the box (owner 2026-08-03: "I turned
 * off urgency UI, don't like it", while still wanting the offer to run).
 *
 * It also never touches `resolveDealOffer`: a switch that silently changed what
 * we grant for money already advertised would not be a safety mechanism, it
 * would be the incident.
 */
export function dealsUrgencyUiEnabled(): boolean {
  return process.env.DEALS_URGENCY_UI !== "false";
}

/**
 * The Naples site popup.
 *
 * ITS OWN SWITCH, separate from the urgency UI, because it is a CHANNEL rather
 * than a persuasion device — the only route by which the deal packs are
 * advertised on the website at all. `/deals` is a Google/paid-search landing
 * page and is otherwise unlinked from the site (owner 2026-08-03: "we can say
 * this on naples as it would normally not be offered directly through our
 * website; /deals is a google based offer"). Folding it into
 * `DEALS_URGENCY_UI` meant switching off a countdown also switched off the
 * advertising, which is not a trade anyone would knowingly make.
 */
export function dealsNaplesPopupEnabled(): boolean {
  return process.env.DEALS_NAPLES_POPUP !== "false";
}

/** The abandoned-checkout recovery sweep. Off = the cron does nothing. */
export function dealsAbandonEmailEnabled(): boolean {
  return process.env.DEALS_ABANDON_EMAIL !== "false";
}
