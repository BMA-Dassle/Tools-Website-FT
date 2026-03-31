import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "wuce3at4k1appcmf.public.blob.vercel-storage.com",
      },
    ],
  },
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
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://downloads-global.3cx.com https://va.vercel-scripts.com",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: blob: https://wuce3at4k1appcmf.public.blob.vercel-storage.com https://*.3cx.com https://*.3cx.us",
            "connect-src 'self' https://modules-api22.sms-timing.com https://tools-track-status.vercel.app https://*.3cx.us https://*.3cx.com https://va.vercel-scripts.com https://vitals.vercel-insights.com",
            "frame-src 'self' https://www.cognitoforms.com https://kiosk.bmileisure.com https://*.3cx.us",
            "media-src 'self' https://wuce3at4k1appcmf.public.blob.vercel-storage.com",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self' https://www.cognitoforms.com",
            "frame-ancestors 'self'",
          ].join("; "),
        },
      ],
    },
  ],
};

export default nextConfig;
