import "server-only";

/**
 * Everything the driver view needs for one kart, in one answer.
 *
 * The route is a thin shell over this so a kiosk screen, an ops view or a
 * kart-mounted unit can consume the same thing without going through HTTP.
 *
 * WHAT IT DOES NOT DO: the live position, the running clock and the standings
 * come from the SMS-Timing cloud socket, which the BROWSER opens directly —
 * `wss://webserver22.sms-timing.com:10015`, the same handshake /leaderboards
 * uses. Nothing server-side should ever open that socket: a probe connection
 * displaces the live subscribers and takes the boards down mid-race. This
 * function answers the half the socket cannot — flags, incidents, lap history,
 * and who is in the kart.
 */
import { readBinding } from "./binding";
import { readFeed } from "./ingest.server";
import { numberLaps } from "./laps";
import { isMuted } from "./muted";
import { currentTakeover } from "./standing";
import { readSessionLaps } from "./store.server";
import type { DriverViewState, KartNumber } from "./types";

/**
 * A kart number is one to three digits as the venue prints it. Anything else is
 * a typo or a probe, and is refused rather than becoming a Redis key.
 */
export function normaliseKart(raw: string): KartNumber | null {
  const trimmed = String(raw ?? "").trim();
  return /^\d{1,3}$/.test(trimmed) ? String(Number(trimmed)) : null;
}

export async function readDriverView(
  kart: KartNumber,
  nowMs = Date.now(),
): Promise<DriverViewState> {
  const [binding, rawAlerts] = await Promise.all([readBinding(kart), readFeed(kart)]);

  // Muted kinds are dropped HERE, not just where they would be drawn. The
  // render path filters too, but a live feed keeps entries for six hours, so
  // without this the API would keep handing out cautions written before the
  // mute — invisible today, and resurfacing the moment any new consumer reads
  // `alerts` directly. Muted means it does not leave the server. See muted.ts.
  const alerts = rawAlerts.filter((a) => !isMuted(a.kind));

  // Laps come from Neon, not the feed: the feed is 50 entries and six hours, and
  // a driver reviewing their heat wants every crossing, including the ones from
  // before this screen was opened.
  const lapRows = binding?.sessionId ? await readSessionLaps(binding.sessionId, kart) : [];

  return {
    kart,
    binding,
    laps: numberLaps(lapRows),
    alerts,
    takeover: currentTakeover(alerts, nowMs),
  };
}
