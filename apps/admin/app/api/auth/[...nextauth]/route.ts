import { handlers } from "@/auth";

/**
 * Auth.js's own endpoints — /api/auth/signin, /callback/headpinz, /session,
 * /signout, /csrf. The ONLY routes this project serves itself; everything else
 * is proxied upstream (src/routes.ts marks this prefix `self`).
 */
export const { GET, POST } = handlers;
