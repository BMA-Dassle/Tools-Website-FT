import AdminToolPage from "@/app/admin/_tools/camera-assign-track/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/camera-assign/{blue|red|mega}` — no credential in the URL. A
 * Microsoft SSO session holding the `access` role is what opens it.
 *
 * Next resolves the static `camera-assign` segment ahead of the sibling
 * `[token]` one, so `/admin/camera-assign/blue` lands here and not on
 * `/admin/[token]/blue` (which does not exist anyway).
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page({ params }: { params: Promise<{ track: string }> }) {
  await requireSsoAdmin();
  const { track } = await params;
  return <AdminToolPage track={track} />;
}
