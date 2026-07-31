import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  WAIVER_LINK_CODE_RE,
  WAIVER_LINK_COOKIE,
  WAIVER_LINK_COOKIE_MAX_AGE,
  isRetryableLookup,
  lookupWaiverLinkTarget,
  maskCode,
  recordWaiverLinkHit,
} from "@/lib/waiver-short-link";
import { buildWaiverUrl } from "~/features/waiver/build-waiver-url";

/**
 * `/w/{code}` — the waiver capability short link a guest actually clicks.
 *
 * Looks the opaque code up, records the click, and redirects to the waiver page. The
 * code never reaches the address bar: it travels on in an HttpOnly cookie, and the
 * `organizer` and `register` codes for one reservation redirect to the IDENTICAL
 * `/waiver?c=&loc=&pid=` target, so a forwarded link reveals no capability.
 *
 * ── This route makes no authorization decision ────────────────────────────────
 * It hands over the code the guest arrived with and nothing else — it does not read
 * `.capability`, does not branch on it, and stores no verdict anywhere. Whether that
 * code grants the remove button is decided at the point of use by
 * `waiverLinkGrantsOrganizerFor(cookie, projectId)`, which reads the row. That keeps the
 * grant REVOCABLE (fix the row and the next click is denied) and means a forwarded
 * `register` code in the cookie is inert by construction rather than by a check here.
 *
 * ── Serves on BOTH brand hosts ────────────────────────────────────────────────
 * `/w/` is registered in `isSharedTopLevelRoute` in `middleware.ts`. It must stay
 * there: HeadPinz rewrites unregistered top-level paths into `/hp/*`, and these links
 * go out in HeadPinz email and SMS, so an unregistered `/w` = every HeadPinz waiver
 * link 404s. The redirect Location is RELATIVE, which keeps the guest on whichever
 * host they opened (headpinz.com stays headpinz.com) with no origin reconstruction —
 * the same property `app/s/[code]/page.tsx` relies on.
 *
 * ── Never a dead end, but "dead" and "unreadable" are NOT the same ────────────
 * Three outcomes, and the split runs along ONE line: did we get an authoritative answer?
 *
 * 1. `unknown` — an ANSWER: Neon has no such row, or the shape could never be ours. No
 *    404: the guest is sent to `/waiver` to sign standalone. They lose the reservation
 *    attach and the remove button; they never get a broken link. That path CLEARS the
 *    cookie, so a dead link cannot leave an earlier grant on the device.
 *
 * 2. `unavailable` + `unreadable` — NO answer (Neon unreachable, no DATABASE_URL, the
 *    table missing from the database we asked). Handled the opposite way, because it says
 *    nothing about a link that is probably fine:
 *      - it is RETRIED once, then EXPLAINED with a 503 + Retry-After — never redirected;
 *      - the cookie is left strictly ALONE.
 *    Sending that guest to standalone `/waiver` would be the worse of two failures: they
 *    would sign a waiver attached to NOTHING, believe they were done, and be made to
 *    re-sign at the counter — silently, from a blip. And clearing the cookie would let an
 *    infrastructure hiccup REVOKE a capability nobody revoked (the module rule is to
 *    revoke a status only with the same reach that granted it — that is the row, not a
 *    failed connection). A 503 the guest can reload costs them seconds; an unattached
 *    signature costs them their spot in line.
 *
 * 3. `unavailable` + `unusable-row` — an ANSWER we cannot use: the row is there and its
 *    ids point nowhere. NOT retried and NOT 503'd: a permanent fault dressed as "try
 *    again" is a guest reloading forever. It redirects to standalone `/waiver` like an
 *    unknown code (the code exists, but it attaches to nothing, so standalone is all it
 *    was ever worth) with its own log line, because this is a data-integrity signal about
 *    OUR row, not an availability signal and not a guest's dead link.
 *    A row whose ONLY fault is its capability column never reaches here — the resolver
 *    reports it `found`, since where to send the guest never depended on the capability.
 *
 * The one rule underneath all three: a link that IS in the store never fails the guest
 * because a read failed, and no path here 404s or 500s.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // node:crypto + ioredis + Neon in the resolver chain

/**
 * Link-preview fetchers (iMessage, WhatsApp, Slack, …) hit the URL before the guest
 * does. Same list `app/s/[code]/page.tsx` uses — they must not inflate a click count
 * we keep for five months.
 */
const BOT_UA_RE =
  /bot\b|crawler|spider|preview|facebookexternalhit|whatsapp|telegrambot|slackbot|linkedinbot|discordbot|googlebot|bingbot|applebot|pinterestbot|curl\/|wget\/|python-requests|httpx/i;

/**
 * 302 to a RELATIVE path so the brand host is preserved, with the arrival code either
 * set or cleared — never left as it was. `no-store` is mandatory: this response
 * carries a Set-Cookie holding a bearer token, so no shared cache may keep it.
 */
