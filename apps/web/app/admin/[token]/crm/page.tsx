import { notFound, redirect } from "next/navigation";

/**
 * v1 shim: `/admin/{ADMIN_CAMERA_TOKEN}/crm` → 307 `/admin/crm`.
 *
 * Exists because the drift test (`admin-tools.test.ts`) requires every SSO
 * tool to have a `[token]` directory, and because the middleware's redirect
 * lane already 307s this URL to the clean one — this file is what answers if
 * that lane is ever skipped.
 *
 * THE `ADMIN_TOKEN_REDIRECT_DISABLED` KILL SWITCH DOES NOT COVER THE CRM.
 * With that switch on, the other eighteen tools render their board from the
 * token URL (`middleware.ts:544-553` stops the lane and each `[token]` page
 * renders its `_tools` module). The CRM cannot: every action it records
 * carries `actor_email`, and the rep/director split is read from the SSO
 * session — a token URL knows neither. So this shim ALWAYS redirects, switch
 * or no switch. It is a 307, never a 308 (lesson 5439: a cached 308 outlives
 * the decision that made it), and its target is a same-origin relative path
 * with no token in it (host-only session cookie; `shim.test.ts` reasoning).
 *
 * NO OTHER `page.tsx` MAY BE ADDED UNDER `app/admin/[token]/crm/` — the
 * mirror test would demand a v2 twin for each.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  redirect("/admin/crm");
}
