import { TvApp } from "~/features/signage/components/TvApp";

/**
 * A lobby TV. Which screen it is comes from `?screen=HPFM:1`; everything about
 * what it shows comes from that screen's config in Neon.
 *
 * Thin shell by house convention — all behaviour lives in ~/features/signage.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function TvPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Handed to the client so the FIRST PAINT already knows whose wall this is.
  // The client resolves identity in an effect (it also reads localStorage, for a
  // player opened without a query string), but that runs after hydration — so
  // without this the server-rendered markup is branded with the default venue,
  // and a FastTrax pit board boots showing the HeadPinz logo (owner 2026-08-14).
  const raw = (await searchParams).screen;
  const initialScreenId = typeof raw === "string" ? raw : null;
  return <TvApp initialScreenId={initialScreenId} />;
}
