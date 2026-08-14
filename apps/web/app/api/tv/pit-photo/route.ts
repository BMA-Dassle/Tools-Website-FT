import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { parseWithRawIds } from "@ft/db";
import redis from "@/lib/redis";
import { sessionRoster } from "~/features/signage/service/checkin-progress";

/**
 * A racer's photo, for the pit assignment boards.
 *
 * ITS OWN FETCH PATH, deliberately: the event rail and the pulse are polled
 * every two seconds by every screen in the building, and base64 portraits
 * would bloat both badly (the note ActionStrip has carried since 2026-08-11).
 * The board's <img> tags hit this route instead, and the browser's own cache
 * plus the Redis layer below mean a face is fetched from BMI about once a day.
 *
 * PUBLIC LIKE THE FEED, BOUNDED LIKE THE FEED (/api/tv/feed's posture:
 * "identity by registration, content deliberately bounded"). No token — a
 * wall TV has none to give — but the route only ever serves a person who is
 * ON THE REQUESTED SESSION'S ROSTER, verified server-side per request. What
 * it can leak is therefore exactly what the wall it feeds is already showing
 * to everyone at the pit fence: the faces of the group racing next.
 *
 * PII: the photo is the kiosk waiver webcam shot, stored in BMI per personId
 * and shown on the vendor AssignmentTV for years — owner decision 2026-08-13
 * keeps that posture on the replacement board.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";

/**
 * THE FACE COMES FROM SMS-TIMING'S OWN IMAGE ENDPOINT, not from Pandora.
 *
 * WHY (owner 2026-08-14: "pictures seem to be failing often… can you see how
 * long they take to grab locally through pandora?"). Measured, n=14, against
 * `bmi/person/{loc}/{id}?picture=true`:
 *
 *     min 3.2s · p50 4.7s · p90 6.1s · max 15s (timed out)
 *
 * against a 6-second route timeout. Worse, the timeout fell hardest on the
 * requests that MATTERED: the ones carrying an actual photo were the slow ones
 * (5.6s, 6.1s, 6.9s) because the picture rides back as 15-80KB of base64 inside
 * the JSON, while "this person has no photo" answered in 3-4s. So the successful
 * fetches were the ones being cut, which is exactly why the board filled with
 * silhouettes.
 *
 * The owner then captured a HAR of BMI Office loading a person, which showed
 * their own app never asks Pandora for the picture at all — it hits this:
 *
 *     min 64ms · p50 81ms · 404 in ~330ms when there is no photo
 *
 * Same photo, byte for byte (61,793 bytes for the person in the capture), as
 * raw `image/jpg` rather than base64 in JSON, with `cache-control: public,
 * max-age=3600`. Roughly fifty times faster, and the negative is fast too.
 *
 * `kind=0` is the person photo (owner). `kind=5` returns a PNG — a different
 * asset, not this one.
 *
 * NO CREDENTIAL IS SENT, and that is not an oversight: verified from this
 * codebase with no Authorization header and no cookie, returning 200 and valid
 * JPEG bytes. It is loaded by an ordinary `<img>` in their app (`sec-fetch-dest:
 * image`, `no-cors`) and answers publicly by personId. The other office
 * endpoints in that same capture — search, person, waivers — DO carry auth;
 * this one does not. Nothing here widens what we expose: the route below still
 * serves a face only to a caller naming a session that person is rostered on.
 *
 * `headpinzftmyers` is the shared BMI client key, the same namespace the timing
 * socket uses — see signage/constants.ts CENTER NAMESPACE TRAP.
 */
const OFFICE_IMAGE_URL = "https://office-api22.sms-timing.com/api/headpinzftmyers/image/picture";
/** Generous next to an 81ms p50 — it exists for a bad network, not a slow API. */
const OFFICE_TIMEOUT_MS = 8_000;

/** A face changes when the guest re-registers — rarely. A day is plenty, and
 *  it means a full evening of 15s polls costs one BMI read per racer. */
const PHOTO_TTL_SECONDS = 12 * 3600;
/** Negative answers are cached shorter: a guest photographed at the kiosk
 *  MID-VISIT should appear on the wall within the hour, not tomorrow. */
