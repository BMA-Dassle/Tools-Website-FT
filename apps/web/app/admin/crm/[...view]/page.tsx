import AdminToolPage, { type PageQuery } from "@/app/admin/_tools/crm/AdminToolPage";

/**
 * `/admin/crm/<screen>[/<id>…]` — every CRM screen but My Day (brief §3.1).
 * The segments are handed to the client router untouched; an unknown first
 * segment is an in-app "not found", never Next's 404, so a stale bookmark
 * still lands inside the tool.
 *
 * The drift test (`admin-tools.test.ts`) walks v1 → v2 only, so this extra v2
 * route needs no `[token]` twin — and must never get one.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ view: string[] }>; searchParams: Promise<PageQuery> };

export default async function Page({ params, searchParams }: Props) {
  const { view } = await params;
  return <AdminToolPage view={view} query={await searchParams} />;
}
