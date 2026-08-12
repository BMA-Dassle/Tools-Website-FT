import "server-only";

/**
 * "58 returning to blue" — one Zello announcement the moment a briefed group's
 * session ends (owner 2026-08-11), riding the same welcome-back signal that
 * flips the room's TV: the timing system's own actualEnd.
 *
 * SAME SERVICE THE KIOSK ASSIST BEACON USES (features/kiosk/assist-alert.ts —
 * bma-soteria-alerts, POST /radio, TTS onto the venue's staff Zello). Payload
 * per the owner: server FT, target "Track Bot", priority 1, cooldown 60. The
 * service dedups by `name` for `cooldown` seconds, but that alone cannot give
 * "once per return" — the welcome-back window stays open until the next send,
 * and two screens poll it every 15 seconds all the while. The once-only is OURS:
 *
 *   Redis SET NX per (room, session) → won the claim → POST → on failure, DEL
 *   the claim so the next poll retries.
 *
 * NX-first (not POST-first) so two screens resolving the same poll tick cannot
 * both fire; the service's 60s name-cooldown backstops the sliver where one
 * fires and the other's NX raced ahead of the SET. A failed POST releases the
 * claim — an announcement that silently never happens is the failure mode staff
 * cannot see, so it retries on the next poll rather than giving up.
 *
 * A 200 does NOT guarantee audio (the service drops jobs if its Zello socket is
 * down through 3 attempts — see assist-alert.ts). Unlike the kiosk beacon there
 * is no repeat loop here, deliberately: the owner asked for ONE announcement,
 * and the TV board carries the same information persistently.
 */
import redis from "@/lib/redis";
import type { BriefingRoom } from "./types";

const RADIO_ALERT_URL = "https://bma-soteria-alerts.azurewebsites.net/radio";

/** Long enough that a welcome-back window held open all evening can never
 *  re-announce; short enough that Redis is not hoarding day-old claims. */
const CLAIM_TTL_SECONDS = 12 * 3600;

export interface ReturnAnnouncement {
  server: string;
  target: string;
  priority: number;
  message: string;
  name: string;
  cooldown: number;
}

/** The payload, pure — exactly the contract the owner supplied. */
export function buildReturnAnnouncement(args: {
  room: BriefingRoom;
  heatNumber: number | null;
}): ReturnAnnouncement {
  return {
    server: "FT",
    target: "Track Bot",
    priority: 1,
    // Spoken text: "58 returning to blue". A heat the record lost the number
    // for still gets announced — a nameless race beats a silent radio.
    message: `${args.heatNumber ?? "Race"} returning to ${args.room}`,
    // Per-room dedupe key on the service side; our Redis claim is per-session,
    // so this only has to break ties between simultaneous polls.
    name: `BriefingReturn-${args.room}`,
    cooldown: 60,
  };
}

/** Announce one group's return, exactly once. Never throws — this rides the
 *  TV feed's read path, and a radio blip must never cost a wall its feed. */
export async function announceReturnOnce(args: {
  room: BriefingRoom;
  sessionId: string;
  heatNumber: number | null;
}): Promise<void> {
  if (!args.sessionId) return;
  const claimKey = `briefing:return-announced:${args.room}:${args.sessionId}`;
  try {
    const claimed = await redis.set(claimKey, String(Date.now()), "EX", CLAIM_TTL_SECONDS, "NX");
    if (claimed !== "OK") return; // someone already announced this return

    const res = await fetch(RADIO_ALERT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildReturnAnnouncement(args)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Release the claim so the next feed poll retries — a silently missing
      // announcement is invisible to staff, so it must not be final.
      await redis.del(claimKey);
    }
  } catch {
    try {
      await redis.del(claimKey);
    } catch {
      /* the claim expires on its own */
    }
  }
}
