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

/** A face changes when the guest re-registers — rarely. A day is plenty, and
 *  it means a full evening of 15s polls costs one BMI read per racer. */
const PHOTO_TTL_SECONDS = 12 * 3600;
/** Negative answers are cached shorter: a guest photographed at the kiosk
 *  MID-VISIT should appear on the wall within the hour, not tomorrow. */
const NO_PHOTO_TTL_SECONDS = 3600;

function photoKey(personId: string): string {
  return `pit:photo:${personId}`;
}

/** The person's BMI picture, base64 — Redis first, Pandora on a miss.
 *  Returns null for "no photo" (also cached, so BMI is not re-asked per poll). */
async function loadPhoto(personId: string): Promise<string | null> {
  try {
    const cached = await redis.get(photoKey(personId));
    if (cached === "") return null;
    if (cached) return cached;
  } catch {
    /* fall through to the live read */
  }

  if (!PANDORA_KEY) return null;
  let pic: string | null = null;
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${FASTTRAX_LOCATION_ID}/${personId}?picture=true`,
      {
        headers: { Authorization: `Bearer ${PANDORA_KEY}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!res.ok) return null;
    // parseWithRawIds, never res.json(): the payload carries the 17-digit
    // personId (house rule — no response carrying a BMI id goes through the
    // standard parser, even when this caller only wants the picture).
    const json = parseWithRawIds<{ data?: { pic?: string | null } }>(await res.text());
    const raw = json?.data?.pic;
    pic = typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    // A failed read is NOT cached as "no photo" — the next poll may succeed.
    return null;
  }

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
