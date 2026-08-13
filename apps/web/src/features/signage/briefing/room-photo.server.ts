import "server-only";

/**
 * A CAMERA STILL OF THE ROOM, TAKEN AS THE FILM STARTS.
 *
 * WHY (owner 2026-08-12): "we have logging of whatever they do on this app, I'd
 * like to grab screenshots of that room's camera as well… at the start of the
 * briefing video only, to save storage on blob." The event log already answers
 * *was this group briefed, which film, how long were they in the room* — this
 * answers the question the log cannot: **were they actually in there watching it.**
 * A row saying the film rolled is a record of a button press; a picture of eleven
 * people sitting in front of the screen is a record of the briefing.
 *
 * ONE PICTURE PER BRIEFING, and that is a storage decision, not an oversight. Not
 * on restart (the group is already in there and already photographed), not on a
 * timer, not a clip. At ~25KB a still and a few hundred briefings a week, a season
 * costs less than one uploaded film.
 *
 * BEST EFFORT, ALWAYS. Nothing in here may fail a start: the safety film rolling
 * on time is the thing that matters, and the photo is evidence we generate for
 * ourselves. Every failure path returns null, and the log simply has no `photo`
 * row for that briefing — which is itself readable ("no picture" is a fact, and a
 * silent half-written record would be worse). This is the ONE place the
 * persist-at-capture rule does not apply, because there is no guest-provided data
 * here to lose: the source is a camera we can always look at again.
 *
 * PRIVACY POSTURE. This is a photograph of guests, minors included, so:
 *   • it is written with an UNGUESSABLE path (addRandomSuffix) — Vercel Blob has
 *     no private mode, and an enumerable URL would be a public gallery of our
 *     customers;
 *   • the URL is only ever returned to /admin surfaces, which are token-gated and
 *     excluded from session replay (CLAUDE.md);
 *   • the file itself carries no names — it is keyed by session, exactly like the
 *     rest of this table's posture.
 */
import { put } from "@vercel/blob";
import { briefingRoomCameraId, fetchCameraFrame, nxConfigured } from "../nx/camera.server";
import type { BriefingRoom } from "./types";

/**
 * How long the capture gets before the start moves on without it.
 *
 * The relay answers a still in a few hundred ms when it is healthy. This bound is
 * for when it is not: a camera that has dropped off must never leave a staff
 * member watching a spinner on a button whose job was already done.
 */
const CAPTURE_TIMEOUT_MS = 6_000;

/**
 * Wide enough to see who is in the room, small enough to store thousands of.
 * 1280 is roughly 25-40KB of JPEG off these cameras — the same frame the
 * full-screen viewer shows, not the 640 thumbnail.
 */
const CAPTURE_WIDTH = 1280;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

export interface RoomPhoto {
  url: string;
  takenAtMs: number;
}

/**
 * Grab and store one frame of a briefing room. Null if anything at all goes wrong.
 *
 * `businessDay` and `sessionId` only shape the path, so a human going looking for
 * "the red room on 12 August" can find it without a database. sessionId stays a
 * STRING throughout (house rule — BMI/Pandora ids exceed Number.MAX_SAFE_INTEGER).
 */
export async function captureRoomPhoto(args: {
  room: BriefingRoom;
  businessDay: string;
  sessionId: string;
  heatNumber: number | null;
}): Promise<RoomPhoto | null> {
  if (!nxConfigured() || !process.env.BLOB_READ_WRITE_TOKEN) return null;
  const deviceId = briefingRoomCameraId(args.room);
  if (!deviceId) return null;

  try {
    const frame = await withTimeout(
      fetchCameraFrame(deviceId, { width: CAPTURE_WIDTH }),
      CAPTURE_TIMEOUT_MS,
      "camera frame",
    );
    const takenAtMs = Date.now();
    const heat = args.heatNumber != null ? `heat-${args.heatNumber}` : "heat-unknown";
    const blob = await withTimeout(
      put(
        `briefing-rooms/${args.businessDay}/${args.room}-${heat}-${args.sessionId}.jpg`,
        Buffer.from(frame.body),
        {
          access: "public",
          contentType: frame.contentType || "image/jpeg",
          // UNGUESSABLE, not tidy — see the privacy note in the header. It also
          // means a re-send that reuses a room cannot overwrite the first group's
          // picture, which an append-only log would otherwise be pointing at.
          addRandomSuffix: true,
        },
      ),
      CAPTURE_TIMEOUT_MS,
      "blob upload",
    );
    return { url: blob.url, takenAtMs };
  } catch (err) {
    // Loud in the logs, invisible to the desk: the start already succeeded.
    console.error("[briefing-photo] capture failed", err);
    return null;
  }
}
