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
  return <KioskFlow goto={goto} />;
}
