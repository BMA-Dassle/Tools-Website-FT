import { redirect } from "next/navigation";
import { adminToolUrl } from "~/lib/helpers/admin-url";
import type { AdminToolQuery } from "@/app/admin/_tools/query";

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
 * admin secret to anyone who follows a bookmark. `adminToolUrl()` builds the
 * clean staff URL instead — which, now that `daily-events-v2` is itself an SSO
 * tool, resolves to a page with no credential in it at any point.
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
  redirect(adminToolUrl("daily-events-v2", params));
}
