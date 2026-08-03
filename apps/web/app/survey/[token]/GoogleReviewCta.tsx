"use client";

import { clarityEvent } from "~/lib/clarity";
import type { Theme } from "./theme";

/**
 * The Google review ask.
 *
 * Rendered ONLY for guests whose own answers say the visit went well — the
 * caller applies `isPositiveSentiment` and passes nothing when it fails, so
 * this component never decides who gets asked.
 *
 * Two deliberate choices:
 *   - `href` points at our own /api/surveys/[token]/review rather than straight
 *     at Google, so the click is recorded server-side (a beacon on a new-tab
 *     click is exactly the case that gets dropped) and the sentiment gate is
 *     re-verified against the stored responses.
 *   - `target="_blank"` is REQUIRED, not cosmetic: on the gift-card screen this
 *     sits below the QR code, the gift-card number and the GS-XXXX promo code.
 *     Navigating away in-place would take all of that off the guest's screen.
 *
 * Styled as an accent-OUTLINED button rather than a filled one so it never
 * competes with "Add to Apple Wallet", the primary action on that same screen.
 */
export function GoogleReviewCta({ t, token }: { t: Theme; token: string }) {
  return (
    <div
      className="rounded-xl p-5 mt-7"
      style={{ backgroundColor: t.card, border: `1px solid ${t.border}` }}
    >
      <div className="font-heading text-lg font-bold text-white mb-1">Got 10 more seconds?</div>
      <p className="text-sm leading-snug mb-4" style={{ color: t.muted }}>
        You made our day. A quick Google rating is the single biggest help you can give us.
      </p>
      <a
        href={`/api/surveys/${encodeURIComponent(token)}/review`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => clarityEvent("survey:review_click")}
        className="block w-full rounded-lg font-heading font-bold py-3.5 text-base text-center"
        style={{ border: `2px solid ${t.accent}`, color: t.accent }}
      >
        Rate us on Google
      </a>
    </div>
  );
}
