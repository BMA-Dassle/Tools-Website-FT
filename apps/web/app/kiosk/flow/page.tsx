import { KioskFlow } from "~/features/kiosk/components/KioskFlow";

/**
 * The kiosk booking flow — category chooser → activity wizard → cart →
 * checkout. All client-side; the ?goto= param deep-links straight into an
 * activity (attract quick chips).
 */
export default async function KioskFlowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const goto = typeof sp.goto === "string" ? sp.goto : null;
  // Single-time-pick bowling flow preview opt-in (dark-flag testing on the
  // kiosk without env changes) — /kiosk/flow?bowlingV3=1.
  const bowlingV3 = sp.bowlingV3 === "1";
  // Coupon/voucher code entry preview opt-in — /kiosk/flow?kioskPromo=1.
  const kioskPromo = sp.kioskPromo === "1";
  return <KioskFlow goto={goto} bowlingV3={bowlingV3} kioskPromo={kioskPromo} />;
}
