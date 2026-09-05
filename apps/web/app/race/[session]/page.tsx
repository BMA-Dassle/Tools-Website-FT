import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RaceReportView } from "~/components/features/driver-view/RaceReportView";
import { readRaceReport } from "~/features/racing/driver-view/report.server";
import { resolveLocale } from "~/features/racing/driver-view/locale";

/**
 * The full result board for one heat.
 *
 * SERVER-RENDERED, no socket, no poll — the race is over and nothing moves. That
 * is also what makes this shareable: a link that works in a text message a week
 * later, with no client state to rehydrate.
 *
 * FastTrax only, like `/kart` — deliberately not in `SHARED_TOP_LEVEL_ROUTES`.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function RaceResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ session: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const [{ session }, { lang }] = await Promise.all([params, searchParams]);
  if (!/^\d{1,20}$/.test(session)) notFound();

  const report = await readRaceReport(session);
  if (!report) notFound();

  return <RaceReportView report={report} locale={resolveLocale(lang)} />;
}
