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
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://downloads-global.3cx.com https://va.vercel-scripts.com https://web.squarecdn.com https://sandbox.web.squarecdn.com https://pay.google.com",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://web.squarecdn.com",
            "font-src 'self' https://fonts.gstatic.com https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net https://cash-f.squarecdn.com",
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
