import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { codeForPersonId, warmRacerCodes } from "~/features/kiosk/license/code-cache";
import { resolveLicencePack } from "~/features/racing/service/licence-pack";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API_KEY = process.env.BOOKING_API_KEY || "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";

/** Same posture as /api/booking-record: same-origin calls pass, external needs the key. */
function requireAuth(req: NextRequest): NextResponse | null {
  const referer = req.headers.get("referer") || "";
  const origin = req.headers.get("origin") || "";
  const host = req.headers.get("host") || "";
  if (host && (referer.includes(host) || origin.includes(host))) return null;
  const key = req.headers.get("x-api-key") || new URL(req.url).searchParams.get("apiKey");
  if (!key || key !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

interface OfferRacer {
  personId: string;
  name: string;
  /** QR image for `/r/{code}/wallet`, or null when this racer has no BMI tag. */
  qr: string | null;
  /** True for the person who made the booking — the phone this page is open on. */
  isYou: boolean;
  /** Server-resolved hop for a DIRECT add. On a phone you cannot scan your own
   *  screen, so your own row needs a link rather than a QR. Carries no login
   *  code — the code is resolved behind this URL at the moment of the tap. */
  addUrl: string | null;
  /** Same trick, landing on the racer's permanent page at /r/{code}. Keeps every
   *  other racer's login code out of markup the booker can read. */
  hubUrl: string | null;
}

/**
 * GET /api/racing/licence-offer?billId=… — who on this booking can hold a racing
 * licence, and the QR each of them scans to get it.
 *
 * THE LOGIN CODE NEVER LEAVES THE SERVER AS TEXT. A code is the racer's identity
 * at the kiosk, the check-in desk and the BMI register, so handing the whole
 * party's codes to whoever opened the confirmation page would let the booker
 * sign in as any of them. The QR is rendered here and only the image is
 * returned — the code exists solely inside a bitmap the racer scans with their
 * own phone.
 *
 * NOTHING IS ISSUED HERE. This endpoint reads; the pass is created only when a
 * racer actually scans and `/r/{code}/wallet` runs on their device (owner rule
 * 2026-08-05: "don't build it till they scan"). A party of four viewing this
 * page costs nothing until they each opt in.
 *
 * The QR points at THIS deployment's origin, so a preview build hands out
 * preview links instead of silently sending a tester to production.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = requireAuth(req);
  if (denied) return denied;

  // EITHER a booking (`billId`) or signed waiver grants (`g`) — see
  // licence-pack.ts. A request that proves neither gets an empty answer, never
  // a lookup.
  const pack = await resolveLicencePack(new URL(req.url).searchParams);
  if (!pack) {
    return NextResponse.json(
      { racers: [], isRacing: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const origin = req.nextUrl.origin;
  const primary = pack.primaryPersonId ?? "";

  // WARM THE CACHE FIRST, then read it.
  //
  // `codeForPersonId` reads our own table, which is only populated by the
  // pre-race cron and past lookups — so a returning racer who simply has not
  // been swept yet has no row, and reading the cache alone reported her as a
  // first-timer with no licence (real, 2026-08-05). Warming here asks BMI for
  // the tags we are missing before answering.
  //
  // Cheap and self-limiting: `warmRacerCodes` skips anyone read in the last 30
  // days, so a repeat view of the same confirmation costs nothing, and the rows
  // it writes also serve the check-in desk and the kiosk later.
  const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
  await warmRacerCodes(
    CLIENT_KEY,
    pack.members.map((m) => m.personId),
  ).catch(() => undefined);

  // The pack is already one row per person — see licence-pack.ts.
  const out: OfferRacer[] = [];
  for (const r of pack.members) {
    const personId = r.personId;

    const code = await codeForPersonId(personId).catch(() => null);
    let qr: string | null = null;
    if (code) {
      qr = await QRCode.toDataURL(`${origin}/r/${code}/wallet`, {
        width: 320,
        margin: 1,
        color: { dark: "#04252b", light: "#ffffff" },
      }).catch(() => null);
    }
    out.push({
      personId,
      name: String(r?.racerName || "").trim() || "Racer",
      qr,
      isYou: !!primary && personId === primary,
      addUrl: code
        ? `/api/racing/licence-offer/add?${pack.query}&personId=${encodeURIComponent(personId)}`
        : null,
      hubUrl: code
        ? `/api/racing/licence-offer/add?${pack.query}&personId=${encodeURIComponent(personId)}&to=hub`
        : null,
    });
  }

  // `racers[]` on a booking record IS the race-participant list, so its presence
  // answers "is this a racing booking" without a sessionStorage flag that dies
  // on a kiosk reset. A waiver pack says nothing about racing — the guest may
  // have signed for laser tag — so the flag stays FALSE there and the surfaces
  // that key off it (the express-lane banner) are unaffected.
  return NextResponse.json(
    { racers: out, isRacing: pack.source === "booking" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
