import type { NextRequest } from "next/server";
import { getShareLinkForOpen, openShare, recordShareOpen } from "~/features/crm/collateral";

/**
 * GET /api/crm/share/<token> — THE ONE GUEST-FACING SURFACE IN THE CRM.
 *
 * WHY IT IS PUBLIC (brief R3: exactly three `/api/crm/**` routes may be, and
 * each must say so in its own header). This URL goes in a text or an email to
 * a guest who has no account, no session and no reason to have one; it is
 * opened from a phone, usually once, often by forwarding. A gate here would
 * mean no guest could ever open a flyer.
 *
 * WHAT AUTHENTICATES IT. The token IS the credential — 128 bits from
 * `crypto.randomBytes`, base64url, minted per share (`service/share.ts`). The
 * other two public routes hold a shared secret from the environment because
 * their caller is a machine we configured; this one's caller is a stranger
 * holding a capability, so the capability is the check. It fails CLOSED in
 * both directions:
 *   · a token that does not match the shape, or has no row → 404, the same
 *     answer for both, so the route cannot be used to probe what exists;
 *   · an expired, revoked, or archived-file link → 410 with a short bilingual
 *     page (the guest-facing copy rule: English AND Spanish, never one).
 * Nothing here reads a session, a cookie, or any admin credential, and the
 * response body never contains guest data, a file title or an id.
 *
 * WHAT IT RECORDS. One open per viewer-minute (`openKeyFor` — a salted hash of
 * the viewer and the minute, so a mail client's pre-fetch and a double tap are
 * one open, and nothing identifying is stored), then a 302 to the blob URL.
 * `no-store` on every answer: a CDN or a mail proxy caching the redirect would
 * make the open count fiction, and would keep serving a revoked link.
 *
 * THE PATH IS PINNED (`service/share.test.ts`). It is not `/s/[token]` —
 * `app/s/[code]` is already the guest booking-confirmation short link, Next
 * refuses two slug names at one level, and a new top-level segment would need
 * a `SHARED_TOP_LEVEL_ROUTES` entry this programme is not allowed to make.
 * `/api/*` already serves on all three hosts with no middleware change.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate",
  "referrer-policy": "no-referrer",
} as const;

/**
 * The 410. Two lines, English then Spanish, no interpolation of anything at
 * all — not the token, not the file, not the guest — so there is no injection
 * surface and nothing leaks to whoever now holds a forwarded link.
 */
const GONE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Link expired</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1726;color:#f9fafb;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}main{max-width:32rem;text-align:center}p{margin:0 0 12px}span{color:#98a2b3}</style>
</head><body><main>
<p>This link has expired. Please ask us for a new one.</p>
<p><span lang="es">Este enlace ha vencido. Pídanos uno nuevo, por favor.</span></p>
</main></body></html>`;

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;

  const outcome = await openShare(
    token,
    { ip: clientIp(req), userAgent: req.headers.get("user-agent") },
    { getShareLinkForOpen, recordShareOpen },
  );

  if (outcome.kind === "not_found") {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
    });
  }
  if (outcome.kind === "gone") {
    return new Response(GONE_HTML, {
      status: 410,
      headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
    });
  }

  return new Response(null, {
    status: 302,
    headers: { location: outcome.url, ...NO_STORE },
  });
}
