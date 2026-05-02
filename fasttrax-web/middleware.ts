import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Hostname-based routing for dual-branded site:
 * - headpinz.com → rewrites to /hp/...
 * - fasttraxent.com → passes through
 * - localhost:3000/hp/... → HeadPinz pages for dev
 */
export function middleware(request: NextRequest) {
  const hostname = request.headers.get("host") || "";
  const isHeadPinz = hostname.includes("headpinz.com");
  const pathname = request.nextUrl.pathname;

  // Apple Pay domain verification — rewrite to API route that serves per-domain file
  if (pathname === "/.well-known/apple-developer-merchantid-domain-association") {
    const url = request.nextUrl.clone();
    url.pathname = "/api/apple-pay-verify";
    return NextResponse.rewrite(url);
  }

  // ── Unified admin gate ───────────────────────────────────────────────────
  // Single ADMIN_CAMERA_TOKEN covers ALL front-desk admin tools:
  //   /admin/{token}/camera-assign
  //   /admin/{token}/videos
  //   /admin/{token}/e-tickets
  //   /api/admin/*    (camera-assign, videos, e-tickets, sms-quota)
  //
  // Token-only auth — no IP allowlist. Staff hit these tools from
  // various devices (front-desk PCs, phones, external networks) and
  // the IP gate was creating more support load than security value.
  // The 32-byte token in the URL is the auth.
  //
  // Fail closed → 404 so the URL is indistinguishable from a typo.
  if (pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/")) {
    const expected = process.env.ADMIN_CAMERA_TOKEN || "";

    // ── Public OpenAPI spec ───────────────────────────────────────────
    // The spec itself contains no customer data — just request/response
    // schemas. Exposing it lets Swagger UI / external SDK generators /
    // the HeadPinz portal devs discover the API surface without needing
    // a key first. Calls to documented endpoints still require a key.
    if (pathname === "/api/admin/sales/openapi.json") {
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set("x-admin-via", "public-spec");
      return NextResponse.next({ request: { headers: requestHeaders } });
    }

    // ── External API-key auth for read-only sales endpoints ──────────────
    // The HeadPinz portal (and any future external consumer) authenticates
    // with `x-api-key` instead of the operator admin token. Only the
    // `/api/admin/sales/*` and `/api/admin/sales/openapi.json` routes are
    // exposed this way — the operator-mutating endpoints (camera-assign
    // block, video resend, e-ticket resend, sms-quota drain) keep the
    // strict admin-token gate. Multiple keys are supported (comma-
    // separated env var) so we can rotate without breaking integrations.
    if (pathname.startsWith("/api/admin/sales/")) {
      const provided = request.headers.get("x-api-key") || request.nextUrl.searchParams.get("apiKey");
      const validKeys = (process.env.SALES_API_KEYS || "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (provided && validKeys.length > 0 && validKeys.includes(provided)) {
        // Forward into the route handler with the admin-route flag so
        // the layout still strips public nav. No token check needed.
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set("x-admin-route", "1");
        requestHeaders.set("x-admin-via", "api-key");
        return NextResponse.next({ request: { headers: requestHeaders } });
      }
      // No api-key OR wrong api-key → fall through to the standard
      // admin-token check below. Operator UI keeps working unchanged.
    }

    // Token extraction: for /admin/{token}/..., token is the 2nd
    // path segment. For /api/admin/..., we accept header
    // `x-admin-token` OR query `?token=...`.
    let token = "";
    if (pathname.startsWith("/admin/")) {
      token = pathname.split("/")[2] || "";
    } else {
      token = request.headers.get("x-admin-token") || request.nextUrl.searchParams.get("token") || "";
    }

    // Legacy-token redirect — staff bookmarked the e-ticket admin
    // under the old ADMIN_ETICKETS_TOKEN before we collapsed gates.
    // If the URL token matches the legacy env var, 308 to the same
    // path with the canonical ADMIN_CAMERA_TOKEN. 308 preserves
    // method (so any in-flight POST keeps working) and tells the
    // browser to update bookmarks. Skip when ADMIN_ETICKETS_TOKEN
    // env is unset (rotation already cleaned up).
    const legacyToken = process.env.ADMIN_ETICKETS_TOKEN || "";
    if (
      legacyToken &&
      expected &&
      pathname.startsWith("/admin/") &&
      token === legacyToken &&
      legacyToken !== expected
    ) {
      const url = request.nextUrl.clone();
      url.pathname = pathname.replace(`/admin/${legacyToken}`, `/admin/${expected}`);
      return NextResponse.redirect(url, 308);
    }

    const tokenOk = !!expected && token.length === expected.length && token === expected;

    if (!tokenOk) {
      if (pathname.startsWith("/api/")) {
        return new NextResponse(
          JSON.stringify({ error: "Not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new NextResponse("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    // Flag admin routes so the root layout can strip the nav/footer/chat
    // chrome — staff-only tool, no public branding.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-admin-route", "1");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Dev: ?brand=headpinz sets a cookie to simulate headpinz.com on localhost
  const brandParam = request.nextUrl.searchParams.get("brand");
  if (brandParam === "headpinz") {
    const url = request.nextUrl.clone();
    url.searchParams.delete("brand");
    url.pathname = `/hp${pathname === "/" ? "" : pathname}`;
    const response = NextResponse.redirect(url);
    response.cookies.set("dev-brand", "headpinz", { path: "/", maxAge: 60 * 60 * 24 });
    return response;
  }
  if (brandParam === "fasttrax") {
    const url = request.nextUrl.clone();
    url.searchParams.delete("brand");
    url.pathname = "/";
    const response = NextResponse.redirect(url);
    response.cookies.delete("dev-brand");
    return response;
  }

  // HeadPinz legacy WordPress URL redirects (301 permanent)
  if (isHeadPinz) {
    const legacyRedirects: Record<string, string> = {
      // Location pages
      "/headpinz-fort-myers": "/fort-myers",
      "/headpinz-fort-myers/": "/fort-myers",
      "/headpinz-naples": "/naples",
      "/headpinz-naples/": "/naples",
      // Attractions
      "/fort-myers-attractions": "/fort-myers/attractions",
      "/naples-attractions": "/naples/attractions",
      "/headpinz-fort-myers/attractions": "/fort-myers/attractions",
      "/headpinz-fort-myers/attractions/": "/fort-myers/attractions",
      "/headpinz-naples/attractions": "/naples/attractions",
      "/headpinz-naples/attractions/": "/naples/attractions",
      // Group events
      "/fort-myers-group-events": "/fort-myers/group-events",
      "/naples-group-events": "/naples/group-events",
      "/headpinz-fort-myers/group-events": "/fort-myers/group-events",
      "/headpinz-fort-myers/group-events/": "/fort-myers/group-events",
      "/headpinz-naples/group-events": "/naples/group-events",
      "/headpinz-naples/group-events/": "/naples/group-events",
      // Birthdays
      "/fort-myers-birthdays": "/fort-myers/birthdays",
      "/naples-birthdays": "/naples/birthdays",
      "/headpinz-fort-myers/birthdays": "/fort-myers/birthdays",
      "/headpinz-fort-myers/birthdays/": "/fort-myers/birthdays",
      "/headpinz-naples/birthdays": "/naples/birthdays",
      "/headpinz-naples/birthdays/": "/naples/birthdays",
      "/headpinz-fort-myers/kids-birthday-parties": "/fort-myers/birthdays",
      "/headpinz-fort-myers/kids-birthday-parties/": "/fort-myers/birthdays",
      "/headpinz-naples/kids-birthday-parties": "/naples/birthdays",
      "/headpinz-naples/kids-birthday-parties/": "/naples/birthdays",
      // Menu
      "/headpinz-fort-myers/menu": "/menu",
      "/headpinz-fort-myers/menu/": "/menu",
      "/headpinz-naples/menu": "/menu",
      "/headpinz-naples/menu/": "/menu",
      "/qr-menu": "/menu",
      "/qr-menu/": "/menu",
      // Reservations / booking
      "/headpinz-fort-myers/reservations": "/book",
      "/headpinz-fort-myers/reservations/": "/book",
      "/headpinz-naples/reservations": "/book",
      "/headpinz-naples/reservations/": "/book",
      "/headpinz-fort-myers/booking": "/book/bowling",
      "/headpinz-fort-myers/booking/": "/book/bowling",
      "/bowling-reservation": "/book/bowling",
      "/bowling-reservation/": "/book/bowling",
      // Specials
      "/headpinz-fort-myers/specials": "/fort-myers",
      "/headpinz-fort-myers/specials/": "/fort-myers",
      "/headpinz-naples/specials": "/naples",
      "/headpinz-naples/specials/": "/naples",
      // Attractions — gel blaster
      "/headpinz-fort-myers/gel-blaster-nexus": "/book/gel-blaster",
      "/headpinz-fort-myers/gel-blaster-nexus/": "/book/gel-blaster",
      "/headpinz-fort-myers/nexus-gel-blaster": "/book/gel-blaster",
      "/headpinz-fort-myers/nexus-gel-blaster/": "/book/gel-blaster",
      "/headpinz-naples/gel-blaster-nexus": "/book/gel-blaster",
      "/headpinz-naples/gel-blaster-nexus/": "/book/gel-blaster",
      "/headpinz-naples/nexus-gel-blaster": "/book/gel-blaster",
      "/headpinz-naples/nexus-gel-blaster/": "/book/gel-blaster",
      // Attractions — laser tag
      "/headpinz-fort-myers/laser-tag": "/book/laser-tag",
      "/headpinz-fort-myers/laser-tag/": "/book/laser-tag",
      "/headpinz-fort-myers/nexus-laser-tag": "/book/laser-tag",
      "/headpinz-fort-myers/nexus-laser-tag/": "/book/laser-tag",
      "/headpinz-naples/laser-tag": "/book/laser-tag",
      "/headpinz-naples/laser-tag/": "/book/laser-tag",
      // Careers / team — dedicated /careers page
      "/headpinz-fort-myers/join-our-team": "/careers",
      "/headpinz-fort-myers/join-our-team/": "/careers",
      "/headpinz-naples/join-our-team": "/careers",
      "/headpinz-naples/join-our-team/": "/careers",
      "/join-our-team": "/careers",
      "/join-our-team/": "/careers",
      "/careers/": "/careers",
      // Gift cards — no dedicated page yet, send to home
      "/headpinz-fort-myers/gift-card": "/",
      "/headpinz-fort-myers/gift-card/": "/",
      "/headpinz-naples/gift-card": "/",
      "/headpinz-naples/gift-card/": "/",
      "/gift-cards": "/",
      "/gift-cards/": "/",
      // Leagues
      "/youth-league": "/fort-myers",
      "/youth-league/": "/fort-myers",
      "/headpinz-fort-myers/fall-league-sign-up": "/fort-myers",
      "/headpinz-fort-myers/fall-league-sign-up/": "/fort-myers",
      "/headpinz-naples/fall-league-sign-up": "/naples",
      "/headpinz-naples/fall-league-sign-up/": "/naples",
      // Waiver — HeadPinz has no waiver page, send to home
      "/headpinz-fort-myers/waiver-2": "/",
      "/headpinz-fort-myers/waiver-2/": "/",
      "/headpinz-naples/waiver-2": "/",
      "/headpinz-naples/waiver-2/": "/",
      "/waiver-2": "/",
      "/waiver-2/": "/",
      "/waiver": "/",
      "/waiver/": "/",
      // Blog articles — redirect to home
      "/enjoying-family-fun-with-kids-bowl-free-at-headpinz": "/kids-bowl-free",
      "/enjoying-family-fun-with-kids-bowl-free-at-headpinz/": "/kids-bowl-free",
      "/brief-history-of-bowling": "/",
      "/brief-history-of-bowling/": "/",
      // Rewards / KBF / trailing slashes
      "/rewards/": "/rewards",
      "/kids-bowl-free/": "/kids-bowl-free",
    };
    const redirect = legacyRedirects[pathname.toLowerCase()];
    if (redirect) {
      return NextResponse.redirect(`https://headpinz.com${redirect}`, 301);
    }

    // Old WordPress sitemap index — redirect to the real Next.js sitemap.
    // This clears the Search Console "sitemap_index.xml has errors" alert
    // caused by 66K stale WordPress URLs Google is still trying to crawl.
    if (pathname === "/sitemap_index.xml") {
      return NextResponse.redirect("https://headpinz.com/sitemap.xml", 301);
    }

    // Catch-all for any remaining old WordPress /headpinz-fort-myers/* and
    // /headpinz-naples/* URLs not in the explicit table above. Saves crawl
    // budget — any unknown WP sub-path gets a 301 to the new location hub
    // rather than a 404.
    const lp = pathname.toLowerCase();
    if (lp.startsWith("/headpinz-fort-myers/")) {
      return NextResponse.redirect("https://headpinz.com/fort-myers", 301);
    }
    if (lp.startsWith("/headpinz-naples/")) {
      return NextResponse.redirect("https://headpinz.com/naples", 301);
    }

    // /review → Google Business Profile review (Fort Myers default, /review/naples for Naples)
    if (pathname.toLowerCase() === "/review") {
      return NextResponse.redirect(
        "https://search.google.com/local/writereview?placeid=ChIJw7rUvBSl3YgRZnV1tR0aK9s",
        302
      );
    }
    if (pathname.toLowerCase() === "/review/naples") {
      return NextResponse.redirect(
        "https://search.google.com/local/writereview?placeid=ChIJq6qqNOSi3YgREP2LHBrr1g4",
        302
      );
    }
  }

  // HeadPinz short URLs — case-insensitive redirect to canonical lowercase
  if (isHeadPinz && pathname.toLowerCase() === "/fwf" && pathname !== "/fwf") {
    return NextResponse.redirect(`https://headpinz.com/fwf`, 301);
  }

  // HeadPinz domain: if user hits /hp/* directly (except /hp/book/* which is a real route),
  // strip the prefix — the middleware rewrite handles /hp internally
  if (isHeadPinz && pathname.startsWith("/hp/") && !pathname.startsWith("/hp/book")) {
    const cleanPath = pathname.replace(/^\/hp/, "") || "/";
    return NextResponse.redirect(`https://headpinz.com${cleanPath}`, 301);
  }

  // Root-level metadata / static paths that must bypass the /hp rewrite.
  // Without this, Next.js serves /hp/robots.txt → 404 for crawlers hitting
  // headpinz.com/robots.txt. Same story for sitemap, favicon, manifest,
  // site verification files (Google / Bing / Pinterest / Facebook).
  const isRootMetadataPath =
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.json" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/browserconfig.xml" ||
    pathname === "/sw.js" ||
    pathname === "/serviceworker.js" ||
    pathname.startsWith("/.well-known/") ||
    /^\/[a-zA-Z0-9_-]+\.txt$/.test(pathname) || // google*.txt, pinterest-*.txt etc
    /^\/[a-zA-Z0-9_-]+\.html$/.test(pathname);  // bing*.html, facebook-domain-verification.html, etc

  // HeadPinz domain: rewrite to /hp prefix (unless already there, shared
  // route, or root-level metadata that must be served as-is).
  //
  // Shared routes that exist at the top level and should serve on BOTH
  // domains without /hp rewriting — e.g. /accessibility (host-aware
  // metadata renders the right brand per request).
  const isSharedTopLevelRoute =
    pathname === "/accessibility" || pathname.startsWith("/accessibility/") ||
    pathname === "/cancellation-policy" || pathname.startsWith("/cancellation-policy/");
  if (
    isHeadPinz &&
    !pathname.startsWith("/hp") &&
    !pathname.startsWith("/book") &&
    !pathname.startsWith("/api") &&
    !pathname.startsWith("/documents") &&
    !isRootMetadataPath &&
    !isSharedTopLevelRoute
  ) {
    const url = request.nextUrl.clone();
    url.pathname = `/hp${pathname}`;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // HeadPinz domain on shared routes (/book, /api):
  //   - /book (exactly) → rewrite to /hp/book (HP-branded booking hub)
  //   - /book/* sub-paths → pass through to the shared app/book/* flows
  //     (checkout, confirmation, race, etc.) with brand header set
  //   - /api/* → pass through, brand header set
  if (isHeadPinz && (pathname === "/book" || pathname === "/book/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/hp/book";
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }
  if (isHeadPinz && (pathname.startsWith("/book") || pathname.startsWith("/api"))) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Block /hp/ on fasttraxent.com — redirect to headpinz.com (allow on localhost for dev)
  const isLocalhost = hostname.includes("localhost") || hostname.includes("127.0.0.1");
  if (pathname.startsWith("/hp") && !isHeadPinz && !isLocalhost) {
    const hpPath = pathname.replace(/^\/hp/, "") || "/";
    return NextResponse.redirect(`https://headpinz.com${hpPath}`);
  }

  // Set brand header for /hp/ routes (dev access on localhost)
  if (pathname.startsWith("/hp")) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Suppress the mobile "Book Now" bar on focused customer-action
  // screens — e-tickets (/t/, /g/) and the booking confirmation /
  // express-checkin screen. The bar overlaps the action surfaces
  // (full-screen ticket button, QR modals) and the customer is
  // already mid-flow, so an offer to start a NEW booking is just
  // visual noise. Header is read by app/layout.tsx.
  const suppressMobileBar =
    pathname.startsWith("/t/") ||
    pathname.startsWith("/g/") ||
    pathname.startsWith("/book/confirmation");
  if (suppressMobileBar) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-no-mobile-bar", "1");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|images/|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js)$).*)"],
};
