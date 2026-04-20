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
      // Careers / team — no dedicated page yet, send to home
      "/headpinz-fort-myers/join-our-team": "/",
      "/headpinz-fort-myers/join-our-team/": "/",
      "/headpinz-naples/join-our-team": "/",
      "/headpinz-naples/join-our-team/": "/",
      "/careers": "/",
      "/careers/": "/",
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
    pathname === "/accessibility" || pathname.startsWith("/accessibility/");
  if (
    isHeadPinz &&
    !pathname.startsWith("/hp") &&
    !pathname.startsWith("/book") &&
    !pathname.startsWith("/api") &&
    !isRootMetadataPath &&
    !isSharedTopLevelRoute
  ) {
    const url = request.nextUrl.clone();
    url.pathname = `/hp${pathname}`;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // HeadPinz domain on shared routes (/book, /api) — set brand header without rewriting
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

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|images/|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js)$).*)"],
};
