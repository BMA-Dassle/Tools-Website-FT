import AdminToolPage from "@/app/admin/_tools/videos/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/videos` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it.
 *
 * Next resolves the static `videos` segment ahead of the sibling `[token]`
 * dynamic segment, so this route and the v1 one coexist; `admin-tools.test.ts`
 * pins that both trees carry every migrated tool.
 *
 * NOT to be confused with `/admin/embed/videos`, which is the employee
 * portal's HMAC-signed iframe surface and is deliberately excluded from the SSO
 * branch — an iframe has no Microsoft session and must never be bounced to a
 * sign-in page.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is, and for the same
 * reason: this board mails video links to addresses typed into it, so it does
 * not get to rely on one gate.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
