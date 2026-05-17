import type { Metadata } from "next";
import { BookingFlow } from "~/components/features/booking";
import type { EntryContext } from "~/features/booking";
import { parseEntryContextFromSearchParams } from "~/features/booking/state/parse-entry-context";

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
 */
export default async function KbfV2Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const initialContext: EntryContext = parseEntryContextFromSearchParams(sp);
  return <BookingFlow activity="kbf" entryBrand="headpinz" initialContext={initialContext} />;
}
