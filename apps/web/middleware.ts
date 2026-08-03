import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Hostname-based routing for dual-branded site:
 * - headpinz.com → rewrites to /hp/...
 * - fasttraxent.com → passes through
 * - localhost:3000/hp/... → HeadPinz pages for dev
 */
export async function middleware(request: NextRequest) {
  const hostname = request.headers.get("host") || "";
  const pathname = request.nextUrl.pathname;

  // ── Local dev brand override ────────────────────────────────────────────
  // PRODUCTION SAFETY: dead code when NODE_ENV === "production". In dev,
  // visitors switch brands via ?brand=headpinz|fasttrax which sets a 7-day
  // cookie; subsequent requests are treated as if they came from that
  // brand's host. Without this, localhost has no way to reach the HeadPinz
  // surface cleanly — middleware reads the Host header, which is just
  // "localhost:3000" with no brand signal.
  const isDev = process.env.NODE_ENV !== "production";
  const devBrand = isDev ? request.cookies.get("dev-brand")?.value : undefined;
  const isHeadPinz = hostname.includes("headpinz.com") || devBrand === "headpinz";

  // ── swflpassport.com is a pure redirector — never hosts anything ──────────
  // Printed cards carry a QR to swflpassport.com/?id=<cardNumber>. The domain
  // exists only to forward scans: a valid card id goes to the reload flow with
  // the id preserved; anything else (bare visit, no/invalid id) goes to the
  // HeadPinz home. 308 keeps it permanent + method-safe.
  const host = hostname.split(":")[0].toLowerCase();
  if (host === "swflpassport.com" || host.endsWith(".swflpassport.com")) {
    // Find the card id from the query (ANY case: id / ID / Id) or, failing
    // that, a numeric path segment. Always land on the reload page — never the
    // brand home — and carry the id when we have one. 307 (temporary) so we're
    // not permanently cached in browsers while this is still being tuned.
    let id = "";
    for (const [k, v] of request.nextUrl.searchParams) {
      if (k.toLowerCase() === "id") {
        id = v.trim();
        break;
      }
    }
    if (!id) {
      const m = pathname.match(/(\d{4,19})/);
      if (m) id = m[1];
    }
    const target = new URL("https://headpinz.com/reload");
    if (/^\d{1,19}$/.test(id)) target.searchParams.set("id", id);
    return NextResponse.redirect(target, 307);
  }

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

    // ── Admin embed pages (HMAC-gated, iframe-locked) ─────────────────
    // Portal iframe loads /admin/embed/{tool}?ts=...&sig=...
    // No static admin token in the URL — portal signs a timestamp with
    // a shared secret and FastTrax validates it here. URL expires after
    // 15 min. Rotate ADMIN_EMBED_SECRET on both Vercel projects to
    // invalidate all outstanding URLs.
    //
    // Supported tools:
    //   /admin/embed/bowling         — reservation management
    //   /admin/embed/e-tickets       — e-ticket delivery log + resend
    //   /admin/embed/videos          — video match log + resend
    //   /admin/embed/daily-events    — group event day board + detail (v1)
    //   /admin/embed/daily-events-v2 — group event board v2 (portal skin)
    const EMBED_TOOLS = new Set([
      "bowling",
      "e-tickets",
      "videos",
      "daily-events",
      "daily-events-v2",
    ]);
    const embedMatch = pathname.match(/^\/admin\/embed\/([a-z0-9-]+)$/);
    if (embedMatch && EMBED_TOOLS.has(embedMatch[1])) {
      const embedSecret = process.env.ADMIN_EMBED_SECRET || "";
      if (!embedSecret) {
        return new NextResponse("embed: ADMIN_EMBED_SECRET not configured", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
      }
      const ts = request.nextUrl.searchParams.get("ts") || "";
      const sig = request.nextUrl.searchParams.get("sig") || "";
      if (!ts || !sig) {
        return new NextResponse("embed: missing ts or sig param", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
      }
      // Timestamp must be within 15 minutes
      const age = Math.abs(Date.now() - Number(ts));
      if (isNaN(age) || age > 15 * 60 * 1000) {
        return new NextResponse(
          `embed: signature expired (age ${Math.round(age / 1000)}s, max 900s)`,
          { status: 403, headers: { "content-type": "text/plain" } },
        );
      }
      // HMAC-SHA256 verify (Web Crypto — available in Edge runtime)
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(embedSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const expected_sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(ts)));
      const hex = Array.from(expected_sig)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (sig !== hex) {
        return new NextResponse("embed: invalid signature (wrong key)", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
      }
      // Valid — allow through with frame-ancestors lock + admin flag
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set("x-admin-route", "1");
      requestHeaders.set("x-admin-via", "embed-hmac");
      const resp = NextResponse.next({ request: { headers: requestHeaders } });
      resp.headers.set("Content-Security-Policy", "frame-ancestors https://portal.headpinz.com");
      return resp;
    }

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

    // ── External API-key auth for documented admin endpoints ─────────────
    // HeadPinz portal + the FastTrax employee portal authenticate with
    // `x-api-key` (SALES_API_KEYS env var — single key list, used for
    // every documented surface). Originally scoped to /api/admin/sales/*
    // only; expanded to cover /api/admin/videos/* and
    // /api/admin/e-tickets/* so the employee portal can drive the same
    // tools the operator UIs use, no admin token required.
    //
    // Camera-assign, deposit-failures, sms-quota, kbf, etc. are NOT in
    // the api-key allowlist — those keep the strict admin-token gate
    // because they're operator-only mutations.
    //
    // Multiple keys are supported (comma-separated env var) so we can
    // rotate without breaking integrations.
    const apiKeyEligible =
      pathname.startsWith("/api/admin/sales/") ||
      pathname.startsWith("/api/admin/videos/") ||
      pathname.startsWith("/api/admin/e-tickets/") ||
      pathname.startsWith("/api/admin/pov-codes/") ||
      // Guest-survey results (stats / list / question-stats) — the HeadPinz
      // portal pulls these via x-api-key. Read-only analytics endpoints;
      // racing results filter with ?origin=racing. Same key list
      // (SALES_API_KEYS), same backend + Neon DB for both brands — there is
      // no separate FastTrax survey API.
      pathname.startsWith("/api/admin/guest-survey/");
    if (apiKeyEligible) {
      const provided =
        request.headers.get("x-api-key") || request.nextUrl.searchParams.get("apiKey");
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
      token =
        request.headers.get("x-admin-token") || request.nextUrl.searchParams.get("token") || "";
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
        return new NextResponse(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new NextResponse("Not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }

    // ── IP allowlist for /admin/{token}/ page routes ─────────────────
    // Direct browser access to admin pages requires the visitor's IP to
    // be in ADMIN_ALLOWED_IPS (comma-separated). API routes (/api/admin/*)
    // are exempt — they're called by the admin page's own client-side JS,
    // which would come from the user's same IP anyway, but the token gate
    // is sufficient there. The embed path is also exempt (HMAC + frame-ancestors).
    //
    // When ADMIN_ALLOWED_IPS is unset or empty, the check is skipped
    // (backwards compatible — opt-in lockdown).
    // TEMPORARY: IP restriction bypassed for sharing — revert after review
    // if (pathname.startsWith("/admin/") && !pathname.startsWith("/api/")) {
    //   const allowedIps = (process.env.ADMIN_ALLOWED_IPS || "")
    //     .split(",")
    //     .map((ip) => ip.trim())
    //     .filter(Boolean);
    //   if (allowedIps.length > 0) {
    //     const clientIp =
    //       request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    //       request.headers.get("x-real-ip") ||
    //       "";
    //     if (!allowedIps.includes(clientIp)) {
    //       return new NextResponse("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    //     }
    //   }
    // }

    // Flag admin routes so the root layout can strip the nav/footer/chat
    // chrome — staff-only tool, no public branding.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-admin-route", "1");
    const resp = NextResponse.next({ request: { headers: requestHeaders } });
    // Allow portal to iframe admin pages when ?embedded=1 is set.
    // Without this, the default X-Frame-Options blocks cross-origin framing.
    if (request.nextUrl.searchParams.get("embedded") === "1") {
      resp.headers.set("Content-Security-Policy", "frame-ancestors https://portal.headpinz.com");
      // Override any default X-Frame-Options that would conflict
      resp.headers.delete("X-Frame-Options");
    }
    return resp;
  }

  // Dev only: ?brand=headpinz|fasttrax sets/clears the dev-brand cookie and
  // redirects to the same path without the query param. The cookie is read
  // at the top of this function to flip isHeadPinz, so the rest of the
  // middleware routes naturally as if the visitor arrived on that brand's
  // host. Gated by NODE_ENV — prod ignores ?brand= entirely.
  if (isDev) {
    const brandParam = request.nextUrl.searchParams.get("brand");
    if (brandParam === "headpinz" || brandParam === "fasttrax") {
      const url = request.nextUrl.clone();
      url.searchParams.delete("brand");
      const response = NextResponse.redirect(url);
      if (brandParam === "headpinz") {
        response.cookies.set("dev-brand", "headpinz", {
          path: "/",
          maxAge: 60 * 60 * 24 * 7,
          sameSite: "lax",
        });
      } else {
        response.cookies.set("dev-brand", "", { path: "/", maxAge: 0 });
      }
      return response;
    }
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
      // NOTE: "/waiver" is NOT redirected — it's the unified first-party waiver
      // flow (a shared top-level route below). Redirecting it would 404/​home it
      // on headpinz.com.
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
        302,
      );
    }
    if (pathname.toLowerCase() === "/review/naples") {
      return NextResponse.redirect(
        "https://search.google.com/local/writereview?placeid=ChIJq6qqNOSi3YgREP2LHBrr1g4",
        302,
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

  // ── Booking V1 → V2 cutover ────────────────────────────────────────────
  // v2 is the booking system: redirect every legacy booking entry into its v2
  // flow. ONE redirect here replaces editing ~90 scattered links — it also
  // catches email/QR/bookmark URLs and keeps working after v1 pages are deleted.
  // Runs before the /hp rewrite so it applies on BOTH brand domains (the
  // HeadPinz /hp/book/* direct links are folded in via the /hp-strip in
  // bookingV2Target). Already-v2 paths, /book/confirmation + /book/race-packs/
  // confirmation (shared/reused post-payment), and /book/checkout are NOT
  // redirected (see bookingV2Target). Query params (?code, ?location) survive
  // via clone(). 307 (temporary) keeps it trivially reversible during cutover —
  // flip to 308 once the v1 booking routes are deleted.
  if (
    pathname === "/book" ||
    pathname.startsWith("/book/") ||
    (isHeadPinz && (pathname === "/hp/book" || pathname.startsWith("/hp/book/")))
  ) {
    const v2Target = bookingV2Target(pathname);
    if (v2Target) {
      const url = request.nextUrl.clone();
      url.pathname = v2Target;
      return NextResponse.redirect(url, 307);
    }
  }

  // In-center self-service kiosk — chrome-free, brand comes from the device
  // config (not the host), serves identically on BOTH domains. Early return
  // so no rewrite/redirect logic below can touch it. x-kiosk lets the root
  // layout drop MiniCarts + analytics (staff/guest shared device).
  if (pathname === "/kiosk" || pathname.startsWith("/kiosk/")) {
    const kioskHeaders = new Headers(request.headers);
    kioskHeaders.set("x-no-chrome", "1");
    kioskHeaders.set("x-no-mobile-bar", "1");
    kioskHeaders.set("x-kiosk", "1");
    if (isHeadPinz) kioskHeaders.set("x-brand", "headpinz");
    return NextResponse.next({ request: { headers: kioskHeaders } });
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
    /^\/[a-zA-Z0-9_-]+\.html$/.test(pathname); // bing*.html, facebook-domain-verification.html, etc

  // HeadPinz domain: rewrite to /hp prefix (unless already there, shared
  // route, or root-level metadata that must be served as-is).
  //
  // Shared routes that exist at the top level and should serve on BOTH
  // domains without /hp rewriting — e.g. /accessibility (host-aware
  // metadata renders the right brand per request).
  const isSharedTopLevelRoute =
    pathname === "/accessibility" ||
    pathname.startsWith("/accessibility/") ||
    pathname === "/cancellation-policy" ||
    pathname.startsWith("/cancellation-policy/") ||
    pathname === "/privacy-policy" ||
    pathname.startsWith("/privacy-policy/") ||
    pathname.startsWith("/event/") ||
    // July-4 USA250 promo landing — advertised on both brand homepages via the
    // promo popup, routes to the right per-venue booking page. Brand chrome is
    // host-aware; the page itself serves both domains.
    pathname === "/july4" ||
    // Short check-in shortlink (redirects into /event/healthnet-2026/confirm).
    pathname === "/healthnet" ||
    // Short SMS shortlink for the Christmas in July blast (redirects into /event/xmas-in-july).
    pathname === "/j" ||
    // Guest-survey landing pages (PR-GS2). Bowling surveys are HP-branded
    // and racing surveys are FT-branded, but the page lives at /survey/*
    // (not /hp/survey/* nor /ft/survey/*) — the route reads the center
    // code from the row and picks the brand. Without this exclusion the
    // /hp rewrite turns into a 404.
    pathname.startsWith("/survey/") ||
    // Marketing unsubscribe page — linked from email footers, must work
    // on both brand domains.
    pathname.startsWith("/marketing/") ||
    // Group function contract pages — brand is determined per-contract
    // from Neon data, not from host. Must serve on both domains.
    pathname.startsWith("/contract/") ||
    // E-ticket pages — racing tickets are FT-branded, HP Arena tickets
    // are HP-branded; brand comes from the ticket record (like /survey/),
    // not the host. Arena SMS links point at headpinz.com/t/{id}, so
    // these must not be /hp-rewritten (404 otherwise).
    pathname.startsWith("/t/") ||
    pathname.startsWith("/g/") ||
    // Prepaid deal packs (/deals, /deals/{slug}). A HeadPinz product, but a
    // TOP-LEVEL route rather than /hp/deals, because the /hp rewrite only fires
    // when the HOST contains "headpinz.com" — so on a Vercel preview host
    // (…-headpinz.vercel.app) or any other alias, /deals 404'd with FastTrax
    // chrome. Ads and emails must not depend on which hostname they land on.
    // Brand is FORCED to headpinz below on both hosts (these are HeadPinz
    // products; a FastTrax-chromed deal page is wrong anywhere), and the
    // canonical always points at headpinz.com/deals/…
    //
    // Trailing slash is REQUIRED on the prefix test — a bare startsWith("/deals")
    // would also swallow any future /deals-something sibling.
    pathname === "/deals" ||
    pathname.startsWith("/deals/") ||
    // Voucher redemption landing (/v/{code}) — our own Game Zone vouchers are
    // emailed/texted to guests, so the link can be opened on EITHER brand
    // domain. Brand-neutral, code-in-path; without this the /hp rewrite 404s
    // every voucher sent to a HeadPinz guest.
    pathname.startsWith("/v/") ||
    // Centralized cross-brand customer account portal (2FA login + Square
    // subscription payment management). Same route on both hosts; brand is
    // chrome-only. Without this the /hp rewrite turns it into a 404 on HeadPinz.
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    // Self-hosted payment-difference links for reservation edits — SMS/email
    // links point at either brand domain; token-gated, brand-neutral page.
    // Without this the /hp rewrite turns it into a 404 on HeadPinz.
    pathname.startsWith("/pay/") ||
    // Public game-card reload flow — QR scans land here on headpinz.com; brand
    // chrome is host-aware. Without this the /hp rewrite 404s it on HeadPinz.
    pathname === "/reload" ||
    pathname.startsWith("/reload/") ||
    // Kiosk mobile-join phone page — QR codes on in-center kiosks land here
    // on EITHER brand domain; brand comes from the join-session record, not
    // the host. Without this the /hp rewrite turns it into a 404 on HeadPinz.
    // (/join-our-team is an exact-key legacy redirect — no collision: the
    // prefix test requires the trailing slash.)
    pathname === "/join" ||
    pathname.startsWith("/join/") ||
    // In-center kiosk (defensive — the early-return block above normally
    // handles /kiosk before we get here; this keeps a future reorder from
    // /hp-rewriting the kiosk into a 404).
    pathname === "/kiosk" ||
    pathname.startsWith("/kiosk/") ||
    // Unified first-party waiver flow — QR / email / SMS links land here on
    // EITHER brand host; center comes from ?c=, brand chrome is host-aware.
    // Mirrors /join. (The static /waiver-3 legal page matches neither test.)
    pathname === "/waiver" ||
    pathname.startsWith("/waiver/") ||
    // Waiver capability short links — /w/{code}, served by app/w/[code]/route.ts.
    // These are EMAILED AND TEXTED to guests of both brands (a HeadPinz booker's
    // confirmation carries https://headpinz.com/w/{code}), so without this
    // exclusion the /hp rewrite turns every HeadPinz waiver link into a 404.
    // Path constant: WAIVER_LINK_PATH in lib/waiver-short-link.ts — the two are
    // pinned together by a test in lib/waiver-short-link.test.ts.
    //
    // The trailing slash is REQUIRED. A bare startsWith("/w") would also swallow
    // /waiver, /waiver-3 and every future top-level path beginning with "w" —
    // the same trap documented above for /book/bowling vs /book/bowling-confirmation.
    // A bare /w is deliberately NOT registered: it carries no code and there is no
    // route at /w on either host.
    //
    // No x-no-chrome pairing below: the resolver renders NOTHING. It looks the code
    // up and 302s to /waiver, which carries its own x-no-chrome registration.
    pathname.startsWith("/w/");
  if (
    isHeadPinz &&
    !pathname.startsWith("/hp") &&
    !pathname.startsWith("/book") &&
    !pathname.startsWith("/api") &&
    !pathname.startsWith("/s/") &&
    !pathname.startsWith("/documents") &&
    !pathname.startsWith("/tax-exempt") &&
    !isRootMetadataPath &&
    !isSharedTopLevelRoute
  ) {
    const url = request.nextUrl.clone();
    url.pathname = `/hp${pathname}`;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    // The bare location-chooser splash (headpinz.com/) is a chrome-free brand
    // landing whose whole job is "pick a location." The root layout otherwise
    // renders the HeadPinz center Nav/Footer here (it defaults to Fort Myers
    // with no location picked), which is wrong on a pre-location splash. Flag
    // the chooser so the root layout suppresses HP chrome on it ONLY — every
    // other /hp page keeps its chrome.
    if (pathname === "/") requestHeaders.set("x-hp-no-chrome", "1");
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // HeadPinz domain on a shared top-level route (e.g. /survey/, /event/) —
  // skip the /hp rewrite but STILL flag the brand so the root layout
  // suppresses the FastTrax Nav/Footer and the body picks up brand-headpinz
  // (deep navy + HP fonts). Also suppress the mobile Book-Now bar so it
  // doesn't overlap a focused customer-flow screen.
  if (isHeadPinz && isSharedTopLevelRoute) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    if (pathname.startsWith("/survey/")) {
      requestHeaders.set("x-no-mobile-bar", "1");
    }
    if (pathname.startsWith("/contract/")) {
      requestHeaders.set("x-no-mobile-bar", "1");
    }
    if (pathname.startsWith("/event/")) {
      requestHeaders.set("x-no-mobile-bar", "1");
    }
    // E-tickets suppress the mobile Book-Now bar on the HP host too
    // (same rationale as the FT-host block below — focused customer
    // flow, QR modals).
    if (pathname.startsWith("/t/") || pathname.startsWith("/g/")) {
      requestHeaders.set("x-no-mobile-bar", "1");
    }
    if (pathname.startsWith("/account")) {
      requestHeaders.set("x-no-mobile-bar", "1");
    }
    // July-4 promo landing: full-bleed marketing hero with its own dual-brand
    // logos — suppress the HeadPinz Nav/Footer entirely (like the chooser splash).
    if (pathname === "/july4") {
      requestHeaders.set("x-no-chrome", "1");
    }
    // Kiosk mobile-join phone flow: a focused mid-visit screen with its own
    // brand header — no site Nav/Footer/mobile bar on either host (x-no-chrome
    // suppresses all three via the root layout).
    if (pathname === "/join" || pathname.startsWith("/join/")) {
      requestHeaders.set("x-no-chrome", "1");
    }
    // Unified waiver flow: focused customer screen with its own brand header.
    if (pathname === "/waiver" || pathname.startsWith("/waiver/")) {
      requestHeaders.set("x-no-chrome", "1");
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Prepaid deal packs on ANY NON-headpinz.com host (FastTrax, a Vercel preview
  // alias, a bare deployment URL): force HeadPinz chrome anyway.
  //
  // Unlike /july4, this is NOT host-aware. The packs sell HeadPinz laser tag, gel
  // blasters and HeadPinz game cards — FastTrax sells none of them — so a
  // FastTrax-branded deal page is wrong on every host, not just an odd one. Brand
  // comes from the PRODUCT here, the same way /survey and /contract take theirs
  // from the record rather than the hostname.
  //
  // (The headpinz.com host already returned above with the brand set; only other
  // hosts reach this.)
  if (pathname === "/deals" || pathname.startsWith("/deals/")) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // July-4 promo landing on the FastTrax host: suppress site chrome so the
  // full-bleed marketing hero (with its own dual-brand logos) stands alone.
  // (The HeadPinz host is handled in the shared-route block above.)
  // The kiosk mobile-join phone flow gets the same treatment — it renders its
  // own brand header from the join-session record.
  if (
    pathname === "/july4" ||
    pathname === "/join" ||
    pathname.startsWith("/join/") ||
    pathname === "/waiver" ||
    pathname.startsWith("/waiver/")
  ) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-no-chrome", "1");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Survey, contract, and event routes on EITHER domain: suppress the mobile
  // Book-Now bar so it doesn't overlap focused customer-flow screens.
  if (
    pathname.startsWith("/survey/") ||
    pathname.startsWith("/contract/") ||
    pathname.startsWith("/event/") ||
    pathname.startsWith("/account")
  ) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-no-mobile-bar", "1");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // HeadPinz domain on shared routes (/book, /api):
  //   - /book (exactly) → rewrite to /hp/book (HP-branded booking hub)
  //   - /book/bowling/* → rewrite to /hp/book/bowling/* (bowling pages
  //     live at app/hp/book/bowling/, not app/book/bowling/; without this
  //     rewrite, the dynamic [attraction] catch-all serves the wrong page)
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
  // NOTE: the V1→V2 cutover above already redirects /book/bowling and
  // /book/kids-bowl-free to their v2 routes, so this v1 rewrite is now a
  // fallback. The `/v2` exclusion is REQUIRED: without it `/book/bowling/v2`
  // (the cutover's own destination) would be rewritten to `/hp/book/bowling/v2`
  // and 404 — the latent bug that hid v2 bowling/KBF on the headpinz.com domain.
  // The prefix tests MUST carry a trailing slash (or match exactly). A bare
  // `startsWith("/book/bowling")` also swallows `/book/bowling-confirmation` —
  // the FastTrax duckpin confirmation, which lives at app/book/bowling-confirmation
  // (bare, self-brands from centerCode) with NO app/hp/ twin — rewriting it to
  // /hp/book/bowling-confirmation, where the [attraction] catch-all serves a
  // "not found" (the exact symptom that broke duckpin confirmations opened on
  // the headpinz.com host). Letting it fall through to the shared pass-through
  // below serves the bare route on both domains.
  if (
    isHeadPinz &&
    (pathname === "/book/bowling" ||
      pathname.startsWith("/book/bowling/") ||
      pathname === "/book/kids-bowl-free" ||
      pathname.startsWith("/book/kids-bowl-free/")) &&
    !/\/v2(?:\/|$)/.test(pathname)
  ) {
    const url = request.nextUrl.clone();
    url.pathname = `/hp${pathname}`;
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
    // Preserve the query string — dropping it here silently lost ?neonId= on
    // the duckpin check-in link and produced "Invalid reservation link".
    return NextResponse.redirect(`https://headpinz.com${hpPath}${request.nextUrl.search}`);
  }

  // Set brand header for /hp/ routes (dev access on localhost)
  if (pathname.startsWith("/hp")) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-brand", "headpinz");
    // Mirror the prod chooser-splash rule for dev/localhost (/hp or /hp/):
    // chrome-free brand landing — see the rewrite block above.
    if (pathname === "/hp" || pathname === "/hp/") requestHeaders.set("x-hp-no-chrome", "1");
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
    // Any booking confirmation screen — the top-level /book/confirmation
    // as well as the per-flow nested confirmations
    // (/book/checkout/confirmation, /book/race/confirmation,
    // /book/race-packs/confirmation, /book/[attraction]/confirmation).
    // These ARE the customer's e-ticket screen, so the "Book Now" bar is
    // just noise — match the /confirmation segment anywhere in the path.
    /\/confirmation(?:\/|$)/.test(pathname);
  if (suppressMobileBar) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-no-mobile-bar", "1");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  return NextResponse.next();
}

/**
 * Map a v1 booking path to its v2 equivalent for the V1→V2 cutover, or null when
 * it should NOT be redirected. Strips an optional `/hp` prefix so HeadPinz direct
 * links (e.g. /hp/book/bowling) map too. Returns null for:
 *   - already-v2 paths (any `/v2` segment) — prevents redirect loops
 *   - /book/race-packs/confirmation — reused by the v2 race-pack flow for its success screen
 *   - /book/confirmation* — shared by v1 AND v2 (post-payment landing)
 *   - /book/race/confirmation, /book/checkout* — v1 surfaces with no 1:1 v2 route
 *   - anything unrecognized
 */
function bookingV2Target(pathname: string): string | null {
  if (/\/v2(?:\/|$)/.test(pathname)) return null;
  const p = (pathname.replace(/^\/hp/, "").replace(/\/+$/, "") || "/").toLowerCase();
  // Post-payment confirmation + self check-in screens are NOT booking entries —
  // never redirect them into the v2 flow. Without this, the bowling/KBF prefix
  // rules below (`startsWith("/book/bowling/")` etc.) caught
  // `/hp/book/bowling/confirmation` and `/hp/book/bowling/checkin` and bounced
  // paid customers — and the texted confirmation/lane-ready links — back to the
  // booking form's "Your Info" step.
  if (p.includes("/confirmation") || p.includes("/checkin")) return null;
  if (p === "/book") return "/book/v2";
  if (p === "/book/race") return "/book/race/v2"; // exact — NOT /book/race-packs or /book/race/confirmation
  if (p === "/book/race-packs") return "/book/race-pack/v2"; // exact — NOT /book/race-packs/confirmation
  if (p === "/book/bowling" || p.startsWith("/book/bowling/")) return "/book/bowling/v2";
  if (p === "/book/kids-bowl-free" || p.startsWith("/book/kids-bowl-free/")) return "/book/kbf/v2";
  for (const slug of ["gel-blaster", "laser-tag", "duck-pin", "shuffly"]) {
    if (p === `/book/${slug}` || p.startsWith(`/book/${slug}/`)) return `/book/${slug}/v2`;
  }
  return null;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|images/|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js)$).*)",
  ],
};
