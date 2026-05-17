"use client";

import Link from "next/link";
import { crossSellFor, type BookingSession } from "~/features/booking";

/**
 * "Add another activity" tiles for the session cart.
 *
 * Mirrors v1's "Add to your visit" pattern from
 * `app/book/[attraction]/page.tsx`, but driven by the v2 activities
 * catalog so every booking surface gets the same rules:
 *   - Filters by session.center (one center per cart).
 *   - Excludes activities already in the cart (one of each kind;
 *     attractions excluded per-slug so multiple attractions are OK).
 *   - KBF stays in cross-sell — its identity gate fires inside its own
 *     sub-wizard step the first time, then subsequent KBF items reuse
 *     the verified pass.
 *
 * Tile click navigates to the activity's v2 URL. The wizard there picks
 * up the existing session via shared state (sessionStorage in PR-B2,
 * URL/Square Order id later) and lands the customer back in the cart
 * once that sub-wizard completes its add-to-cart step.
 */
export function AdditionalActivities({ session }: { session: BookingSession }) {
  const offerings = crossSellFor(session);
  if (offerings.length === 0) return null;

  return (
    <section className="mt-8" aria-labelledby="add-to-visit-heading">
      <h2
        id="add-to-visit-heading"
        className="text-sm font-semibold uppercase tracking-wide text-gray-500"
      >
        Add to your visit
      </h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {offerings.map((o) => (
          <li key={o.slug}>
            <Link
              href={`/book/${o.slug}/v2`}
              className="block rounded-lg border border-gray-200 p-4 transition hover:border-black"
            >
              <div className="font-semibold">{o.displayName}</div>
              <div className="text-sm text-gray-500">{o.blurb}</div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