function redirectCarrying(target: string, code: string | null): NextResponse {
  const res = new NextResponse(null, {
    status: 302,
    headers: { location: target, "cache-control": "private, no-store" },
  });
  res.cookies.set(WAIVER_LINK_COOKIE, code ?? "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    // Root path, not /waiver: the roster endpoint lives under
    // /api/waiver/*, which a /waiver-scoped cookie would never be sent to.
    path: "/",
    maxAge: code ? WAIVER_LINK_COOKIE_MAX_AGE : 0,
  });
  return res;
}

/**
 * The `unreadable` answer, and ONLY that one: we could not read the truth, so we say so
 * and invite a retry. Deliberately NOT a redirect and deliberately NOT a cookie write.
 * Never served for a fault we already read and know to be permanent — "try again" has to
 * be true, or it is just a loop.
 *
 * No Set-Cookie at all — not a set, not a clear. We learned nothing about this code,
 * so nothing about the device's grant may change.
 *
 * The code is NEVER rendered in the body: it is a bearer token, and this page is the
 * one a confused guest is most likely to screenshot and send to staff.
 *
 * No auto-refresh meta tag on purpose. An automatic reload loop across every device
 * holding a link would hammer a database that is already failing (this stack has an
 * OOM/eviction history); the guest reloads when they choose to.
 */
function retryLater(): NextResponse {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>One moment — please try again</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}
main{max-width:29rem}h1{font-size:1.35rem;margin:0 0 .6rem}
p{margin:0 0 1rem;opacity:.85}
button{font:inherit;font-weight:600;padding:.7rem 1.4rem;border:0;border-radius:8px;
cursor:pointer;background:#1c62d4;color:#fff}
</style></head><body><main>
<h1>We could not load your reservation</h1>
<p>Your link is still good — we just could not reach our system for a moment.
Please try again.</p>
<button type="button" onclick="location.reload()">Try again</button>
<p><small>If this keeps happening, call the center and we will check you in at
the counter.</small></p>
</main></body></html>`;
  return new NextResponse(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": "5",
      "cache-control": "private, no-store",
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;

  // Shape gate first: a malformed code must not reach the database.
  if (!code || !WAIVER_LINK_CODE_RE.test(code)) {
    return redirectCarrying(buildWaiverUrl({}), null);
  }

  // Target only. `lookupWaiverLinkTarget` cannot report a capability — the returned
  // shape has no such field — so this route is incapable of leaking or acting on one,
  // and the redirect can be served from a warm cache without authorization passing
  // through Redis. It reports a STATUS plus, when there is no verdict, a REASON — which
  // is what separates a dead link from a read that never answered.
  let lookup = await lookupWaiverLinkTarget(code);

  // One retry, and ONLY when we never got an answer (`isRetryableLookup` — the module
  // owns that definition so this route cannot drift from it). A dropped connection or a
  // cold start is the common shape of that failure and a second attempt usually just
  // works — a read is idempotent, so it costs a guest nothing but the round trip.
  // Everything else is an answer: `unknown` is a verdict, and a corrupt row reads the
  // same way twice, so retrying either would just double the load and change nothing.
  if (isRetryableLookup(lookup)) {
    lookup = await lookupWaiverLinkTarget(code);
  }

  if (lookup.status === "unavailable" && lookup.reason === "unreadable") {
    // NOT "unresolved" — we never got to ask. Distinct log line so this cannot be
    // read as a dead-link count in a dashboard; it is a database availability signal.
    console.error(
      `[w] could NOT READ waiver code ${maskCode(code)} — asking the guest to retry (link NOT presumed dead, grant left intact)`,
    );
    return retryLater();
  }

  if (lookup.status === "unavailable") {
    // `unusable-row`: we DID read the row and it points at no reservation. Permanent, so
    // a 503 saying "your link is still good, try again" would be a lie the guest can only
    // reload forever. Standalone signing is what a code attached to nothing is worth, and
    // clearing the cookie is legitimate here because we read the row — the same reach
    // that granted it. Loud, and on its own line: this is OUR data, not the guest's.
    console.error(
      `[w] waiver code ${maskCode(code)} resolves to a row that points at NO RESERVATION — sending to standalone /waiver (data integrity, NOT availability, NOT retryable)`,
    );
    return redirectCarrying(buildWaiverUrl({}), null);
  }

  if (lookup.status === "unknown") {
    console.warn(`[w] unresolved waiver code ${maskCode(code)} — sending to standalone /waiver`);
    return redirectCarrying(buildWaiverUrl({}), null);
  }

  const link = lookup.link;

  // Awaited, not fire-and-forget: a serverless function can be frozen the instant the
  // response is returned, which silently drops a detached write. It swallows its own
  // errors, so it can neither throw nor cost the guest their redirect.
  if (!BOT_UA_RE.test(req.headers.get("user-agent") || "")) await recordWaiverLinkHit(code);

  // `link.target` is built by buildWaiverUrl and carries only the center and
  // reservation — never the code, never a capability.
  return redirectCarrying(link.target, link.code);
}
