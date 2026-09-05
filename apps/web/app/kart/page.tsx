import type { Metadata } from "next";
import { KartEntry } from "~/components/features/driver-view/KartEntry";
import { resolveLocale } from "~/features/racing/driver-view/locale";

/**
 * The way in to the driver view: a kart number and nothing else.
 *
 * FASTTRAX ONLY. Karting does not exist at HeadPinz, so this is deliberately NOT
 * registered in middleware's `SHARED_TOP_LEVEL_ROUTES` — a headpinz.com visitor
 * is rewritten to `/hp/kart` and 404s, which is correct. `/leaderboards` works
 * the same way. If a HeadPinz equivalent ever appears, register it in the same
 * commit or FastTrax guests start 404ing instead.
 */
export const metadata: Metadata = {
  title: "Live timing | FastTrax",
  description: "Follow your kart — live position, lap times and flags.",
  robots: { index: false, follow: false },
};

export default async function KartEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang } = await searchParams;
  return <KartEntry locale={resolveLocale(lang)} />;
}
