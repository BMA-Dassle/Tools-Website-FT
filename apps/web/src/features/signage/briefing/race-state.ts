/**
 * IS THIS TRACK RUNNING, PAUSED, OR DONE? PURE — parsing and transitions only.
 *
 * WHY THIS EXISTS SEPARATELY FROM results-frame.ts. That parser answers "who
 * finished where" and deliberately returns null for a frame with no drivers,
 * because a capture with nothing to record must look like no capture. This one
 * answers "what is the track doing", where a driverless frame is still a real
 * answer and throwing it away would read as "the race vanished" — which, on a
 * transition watcher, would fabricate a pause.
 *
 * THE STATE FIELD is the same `S` live-session.tsx and results-frame.ts read:
 * 1 running · 2 paused · >=3 finished. Pause is the only one of the four race
 * events the venue broadcast does NOT carry — RaceStart and RaceFinish arrive
 * on the webhook within seconds, but a marshal hitting pause for a spun kart
 * shows up nowhere except this socket field.
 */

/** 1 running · 2 paused · >=3 finished. */
export type RaceRunState = "running" | "paused" | "finished" | "none";

export interface RaceStateFrame {
  /** Heat number parsed from the frame name, e.g. 66 from "[HEAT] 66 - Mega Pro". */
  heatNumber: number | null;
  /** The frame's name, [HEAT] marker humanised — matches results-frame's reading. */
  heatName: string;
  state: RaceRunState;
}

function readState(s: unknown): RaceRunState {
  const n = typeof s === "number" ? s : Number(s);
  if (!Number.isFinite(n)) return "none";
  if (n === 1) return "running";
  if (n === 2) return "paused";
  if (n >= 3) return "finished";
  return "none";
}

/** Heat number out of "[HEAT] 66 - Mega Pro" / "66 - Blue Starter". */
export function heatNumberFromName(name: string): number | null {
  const m = name.match(/(\d+)\s*-/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read a socket frame for what the track is doing.
 *
 * `"{}"` is the timing system's "no race loaded" and returns state `none` — a
 * real answer, distinct from null, which here means "the frame was unreadable".
 * The watcher must be able to tell those apart: an empty track is a legitimate
 * end of a session's state history, an unreadable one must change nothing.
 */
export function parseRaceStateFrame(raw: unknown): RaceStateFrame | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw === "{}") return { heatNumber: null, heatName: "", state: "none" };
  try {
    const data = JSON.parse(raw) as { N?: unknown; S?: unknown };
    const rawName = typeof data.N === "string" ? data.N : "";
    const heatName = rawName.replace(/^\[HEAT\]\s*/i, "").trim();
    return {
      heatNumber: heatNumberFromName(rawName),
      heatName,
      state: readState(data.S),
    };
  } catch {
    return null;
  }
}

/** What the watcher last saw for a track. */
export interface RaceStateMemory {
  heatNumber: number | null;
  state: RaceRunState;
}

export type RaceTransition = "paused" | "resumed" | null;

/**
 * Did the track just pause or resume?
 *
 * ONLY WITHIN ONE HEAT. A transition is only meaningful when both samples are
 * the same race: heat 42 finishing and heat 43 loading in a paused state is not
 * a pause of anything, and marking it would put a "session paused" bookmark on
 * every camera at the start of a race that never paused. When the heat changes,
 * the memory is replaced and no transition is reported.
 *
 * Anything involving `none` or `finished` is likewise not a pause. A race that
 * ends is an END, and it has its own event arriving on the webhook with the
 * venue's own stamp — far better than this sampler's.
 */
export function raceStateTransition(
  prev: RaceStateMemory | null,
  next: RaceStateFrame,
): RaceTransition {
  if (!prev) return null;
  if (prev.heatNumber !== next.heatNumber) return null;
  if (next.heatNumber === null) return null;
  if (prev.state === "running" && next.state === "paused") return "paused";
  if (prev.state === "paused" && next.state === "running") return "resumed";
  return null;
}
