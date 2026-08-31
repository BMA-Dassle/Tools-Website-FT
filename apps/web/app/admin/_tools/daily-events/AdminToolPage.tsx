import { redirect } from "next/navigation";
import type { AdminToolQuery } from "@/app/admin/_tools/query";

/**
 * The v2 board's path on THIS deployment, query attached. SAME-ORIGIN on
 * purpose — see the note on the component below.
 */
export function dailyEventsV2Path(params: Record<string, string>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  return qs.size > 0 ? `/admin/daily-events-v2?${qs.toString()}` : "/admin/daily-events-v2";
}

/**
 * Daily Events v1 → v2 redirect (owner 2026-07-13: "ditch daily events v1 from
 * code entirely" — cutover complete, the v1 board is deleted).
 *
 * THE IMPLEMENTATION, ONCE, even though it renders nothing. Two routes call it
 * — `/admin/{token}/daily-events` and `/admin/daily-events` — and a redirect
 * shim is exactly the kind of code that drifts when it is copied: one copy
 * forwards `?tab=` and the other silently drops it, and nobody notices until a
 * bookmark opens the wrong day.
 *
 * Every query param rides along (`?date`, `?location`, `?event`, `?tab`,
 * `?view`, `?cancelled`) so old bookmarks and deep links land unchanged.
 *
 * THE TARGET MUST NOT CARRY THE TOKEN. `redirect()` writes its argument into a
 * browser-visible `Location` header, so a tokened target hands the permanent
 * admin secret to anyone who follows a bookmark. The clean path has no
 * credential in it at any point.
 *
 * AND IT MUST BE SAME-ORIGIN, not `adminToolUrl()`. That helper always returns
 * an absolute `https://admin.fasttraxent.com/…`, and Auth.js writes HOST-ONLY
 * session cookies (`auth.ts` sets `trustHost` with no cookie `domain`), so a
 * session on `fasttraxent.com` is never sent to the admin host. A staff
 * bookmark of `fasttraxent.com/admin/{token}/daily-events` would then pay TWO
 * Microsoft round-trips: the redirect lane bounces it to `/admin/daily-events`,
 * that signs in on the brand host, and this shim then throws that session away
 * by hopping hosts to sign in again. `/admin/daily-events-v2` resolves on BOTH
 * hosts — on the admin host it is a `pass` in `resolveAdminHostPath` and falls
 * to the same SSO branch — so the person signs in once, wherever they started.
 *
 * `adminToolUrl()` stays the right answer for links LEAVING the app (alert
 * emails, Teams cards), which is what its docblock is about: those have no
 * origin of their own to be relative to.
 */
export default async function AdminToolPage({
  query,
}: {
  query: AdminToolQuery;
  // `Promise<never>`, not `Promise<void>`: `redirect()` returns `never`, and a
  // component that returns `void` is not a valid JSX element type. Saying so
  // explicitly keeps this usable in a `return <AdminToolPage … />` the way
  // every other tool module is.
}): Promise<never> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === "string" && v) params[k] = v;
  }
  redirect(dailyEventsV2Path(params));
}
