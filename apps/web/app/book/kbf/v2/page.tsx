import type { Metadata } from "next";
import { BookingFlow } from "~/components/features/booking";
import { findOffering, isOfferingInPromoScope, type EntryContext } from "~/features/booking";
import { parseEntryContextFromSearchParams } from "~/features/booking/state/parse-entry-context";
import { resolveAppliedPromo, type AppliedPromo } from "~/features/discount-codes";

export const metadata: Metadata = {
  title: "Kids Bowl Free — Reserve a lane (v2)",
  description:
    "Free summer bowling for KBF-registered kids. Look up your family pass and reserve a lane.",
};

/**
 * Kids Bowl Free v2 entry. Distinct route from /book/[attraction]/v2 because:
 *   - HeadPinz-only (the customer is always on a HeadPinz brand experience).
 *   - COPPA + parental verification flow needs its own SEO + privacy posture.
 *   - The composite "Verify" step (lookup → 6-digit code → roster) is the
 *     first step of the kbf item rather than threading through generic UI.
 *
 * entryBrand is pinned to "headpinz" — there is no FastTrax KBF.
 *
 * Promo `?code=` handling mirrors the `[attraction]/v2` page — see
 * memory: booking_v2_promo_integration.md. KBF lives under the "bowling"
 * discount domain in the discount-codes schema.
 */
export default async function KbfV2Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const initialContext: EntryContext = parseEntryContextFromSearchParams(sp);

  const codeRaw = sp.code;
  const code = typeof codeRaw === "string" ? codeRaw.trim().toUpperCase() : "";
  let initialPromo: AppliedPromo | null = null;
  if (code) {
    const promo = await resolveAppliedPromo(code);
    if (promo) {
      const offering = findOffering("kbf");
      if (offering && isOfferingInPromoScope(offering, promo)) {
        initialPromo = promo;
      }
      // Wrong-domain / unusable codes: render KBF without the promo
      // applied. No redirect (removed 2026-05-21 — unclear flow).
    }
  }

  return (
    <BookingFlow
      activity="kbf"
      entryBrand="headpinz"
      initialContext={initialContext}
      initialPromo={initialPromo}
      urlCode={code || null}
      initialCheckout={sp.checkout === "1"}
    />
  );
}
