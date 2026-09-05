import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DriverScreen } from "~/components/features/driver-view/DriverScreen";
import { normaliseKart } from "~/features/racing/driver-view/service.server";
import { resolveLocale } from "~/features/racing/driver-view/locale";

/**
 * The live driver view for one kart.
 *
 * A THIN SHELL. Everything live happens in the client component: the timing
 * socket is opened by the BROWSER (never by us — a server connection displaces
 * the live subscribers and takes the boards down mid-race), and the flags come
 * from `/api/kart/[number]`. Rendering this on the server would only produce a
 * frame that is already stale.
 *
 * NOT INDEXED. It is a live view of one kart on one night; there is nothing here
 * for a search engine, and a stale cached copy would be worse than nothing.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function KartPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const [{ number }, { lang }] = await Promise.all([params, searchParams]);
  const kart = normaliseKart(number);
  if (!kart) notFound();

  return <DriverScreen kart={kart} locale={resolveLocale(lang)} />;
}
