import AdminToolPage, { type PageQuery } from "@/app/admin/_tools/crm/AdminToolPage";

/**
 * `/admin/crm` — the Sales CRM's My Day. No credential in the URL: a Microsoft
 * SSO session carrying `sales` or `sales-director` is what opens it
 * (`requireCrmUser()` inside `AdminToolPage`; `access` alone 404s).
 *
 * Every other screen is `/admin/crm/<screen>/…` — see `[...view]/page.tsx`.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { searchParams: Promise<PageQuery> };

export default async function Page({ searchParams }: Props) {
  return <AdminToolPage view={[]} query={await searchParams} />;
}
