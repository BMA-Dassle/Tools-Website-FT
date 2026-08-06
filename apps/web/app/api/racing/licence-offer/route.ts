import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import redis from "@/lib/redis";
import { codeForPersonId, warmRacerCodes } from "~/features/kiosk/license/code-cache";

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

  const billId = (new URL(req.url).searchParams.get("billId") || "").trim();
  if (!/^\d+$/.test(billId)) {
    return NextResponse.json({ error: "billId required" }, { status: 400 });
  }

  let record: {
    primaryPersonId?: string;
    racers?: Array<{ racerName?: string; personId?: string | null }>;
  } | null = null;
  try {
    const raw = await redis.get(`bookingrecord:${billId}`);
    record = raw ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  if (!record?.racers?.length) {
    return NextResponse.json({ racers: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const origin = req.nextUrl.origin;
  const primary = String(record.primaryPersonId ?? "").trim();

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
  const personIds = record.racers
    .map((r) => String(r?.personId ?? "").trim())
    .filter((p) => /^\d+$/.test(p));
  await warmRacerCodes(CLIENT_KEY, personIds).catch(() => undefined);

  // One row per PERSON. A racer booked into two heats appears twice in
  // `racers[]` and must not be offered two licences — there is only one of them.
  const seen = new Set<string>();
  const out: OfferRacer[] = [];
  for (const r of record.racers) {
    const personId = String(r?.personId ?? "").trim();
    if (!/^\d+$/.test(personId) || seen.has(personId)) continue;
    seen.add(personId);

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
        ? `/api/racing/licence-offer/add?billId=${encodeURIComponent(billId)}&personId=${encodeURIComponent(personId)}`
        : null,
    });
  }

  return NextResponse.json({ racers: out }, { headers: { "Cache-Control": "no-store" } });
}
