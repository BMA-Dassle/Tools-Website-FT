/**
 * When the Naples advertising window closes.
 *
 * Eastern wall-clock, no offset — `dealOfferEndsAt()` applies the real ET offset
 * for that calendar day from the tz database. Never hardcode `-04:00`/`-05:00`
 * here; this repo has shipped that off-by-one twice.
 *
 * ITS OWN MODULE, tiny as it is, so a test can assert it parses and lands where
 * it claims to without importing the popup's server shell (which pulls in the
 * deal catalog and the database layer). A typo in a deadline should fail a unit
 * test, not go live.
 *
 * TO EXTEND OR END THE OFFER, change this one line. Past it the modal renders
 * nothing, with no other edit anywhere.
 */
export const NAPLES_OFFER_ENDS_AT = "2026-08-07T23:59:59";

/**
 * Is the window still open, as of now?
 *
 * Async, and deliberately: reading the clock directly in a component's render
 * body trips Next 16's `react-hooks/purity` rule, which is correct to complain —
 * a component's output should be a function of its inputs, and `Date.now()` is
 * not one. Awaiting it keeps the impure read on the request path where it
 * belongs, and keeps the component honestly declaring that it depends on it.
 *
 * @param endsAtIso a fully-offset instant from `dealOfferEndsAt()`
 */
export async function naplesOfferIsOpen(endsAtIso: string): Promise<boolean> {
  return Date.now() < new Date(endsAtIso).getTime();
}
