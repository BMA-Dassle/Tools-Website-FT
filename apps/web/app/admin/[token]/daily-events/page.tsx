import { notFound, redirect } from "next/navigation";

/**
 * Daily Events v1 -> v2 redirect (owner 2026-07-13: "ditch daily events v1
 * from code entirely" - cutover complete, the v1 board is deleted).
 * Forwards every query param (?date, ?location, ?event, ?tab, ?view,
 * ?cancelled) so old bookmarks and deep links land unchanged.
 */

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && v) qs.set(k, v);
  }
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  redirect(`/admin/${token}/daily-events-v2${suffix}`);
}
