import type { Metadata } from "next";
import ReloadFlow from "~/components/features/game-cards/ReloadFlow";

/**
 * Public game-card reload page. Fast path: the card's printed QR
 * (`swflpassport.com/?id=<n>`) redirects here as `/reload?id=<n>`; `id`
 * pre-fills + auto-verifies the card. Works without `id` too (typed entry).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Reload Your Game Card",
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: Props) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.id) ? sp.id[0] : sp.id;
  const initialCardId = raw && /^\d{1,19}$/.test(raw) ? raw : undefined;

  return <ReloadFlow initialCardId={initialCardId} />;
}
