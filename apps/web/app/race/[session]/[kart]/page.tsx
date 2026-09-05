import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RaceReportView } from "~/components/features/driver-view/RaceReportView";
import { readDriverReport } from "~/features/racing/driver-view/report.server";
import { headline } from "~/features/racing/driver-view/report";
import { normaliseKart } from "~/features/racing/driver-view/service.server";
import { resolveLocale } from "~/features/racing/driver-view/locale";

/**
 * One driver's race report — the page a post-race text or email will point at.
 *
 * THE URL IS THE SHARE TOKEN, and it is deliberately guessable-but-boring:
 * `/race/58691643/15`. There is nothing behind it a spectator could not read off
 * the wall — a first name, lap times, a flag — and requiring a minted code would
 * mean a table, an expiry, and a link that dies before the guest opens it. If
 * that trade ever changes, the place to add a code is here, not in the data.
 *
 * The messaging itself is NOT built yet (owner: page first). `headline()` is
 * exported from the report module so the SMS, the email subject and this page
 * cannot drift apart when it is.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ session: string; kart: string }>;
}): Promise<Metadata> {
  const { session, kart } = await params;
  const normalised = normaliseKart(kart);
  if (!normalised) return { robots: { index: false } };
  const found = await readDriverReport(session, normalised);
  return {
    title: found ? headline(found.report, normalised) : "Race report | FastTrax",
    robots: { index: false, follow: false },
  };
}

export default async function DriverReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ session: string; kart: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const [{ session, kart }, { lang }] = await Promise.all([params, searchParams]);
  if (!/^\d{1,20}$/.test(session)) notFound();
  const normalised = normaliseKart(kart);
  if (!normalised) notFound();

  const found = await readDriverReport(session, normalised);
  if (!found) notFound();

  return (
    <RaceReportView report={found.report} driver={found.driver} locale={resolveLocale(lang)} />
  );
}
