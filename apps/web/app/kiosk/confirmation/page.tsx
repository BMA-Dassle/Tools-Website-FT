import { KioskConfirmation } from "~/features/kiosk/components/KioskConfirmation";

/**
 * Kiosk confirmation. `?src=` carries the web confirmation URL CheckoutStep
 * would have navigated to — the kiosk page surfaces its booking code and
 * auto-resets for the next guest.
 */
export default async function KioskConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const src = typeof sp.src === "string" ? sp.src : null;
  return <KioskConfirmation src={src} />;
}