const NO_PHOTO_TTL_SECONDS = 3600;

function photoKey(personId: string): string {
  return `pit:photo:${personId}`;
}

/** The person's photo as base64, or null for "no photo on file".
 *  Redis first, then SMS-Timing, then Pandora only if that fails oddly. */
async function loadPhoto(personId: string): Promise<string | null> {
  try {
    const cached = await redis.get(photoKey(personId));
    if (cached === "") return null;
    if (cached) return cached;
  } catch {
    /* fall through to the live read */
  }

  let pic: string | null = null;
  /** True only when the source positively said "there is no photo", which is
   *  worth caching for an hour. A transport failure is NOT that, and must not
   *  be remembered as one. */
  let definitive = false;

  try {
    const res = await fetch(`${OFFICE_IMAGE_URL}?personId=${encodeURIComponent(personId)}&kind=0`, {
      // No credential — see the note on OFFICE_IMAGE_URL.
      headers: { Accept: "image/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(OFFICE_TIMEOUT_MS),
    });
    if (res.status === 404) {
      definitive = true;
    } else if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      // A zero-length 200 is not a photo. Treated as "none" rather than cached
      // as a broken image the board would render as a grey box.
      if (buf.length > 0) pic = buf.toString("base64");
      else definitive = true;
    }
  } catch {
    /* fall through to Pandora */
  }

  /**
   * PANDORA IS THE FALLBACK NOW, not the source. It is fifty times slower and
   * this path only runs when the fast one failed in a way that was not a clean
   * "no photo" — a network blip, or the endpoint going away. Keeping it means
   * losing SMS-Timing costs the boards latency rather than every face.
   */
  if (pic === null && !definitive && PANDORA_KEY) {
    try {
      const res = await fetch(
        `${PANDORA_BASE}/bmi/person/${FASTTRAX_LOCATION_ID}/${personId}?picture=true`,
        {
          headers: { Authorization: `Bearer ${PANDORA_KEY}`, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(6000),
        },
      );
      if (res.ok) {
        // parseWithRawIds, never res.json(): the payload carries the 17-digit
        // personId (house rule — no response carrying a BMI id goes through the
        // standard parser, even when this caller only wants the picture).
        const json = parseWithRawIds<{ data?: { pic?: string | null } }>(await res.text());
        const raw = json?.data?.pic;
        pic = typeof raw === "string" && raw.length > 0 ? raw : null;
        definitive = true;
      }
    } catch {
      // A failed read is NOT cached as "no photo" — the next poll may succeed.
      return null;
    }
  }

  // Only cache an answer we trust: a photo, or a source that said there is none.
  if (pic === null && !definitive) return null;

  try {
    await redis.set(
      photoKey(personId),
      pic ?? "",
      "EX",
      pic ? PHOTO_TTL_SECONDS : NO_PHOTO_TTL_SECONDS,
    );
  } catch {
    /* cache is an optimization, never a requirement */
  }
  return pic;
}

export async function GET(req: NextRequest) {
  const sessionId = (req.nextUrl.searchParams.get("session") ?? "").trim();
  const personId = (req.nextUrl.searchParams.get("person") ?? "").trim();
  if (!/^\d+$/.test(sessionId) || !/^\d+$/.test(personId)) {
    return NextResponse.json({ error: "session and person required" }, { status: 400 });
  }

  // THE BOUND: only faces on this session's roster are served. The roster
  // read is the same memoised one the feed uses, so a wall of <img> tags
  // costs one roster read per poll interval, not one per face.
  const roster = await sessionRoster(sessionId, Date.now()).catch(() => null);
  const onRoster = (roster ?? []).some(
    (row) => String((row as { personId?: string | number | null }).personId ?? "") === personId,
  );
  if (!onRoster) return new NextResponse(null, { status: 404 });

  const pic = await loadPhoto(personId);
  if (!pic) return new NextResponse(null, { status: 404 });

  let bytes: Buffer;
  try {
    bytes = Buffer.from(pic, "base64");
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/jpeg",
      // The browser holds a face for an hour; a re-registered photo shows on
      // the next board reload, and the Redis TTL above bounds the true age.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
