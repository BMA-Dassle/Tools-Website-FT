import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  ],
  headers: async () => [
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
        // Permissions policy — disable unused browser features
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        // Content Security Policy
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
            "style-src 'self' 'unsafe-inline' https:",
            "font-src 'self' https:",
            "img-src 'self' data: blob: https: http:",
            "connect-src 'self' https: wss://webserver22.sms-timing.com:10015",
            "frame-src 'self' https://www.cognitoforms.com https://kiosk.bmileisure.com https://*.3cx.us https://profile.squareup.com https://squareup.com https://pci-connect.squareup.com https://web.squarecdn.com https:",
            "media-src 'self' https://wuce3at4k1appcmf.public.blob.vercel-storage.com",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self' https://www.cognitoforms.com https:",
            "frame-ancestors 'self' https://booking.bmileisure.com",
          ].join("; "),
        },
      ],
    },
  ],
};

export default nextConfig;
