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
      "/headpinz-fort-myers": "/fort-myers",
      "/headpinz-naples": "/naples",
      "/headpinz-fort-myers/": "/fort-myers",
      "/headpinz-naples/": "/naples",
      "/fort-myers-attractions": "/fort-myers/attractions",
      "/naples-attractions": "/naples/attractions",
      "/fort-myers-group-events": "/fort-myers/group-events",
      "/naples-group-events": "/naples/group-events",
      "/fort-myers-birthdays": "/fort-myers/birthdays",
      "/naples-birthdays": "/naples/birthdays",
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

  // HeadPinz domain: rewrite to /hp prefix (unless already there or it's a shared route)
  if (isHeadPinz && !pathname.startsWith("/hp") && !pathname.startsWith("/book") && !pathname.startsWith("/api")) {
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
