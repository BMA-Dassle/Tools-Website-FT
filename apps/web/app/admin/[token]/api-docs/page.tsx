import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/api-docs/AdminToolPage";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/api-docs`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/api-docs` (same component, no credential in the URL) per the v2
 * cutover pattern; the middleware now 307s this URL to the clean one, so what
 * actually reaches this page is a request with the redirect lane disabled or a
 * client that does not follow redirects.
 *
 * THE TOKEN CHECK BELOW IS NEW, and it is a fix rather than a port. Until this
 * split, `api-docs` was a `"use client"` page with no server-side check at all
 * — the middleware was its only gate, which is exactly the case
 * `lib/admin-api-token.ts` names when it says a browser-held credential is not
 * a page credential. Every sibling board re-checks the token; this one now does
 * too. It can only ever fire on a path the middleware already admitted.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <AdminToolPage />;
}
