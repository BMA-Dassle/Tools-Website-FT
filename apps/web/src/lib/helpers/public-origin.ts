/**
 * publicOrigin — the origin to bake into URLs that must work OUTSIDE an
 * authenticated staff browser: QR payloads a guest scans across the desk,
 * TV-player URLs copied into device configs.
 *
 * Staff reach the admin tools from two places: the brand domains (token
 * URLs) and the admin proxy project (apps/admin — SSO-walled, serves the
 * main site's client bundle at clean URLs). On a brand domain the serving
 * origin IS the public origin, so it passes through unchanged — identical
 * behavior to before this helper existed. Anywhere else (the admin domain,
 * a *.vercel.app URL) a URL built from window.location.origin would point a
 * guest's phone or a wall TV at an auth wall, so fall back to the canonical
 * public site. localhost keeps itself so dev QRs stay scannable against the
 * dev server.
 * (Audit finding 2026-08-16 — see tasks/lessons.md § Serving origin.)
 *
 * ADMIN SUBDOMAINS ARE NEVER KEPT. The staff shell moved to
 * `admin.fasttraxent.com` (SSO, 2026-08-28), which IS under a brand domain —
 * the keep-list alone would have treated it as a guest host and baked an
 * auth-walled origin into every VIP voucher QR and TV player URL, the exact
 * failure lessons.md rule #5 forbade a brand subdomain to avoid. Excluding
 * the `admin.` first label is what makes that domain safe: any host whose
 * first label is exactly "admin" falls back to the public site.
 */
const PUBLIC_SITE_FALLBACK = "https://headpinz.com";

const KEEP_DOMAINS = ["fasttraxent.com", "headpinz.com"];

/** `admin.fasttraxent.com` / `admin.headpinz.com` — the SSO staff shell.
 *  Only the FIRST label counts: `admin-preview.headpinz.com` is not the
 *  shell, and `fasttraxent.com/admin` is a path, not a host. */
const isAdminHost = (host: string): boolean => host.split(".")[0] === "admin";

export const publicOrigin = (origin: string): string => {
  if (!origin) return origin; // SSR placeholder — client re-renders with a real one
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return origin;
  }
  if (isAdminHost(host)) return PUBLIC_SITE_FALLBACK;
  const keep =
    host === "localhost" ||
    host === "127.0.0.1" ||
    KEEP_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  return keep ? origin : PUBLIC_SITE_FALLBACK;
};
