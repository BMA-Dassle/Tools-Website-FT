import { redirect } from "next/navigation";
import WalletPackClient from "~/features/racing/components/WalletPackClient";

export const dynamic = "force-dynamic";

/**
 * `/passes/{billId}` — where the kiosk's "add all to one phone" QR lands.
 *
 * A dedicated destination rather than the confirmation page: a guest who scans
 * a kiosk code to collect their licences should not arrive on a long booking
 * page and have to hunt for a card partway down it. This page has one job and
 * starts doing it on load.
 *
 * Possession of the billId is the auth, the same bar the confirmation page
 * applies — and the client only ever sees names, server-rendered QRs and
 * server-resolved hops, never a login code.
 */
export async function generateMetadata() {
  return {
    title: "Your FastTrax Racing Licences",
    // A booking's roster is not for crawlers.
    robots: { index: false, follow: false },
  };
}

export default async function WalletPackPage({
  params,
}: {
  params: Promise<{ billId: string }>;
}) {
  const { billId } = await params;
  const id = String(billId ?? "").trim();
  if (!/^\d+$/.test(id)) redirect("/book/race");
  return <WalletPackClient billId={id} />;
}
