import { NextRequest, NextResponse } from "next/server";
import { getRaceTicket } from "@/lib/race-tickets";
import { walletPlatformFromUserAgent } from "~/features/game-cards/wallet/platform";
import { codeForPersonId } from "~/features/kiosk/license/code-cache";
import { issueLicencePass } from "~/features/racing/wallet/licence-pass";
import { buildLicenceMeta } from "~/features/racing/wallet/licence-meta";
import { lookupMemberMatches } from "~/features/kiosk/license/lookup.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /t/{id}/wallet — add the FastTrax Racing Licence from an e-ticket.
 *
 * The best surface we have: the racer already opened this page ON THEIR PHONE,
 * before their heat, and the ticket tells us exactly who they are.
 *
 * KEYED ON THE TICKET, NOT THE CODE. A ticket carries a personId and no login
 * code, and `/r/{code}/wallet` needs a code — but putting a personId in a URL
 * would be enumerable and PII-ish. Possession of the ticket id is already the
 * auth model for /t/{id}, so this hop inherits it and exposes nothing new.
 *
 * ISSUED LAZILY, ON THE TAP. A member record bills EVERY MONTH it exists, so
 * pre-issuing to everyone with a ticket would bill us forever for people who
 * came once. A racer who taps is self-selecting as one who comes back — which is
 * exactly the ~3-visits-a-year break-even the economics need.
 *
 * Idempotent: externalId is the personId and a duplicate answers 409, so a
 * double-tap recovers the existing pass rather than minting a second billed one.
 *
 * Every failure lands back on the ticket, which is the page they were reading.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const back = () => NextResponse.redirect(new URL(`/t/${encodeURIComponent(id)}`, req.url));

  const ticket = await getRaceTicket(id).catch(() => null);
  if (!ticket) return back();

  const personId = String(ticket.personId ?? "").trim();
  if (!/^\d+$/.test(personId)) return back();

  // The printed code. Normally a cache hit — `pre-race-tickets` pre-warms every
  // racer with an upcoming heat, which is precisely who holds a live e-ticket.
  let code = await codeForPersonId(personId);
  if (!code) {
    // Cold cache (a walk-in the cron never ticketed). One Office round trip
    // rather than refusing a racer standing in front of us.
    const matches = await lookupMemberMatches(personId).catch(() => null);
    code = matches?.[0]?.loginCode || null;
  }
  // No tag yet — a brand-new racer. Nothing to put in the barcode, so there is
  // no pass worth issuing; the button should not have rendered.
  if (!code) return back();

  // The Office record for tier/races. Best-effort: a degraded person subsystem
  // (four hours of it on 2026-08-03) must not deny a racer their pass, it just
  // costs two fields the cron cannot refill.
  const match = (await lookupMemberMatches(code).catch(() => null))?.[0] ?? null;

  // FULL metaData. The template binds eleven fields and an absent key renders
  // as a blank on the pass, so this is assembled in one place for both issue
  // routes. The heat comes free from the ticket we already loaded, which means
  // an e-ticket-issued pass shows the right race immediately rather than
  // waiting for the next cron sweep.
  const meta = await buildLicenceMeta({
    personId,
    code,
    fullName: `${ticket.firstName ?? ""} ${ticket.lastName ?? ""}`,
    races: match?.races,
    memberships: match?.memberships,
    heat: {
      scheduledStart: String(ticket.scheduledStart ?? ""),
      track: String(ticket.track ?? ""),
      heatNumber: ticket.heatNumber,
    },
  });

  const result = await issueLicencePass({ personId, meta });
  if (!result.ok || !result.urls) return back();

  // `?platform=` wins over sniffing: a racer tapping the Google badge on an
  // iPhone means it, and overruling them hands over the wrong file.
  const stated = req.nextUrl.searchParams.get("platform");
  const platform =
    stated === "apple" || stated === "google"
      ? stated
      : walletPlatformFromUserAgent(req.headers.get("user-agent"));

  return NextResponse.redirect(
    platform === "apple"
      ? result.urls.apple
      : platform === "google"
        ? result.urls.google
        : result.urls.landing,
    // Pass content changes as their next race does — never cache this hop.
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
