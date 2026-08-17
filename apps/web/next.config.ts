import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the local dev-mode indicator badge (it overlays content during review;
  // never appears in production).
  devIndicators: false,
  // DEV ONLY: Next blocks cross-origin requests to /_next/* dev assets, so a
  // kiosk browsing to a dev laptop by LAN IP gets HTML but no JS (the kiosk
  // canvas renders unscaled/broken). Allow the private LAN ranges we dev on —
  // ignored entirely by production builds. See docs/crt-591/README.md dev loop.
  allowedDevOrigins: ["10.48.0.*", "192.168.*.*", "localhost", "127.0.0.1"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "wuce3at4k1appcmf.public.blob.vercel-storage.com",
      },
      {
        protocol: "https",
        hostname: "headpinz.com",
      },
      {
        protocol: "https",
        hostname: "www.kidsbowlfree.com",
      },
      {
        protocol: "https",
        hostname: "resourcespubqamfuse.blob.core.windows.net",
      },
    ],
  },
  // Old `/book/racing` flow was retired in favor of `/book/race` (BMI
  // Public API). Keep the URLs alive for any old bookmarks / external
  // links / Square redirect URLs that might still point here.
  redirects: async () => [
    { source: "/book/racing", destination: "/book/race", permanent: true },
    { source: "/book/racing/:path*", destination: "/book/race", permanent: true },

    // ── www → apex 301s ────────────────────────────────────────────
    // Google Search Console was tracking the www and apex hosts as
    // separate URL profiles for both domains, splitting top-page click
    // counts (e.g. "/" appeared twice in GSC top-pages reports).
    // Canonical tags in app/layout.tsx already point to apex; these
    // 301s belt-and-suspender it so any inbound www link consolidates
    // BEFORE crawlers ever evaluate canonical-tag mismatches.
    {
      source: "/:path*",
      has: [{ type: "host", value: "www.fasttraxent.com" }],
      destination: "https://fasttraxent.com/:path*",
      permanent: true,
    },
    {
      source: "/:path*",
      has: [{ type: "host", value: "www.headpinz.com" }],
      destination: "https://headpinz.com/:path*",
      permanent: true,
    },
  ],
  // Brand-domain pass-through for Vercel Blob assets so customer-
  // visible URLs read as fasttraxent.com / headpinz.com instead of
  // the blob-store hostname. Scoped to /documents/* (the user-
  // facing "Download Event Guide" / "Download Sales Booklet" links).
  // Images already render via /_next/image so the blob host doesn't
  // show up in src attributes — adding rewrites for those would just
  // proxy bytes for no UX gain.
  rewrites: async () => [
    {
      source: "/documents/:path*",
      destination: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/documents/:path*",
    },
    // Guest-uploaded DR-14 tax exempt certificates (contract page).
    {
      source: "/tax-exempt/:path*",
      destination: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/tax-exempt/:path*",
    },
    // Kiosk image proxy — the kiosk paints its photos as CSS backgrounds /
    // plain <img> (not next/image), so serve them through OUR origin instead
    // of the blob host directly. The blob host is fronted by a Vercel firewall
    // challenge that trips per source-IP under bursty traffic (a NATed venue
    // loading many tiles at once) and returns a JS "Security Checkpoint" that a
    // background/img request can't solve → blank tiles (HeadPinz-Fort-Myers,
    // 2026-07-24). Same-origin requests are never challenged; the server-side
    // proxy fetch isn't rate-flagged (same mechanism as /documents). Kiosk
    // asset URLs are built off this prefix in features/kiosk/assets.ts.
    {
      source: "/kimg/:path*",
      destination: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/:path*",
    },
  ],
  headers: async () => [
    // Admin embed pages — allow portal.headpinz.com to iframe them.
    // Must come before the catch-all so the more-specific rule wins.
    {
      source: "/admin/:path*",
      has: [{ type: "query", key: "embedded", value: "1" }],
      headers: [
        { key: "X-Frame-Options", value: "ALLOW-FROM https://portal.headpinz.com" },
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
            "style-src 'self' 'unsafe-inline' https:",
            "font-src 'self' https:",
            "img-src 'self' data: blob: https: http:",
            // The pit station's Q-SYS audio feed: Pandora's wss relay (the
            // default, pinned) and ws: for the LAN direct-to-Core override
            // (scheme-wide because the Core's address is runtime config;
            // that override also needs the tablet's per-site mixed-content
            // allowance — CSP is only half of that lock).
            "connect-src 'self' https: ws: wss://webserver22.sms-timing.com:10015 wss://bma-pandora-api.azurewebsites.net",
            "frame-src 'self' https:",
            // *.vmsproxy.com — Nx Witness live camera video, played by the
            // browser straight from the cloud relay because a serverless
            // function cannot hold a stream open (see nx/camera.server.ts).
            // TWO hosts, and both must match: the relay answers on
            // <cloudSystemId>.relay.vmsproxy.com and 307s to a regional node
            // (<id>.relay-us-mia-1-prod-dp.vmsproxy.com), and CSP is checked
            // against the redirect target too. Its absence is why the
            // full-screen viewer silently fell back to stills from the day it
            // shipped: the fetch worked, the <video> was blocked.
            "media-src 'self' blob: https://wuce3at4k1appcmf.public.blob.vercel-storage.com https://*.vmsproxy.com",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self' https:",
            "frame-ancestors https://portal.headpinz.com",
          ].join("; "),
        },
      ],
    },
    {
      source: "/(.*)",
      headers: [
        // Cache control
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Pragma", value: "no-cache" },
        { key: "Expires", value: "0" },
        // Clickjacking protection
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        // MIME type sniffing prevention
        { key: "X-Content-Type-Options", value: "nosniff" },
        // HTTPS enforcement (1 year, include subdomains)
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
        // Referrer policy — stop leaking full URLs to third parties
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        // Permissions policy — disable unused browser features. camera=(self):
        // the kiosk's waiver-photo capture needs getUserMedia on OUR origin
        // (camera=() denied it site-wide — cameras "worked on every other
        // website" but never here, failing instantly with no prompt, owner
        // 2026-07-18). self-only keeps third-party iframes blocked, and the
        // browser permission prompt still gates actual use. serial=(self):
        // the kiosk admin pairs the CRT-591 card reader over Web Serial —
        // self is the spec default, but explicit so a future tightening pass
        // can't repeat the camera incident, and so the admin panel's
        // permission diagnostics (document.featurePolicy) can name this
        // header when it IS the blocker.
        {
          key: "Permissions-Policy",
          value: "camera=(self), microphone=(), geolocation=(), serial=(self)",
        },
        // Content Security Policy
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
            "style-src 'self' 'unsafe-inline' https:",
            "font-src 'self' https:",
            "img-src 'self' data: blob: https: http:",
            // Loopback http entries: the kiosk PC's game-card-bridge
            // (127.0.0.1:4599) — connect-src has no scheme-wide http allowance,
            // so without these the kiosk silently falls back to cloud loads.
            // wss://bma-pandora-api… — the pit station's Q-SYS audio feed via
            // Pandora's relay; ws: is the LAN direct-to-Core override. See
            // the admin block above.
            "connect-src 'self' https: ws: wss://webserver22.sms-timing.com:10015 wss://bma-pandora-api.azurewebsites.net http://127.0.0.1:4599 http://localhost:4599",
            "frame-src 'self' https://www.cognitoforms.com https://kiosk.bmileisure.com https://*.3cx.us https://profile.squareup.com https://squareup.com https://pci-connect.squareup.com https://web.squarecdn.com https:",
            // *.vmsproxy.com — Nx Witness live camera video, played by the
            // browser straight from the cloud relay because a serverless
            // function cannot hold a stream open (see nx/camera.server.ts).
            // TWO hosts, and both must match: the relay answers on
            // <cloudSystemId>.relay.vmsproxy.com and 307s to a regional node
            // (<id>.relay-us-mia-1-prod-dp.vmsproxy.com), and CSP is checked
            // against the redirect target too. Its absence is why the
            // full-screen viewer silently fell back to stills from the day it
            // shipped: the fetch worked, the <video> was blocked.
            "media-src 'self' blob: https://wuce3at4k1appcmf.public.blob.vercel-storage.com https://*.vmsproxy.com",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self' https://www.cognitoforms.com https:",
            "frame-ancestors 'self' https://booking.bmileisure.com https://portal.headpinz.com",
          ].join("; "),
        },
      ],
    },
    // Kiosk image caching — MUST come LAST. Next applies matching header rules
    // in order and a later same-key value overrides an earlier one, so these
    // override the catch-all's no-store (above) for kiosk assets only. Without a
    // real TTL the kiosk re-downloads every tile on each screen change — one
    // attraction photo is ~10 MB — over venue WiFi. The catch-all's other
    // security headers (CSP/HSTS/nosniff) still apply, per-key; nosniff is
    // re-asserted defensively.
    {
      source: "/kimg/:path*",
      headers: [
        { key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=604800" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    },
    {
      source: "/brand/:path*",
      headers: [
        { key: "Cache-Control", value: "public, max-age=86400" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    },
  ],
};

export default nextConfig;
