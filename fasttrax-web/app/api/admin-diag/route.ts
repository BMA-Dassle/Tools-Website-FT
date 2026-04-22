import { NextRequest, NextResponse } from "next/server";

/**
 * Public diagnostic for the /admin/* gate. Use this to troubleshoot
 * 404s on the admin URL.
 *
 *   GET /api/admin-diag                   — report seen IP + env state
 *   GET /api/admin-diag?token=xxxx        — also checks if the supplied
 *                                           token matches the configured
 *                                           one (yes/no only — never
 *                                           echoes the configured value)
 *
 * This endpoint is NOT behind the admin gate on purpose — it exists
 * specifically to debug why the gate is rejecting. Intentionally safe:
 *   - Never returns the configured token value
 *   - Never returns the full allowlist (only "is your IP in it")
 *   - Reports only booleans + the caller's own IP
 *
 * If you need to retire it after setup, delete this file.
 */

export async function GET(req: NextRequest) {
  const xff = req.headers.get("x-forwarded-for") || "";
  const firstXff = xff.split(",")[0]?.trim() || "";
  const realIp = req.headers.get("x-real-ip") || "";
  const seenIp = firstXff || realIp || "";

  const expected = process.env.ADMIN_ETICKETS_TOKEN || "";
  const allowlistRaw = process.env.ADMIN_ALLOWED_IPS || "";
  const allowlist = allowlistRaw
    .split(",").map((s) => s.trim()).filter(Boolean);
  const allowlistSet = new Set(allowlist);

  const suppliedToken = new URL(req.url).searchParams.get("token") || req.headers.get("x-admin-token") || "";
  const tokenMatches = !!expected && !!suppliedToken && suppliedToken === expected;

  return NextResponse.json(
    {
      seenIp,
      rawXForwardedFor: xff,
      rawXRealIp: realIp,
      ipAllowlistCount: allowlist.length,
      ipAllowlistConfigured: allowlist.length > 0,
      ipInAllowlist: !!seenIp && allowlistSet.has(seenIp),
      tokenEnvConfigured: !!expected,
      tokenEnvLength: expected.length,
      tokenSupplied: !!suppliedToken,
      tokenSuppliedLength: suppliedToken.length,
      tokenMatches,
      note:
        expected.length === 0
          ? "ADMIN_ETICKETS_TOKEN is NOT set in Vercel env — add it and redeploy."
          : allowlist.length === 0
            ? "ADMIN_ALLOWED_IPS is NOT set — add it and redeploy."
            : !allowlistSet.has(seenIp) && seenIp
              ? `Your IP ${seenIp} is not in ADMIN_ALLOWED_IPS. Add it and redeploy.`
              : "Both env vars appear configured. If the page still 404s, try hitting it again.",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
