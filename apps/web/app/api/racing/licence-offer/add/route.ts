import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { codeForPersonId } from "~/features/kiosk/license/code-cache";
import { lookupMemberMatches } from "~/features/kiosk/license/lookup.server";

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
 * Possession of the billId is the auth, the same bar the confirmation page
 * itself applies — and the personId must actually be ON that booking, so this
 * cannot be used to look up an arbitrary person's code.
 *
 * Issues nothing itself: it redirects to the lazy-issue route, which creates the
 * pass only because the racer asked for it.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const billId = (url.searchParams.get("billId") || "").trim();
  const personId = (url.searchParams.get("personId") || "").trim();
  const platform = url.searchParams.get("platform");
  // "hub" lands on the racer's page; default is the wallet hop. Both resolve the
  // code here so it never appears in markup the booker can read.
  const to = url.searchParams.get("to");

  const home = () => NextResponse.redirect(new URL("/book/race", req.url));
  if (!/^\d+$/.test(billId) || !/^\d+$/.test(personId)) return home();

  // The personId must be on THIS booking — otherwise the endpoint would resolve
  // any person's code for anyone holding any billId.
  let onBooking = false;
  try {
    const raw = await redis.get(`bookingrecord:${billId}`);
    const rec = raw ? (JSON.parse(raw) as { racers?: Array<{ personId?: string | null }> }) : null;
    onBooking = !!rec?.racers?.some((r) => String(r?.personId ?? "").trim() === personId);
  } catch {
    onBooking = false;
  }
  if (!onBooking) return home();

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
