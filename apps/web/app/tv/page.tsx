import { TvApp } from "~/features/signage/components/TvApp";

/**
 * A lobby TV. Which screen it is comes from `?screen=HPFM:1`; everything about
 * what it shows comes from that screen's config in Neon.
 *
 * Thin shell by house convention — all behaviour lives in ~/features/signage.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function TvPage() {
  return <TvApp />;
}
