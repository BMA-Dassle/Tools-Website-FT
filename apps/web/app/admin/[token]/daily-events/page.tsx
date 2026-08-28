import { notFound, redirect } from "next/navigation";
import { adminToolUrl } from "~/lib/helpers/admin-url";

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
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && v) query[k] = v;
  }
  // Land on the SSO shell's clean URL, not `/admin/{token}/daily-events-v2`.
  // A redirect() writes its target into a browser-visible Location header, so
  // the old form handed the permanent admin token to anyone who followed a
  // bookmark — including on the shell domain, where the browser had never
  // seen it. (apps/admin/src/routes.ts maps the bare /daily-events clean→clean
  // for the same reason; this covers the deep links that ride the shim.)
  redirect(adminToolUrl("daily-events-v2", query));
}
