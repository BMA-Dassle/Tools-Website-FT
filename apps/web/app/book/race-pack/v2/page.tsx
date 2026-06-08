import type { Metadata } from "next";
import { RacePackFlow } from "~/components/features/booking/RacePackFlow";

/**
 * v2 race-pack purchase — `/book/race-pack/v2`.
 *
 * Standalone credit-pack flow (NOT the multi-activity cart): buy N prepaid race
 * credits that load onto a racer's BMI/Pandora deposit ledger, redeemed later at
 * $0/heat in the normal race flow. Replaces v1 `/book/race-packs`; the cutover
 * redirect (middleware `bookingV2Target`) sends `/book/race-packs` here. The
 * `/book/race-packs/confirmation` page is reused for the success screen.
 *
 * FastTrax-only (racing) — no brand switch needed.
 */

export const metadata: Metadata = {
  title: "Buy a Race Pack",
  description: "Prepay race credits at a discount and redeem them whenever you book a heat.",
};

export default function RacePackV2Page() {
  return <RacePackFlow />;
}
