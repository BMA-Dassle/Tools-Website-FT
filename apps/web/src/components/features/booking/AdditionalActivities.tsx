"use client";

import Link from "next/link";
import { crossSellFor, type BookingSession } from "~/features/booking";

/**
 * "Add to your visit" tiles for the session cart.
 *
 * Mirrors v1's cross-sell pattern from `app/book/[attraction]/page.tsx`
 * lines 1791–1825 — small tiles in a 2-col grid on a dark background,
 * `bg-white/3` resting state, `bg-white/6` hover.
 *
 * Driven by the v2 activities catalog so every booking surface gets the
 * same rules:
 *   - Filters by session.center (one center per cart).
 *   - Excludes activities already in the cart (one of each kind;
 *     attractions excluded per-slug so multiple attractions are OK).
 *   - KBF stays in cross-sell — its identity gate fires inside its own
 *     sub-wizard the first time, then subsequent KBF items reuse the
 *     verified pass.
 *
 * Tile click navigates to the activity's v2 URL. The wizard there picks
 * up the existing session via shared state (sessionStorage in PR-B2 or
 * the Square Order id once it exists) and lands the customer back in the
 * cart once that sub-wizard completes its add-to-cart step.
 */
export function AdditionalActivities({ session }: { session: BookingSession }) {
  const offerings = crossSellFor(session);
  if (offerings.length === 0) return null;

  return (
    <section className="mt-8" aria-labelledby="add-to-visit-heading">
      <h2
        id="add-to-visit-heading"
        className="text-xs font-bold uppercase tracking-wider text-[#00E2E5]"
      >
        Add to your visit
      </h2>
      <ul className="mt-3 grid grid-cols-2 gap-2">
        {offerings.map((o) => (
          <li key={o.slug}>
            <Link
              href={`/book/${o.slug}/v2`}
              className="block rounded-lg border border-white/10 bg-white/3 p-3 text-center transition-all hover:border-white/20 hover:bg-white/6"
            >
              <div className="text-sm font-semibold text-white">{o.displayName}</div>
              <div className="mt-0.5 text-xs text-white/40">{o.blurb}</div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
