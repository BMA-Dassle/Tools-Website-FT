import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import WebSalesBoard from "~/components/features/web-sales/WebSalesBoard";

/**
 * Admin: every non-reservation sale made on the website.
 *
 * Deployed ALONGSIDE `/admin/{token}/deals` rather than replacing it — the v2
 * cutover pattern this repo requires: ship v2 next to v1, let ops sign off,
 * redirect v1 → v2, delete v1 in a third PR. `daily-events-v2` is the in-repo
 * precedent. The cutover is by URL, not by flag.
 *
 * Token-gated by middleware (ADMIN_CAMERA_TOKEN, matched on path segment 2, so
 * this route is covered the moment the file exists). The page revalidates the
 * param as defence in depth and hands the token to the client for its API calls.
 *
 * `searchParams` is read HERE and passed down so the board's first paint already
 * matches the URL. Reading it in the client with `useSearchParams` would force a
 * Suspense boundary and a flash of the unfiltered default.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/web-sales
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ params, searchParams }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  const sp = await searchParams;
  const initial = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    // A repeated param arrives as an array; the board's parser reads the comma
    // form, so join rather than dropping every value but the last.
    initial.set(key, Array.isArray(value) ? value.join(",") : value);
  }

  return (
    <div className={adminPoppins.variable}>
      <WebSalesBoard token={token} initialSearch={initial.toString()} />
    </div>
  );
}
