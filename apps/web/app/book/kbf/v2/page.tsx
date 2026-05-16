import type { Metadata } from "next";
import { BookingFlow } from "~/components/features/booking";

export const metadata: Metadata = {
  title: "Kids Bowl Free — Reserve a lane (v2)",
  description:
    "Free summer bowling for KBF-registered kids. Look up your family pass and reserve a lane.",
};

/**
 * Kids Bowl Free v2 entry. Distinct route from /book/[activity]/v2 because:
 *   - HeadPinz-only (cross-brand chooser surfaces it separately).
 *   - COPPA + parental verification flow needs its own SEO + privacy posture.
 *   - The composite "Verify" step (lookup → 6-digit code → roster) is the
 *     first step of the registry rather than threading through generic UI.
 */
export default function KbfV2Page() {
  return <BookingFlow activity="kbf" />;
}
