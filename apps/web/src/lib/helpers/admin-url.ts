/**
 * adminToolUrl — the one way to link a human at an admin tool.
 *
 * WHY. Every staff-facing deep link into the admin site used to be a tokenised
 * URL: `https://headpinz.com/admin/{ADMIN_CAMERA_TOKEN}/deals`. That put a
 * permanent bearer credential into staff email, into Teams cards, into SMS —
 * places that get forwarded, screenshotted, and archived — and it made
 * rotating the token a coordinated re-send of every alert ever sent.
 *
 * The same tools are served at CLEAN urls behind Microsoft SSO:
 * `https://admin.fasttraxent.com/deals`. The link carries no credential, the
 * person's own sign-in is the credential, and rotating the token breaks nothing
 * because no link contains it.
 *
 * THE DEFAULT ORIGIN IS UNCHANGED AND THE ALIAS MOVED UNDER IT. That hostname
 * used to be a separate Vercel project that proxied everything here; it now
 * points at THIS deployment, where `middleware.ts` gates `/<tool>` on a
 * Microsoft session and rewrites it onto the route that renders it. EVERY link
 * this helper has ever produced keeps resolving across the shell's retirement
 * (PR B) without being re-issued, whichever list the tool is on:
 *
 *   - a migrated tool (`SSO_ADMIN_TOOLS`) rewrites to `/admin/<slug>` — no
 *     credential in the path at all;
 *   - every other tool rewrites to `/admin/{ADMIN_CAMERA_TOKEN}/<slug>`,
 *     server-side and behind the same gate, which is bit-for-bit what the shell
 *     forwards today.
 *
 * `https://fasttraxent.com/admin/reservations` and
 * `https://headpinz.com/admin/reservations` are EQUIVALENT to the admin-host
 * form for a migrated tool — the same route, the same gate, the same session.
 * The admin host is the canonical staff form because it is the one that 404s
 * the guest site; the brand-domain form is the fallback if DNS for the alias is
 * ever in doubt.
 *
 * This helper is deliberately dumb — an origin, a slug, and a query. No env
 * secret, no token, nothing to leak, nothing to get null-checked at the call
 * site: unlike `adminBoardUrl()` it can never return null, so an alert can
 * always render its button.
 *
 * SAFE IN A CLIENT BUNDLE. Admin boards link to each other, and after the
 * token sweep a client component's `token` prop is a short-lived API
 * credential that would 404 in a page path — so those in-app links come
 * through here too. There is nothing here to leak: the only value is a public
 * hostname. `ADMIN_PUBLIC_URL` is server-only by design (not a NEXT_PUBLIC_
 * var), so in the browser it reads as undefined and the default applies —
 * which is the correct answer in every deployed environment.
 */

const DEFAULT_ADMIN_ORIGIN = "https://admin.fasttraxent.com";

export function adminPublicOrigin(): string {
  return (process.env.ADMIN_PUBLIC_URL || DEFAULT_ADMIN_ORIGIN).replace(/\/+$/, "");
}

/**
 * `adminToolUrl("deals")` → `https://admin.fasttraxent.com/deals`
 * `adminToolUrl("reservations", { view: "vip" })` → `…/reservations?view=vip`
 *
 * The slug is the clean tool path — a member of `ADMIN_TOOL_SLUGS`
 * (`~/lib/constants/admin-tools`, drift-pinned to the real route directories),
 * optionally with deeper
 * segments (`"camera-assign/blue"`). Leading/trailing slashes are forgiven so
 * callers can pass `"/deals"`. Query values that are null/undefined/empty are
 * dropped, so a caller can hand through optional filters without building the
 * string itself.
 */
export function adminToolUrl(
  slug: string,
  query?: Record<string, string | number | null | undefined>,
): string {
  const path = slug.replace(/^\/+/, "").replace(/\/+$/, "");
  const url = `${adminPublicOrigin()}${path ? `/${path}` : ""}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === "") continue;
    qs.set(k, String(v));
  }
  return qs.size > 0 ? `${url}?${qs.toString()}` : url;
}
