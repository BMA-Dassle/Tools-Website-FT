import { NextRequest, NextResponse } from "next/server";
import { codeForPersonId } from "~/features/kiosk/license/code-cache";
import { lookupMemberMatches } from "~/features/kiosk/license/lookup.server";
import { resolveLicencePack, packHas } from "~/features/racing/service/licence-pack";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/racing/licence-offer/add?billId=…&personId=… — hop to a racer's
 * wallet licence WITHOUT ever putting their login code in the browser.
 *
 * On a phone, a QR is useless for your OWN licence — you cannot scan the screen
 * you are holding. That row needs a direct link, but the target
 * (`/r/{code}/wallet`) embeds the login code, and a code is the racer's identity
 * at the kiosk, the desk and the register. So the browser gets this URL instead
 * and the code is resolved here, server-side, at the moment of the tap.
 *
 * Possession of the billId is the auth for a booking, and a signed waiver grant
 * is the auth when there is no booking (the standalone / group-events waiver).
 * Either way the personId must be IN the proven pack, so this cannot be used to
 * look up an arbitrary person's code — see licence-pack.ts.
 *
 * Issues nothing itself: it redirects to the lazy-issue route, which creates the
 * pass only because the racer asked for it.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const personId = (url.searchParams.get("personId") || "").trim();
  const platform = url.searchParams.get("platform");
  // "hub" lands on the racer's page; default is the wallet hop. Both resolve the
  // code here so it never appears in markup the booker can read.
  const to = url.searchParams.get("to");

  const home = () => NextResponse.redirect(new URL("/book/race", req.url));
  if (!/^\d+$/.test(personId)) return home();

  // The personId must be in the pack the caller proved — a booking they hold the
  // billId for, or a waiver they signed. Without this the endpoint would resolve
  // ANY person's login code for anyone who could name them.
  const pack = await resolveLicencePack(url.searchParams);
  if (!pack || !packHas(pack, personId)) return home();

  // Cache first, then Office. The cache is only warmed by the pre-race cron and
  // past lookups, so a racer who simply has not been swept yet is NOT a
  // first-timer — treating a cache miss as "no licence" told a real returning
  // racer she had none (2026-08-05).
  let code = await codeForPersonId(personId).catch(() => null);
  if (!code) {
    const matches = await lookupMemberMatches(personId).catch(() => null);
    code = matches?.[0]?.loginCode || null;
  }
  if (!code) return home();

  const target = new URL(
    to === "hub"
      ? `/r/${encodeURIComponent(code)}`
      : `/r/${encodeURIComponent(code)}/wallet`,
    req.url,
  );
  if (to !== "hub" && (platform === "apple" || platform === "google")) {
    target.searchParams.set("platform", platform);
  }
  return NextResponse.redirect(target, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
