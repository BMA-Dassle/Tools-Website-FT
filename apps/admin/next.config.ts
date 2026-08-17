import type { NextConfig } from "next";

/**
 * The admin proxy shell has no UI of its own — every request is handled in
 * proxy.ts (forwarded upstream, redirected, or 404'd). Config stays minimal
 * on purpose; the upstream app owns headers/CSP/rewrites for the responses
 * it serves.
 */
const nextConfig: NextConfig = {
  devIndicators: false,
};

export default nextConfig;
