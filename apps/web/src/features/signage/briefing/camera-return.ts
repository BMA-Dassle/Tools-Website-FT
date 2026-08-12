/**
 * WHICH POV CAMERAS ARE STILL OUT. PURE — facts in, boxes out.
 *
 * THE PROBLEM THIS EXISTS FOR (owner 2026-08-12): "when a race finishes we would
 * turn those camera numbers RED. They would not turn green till we see them check
 * into one of the systems… otherwise we would have trouble if we put them out to
 * next race."
 *
 * Nothing in any system records a POV camera coming back. The out-side is a staff
 * NFC scan at the grid; the return has only ever been *inferred*, days later, when
 * a video turns up. So a camera left in a kart, handed back dead, or walked out of
 * the door looks exactly like one that came back fine — until the next group is
 * handed it and their race goes unfilmed.
 *
 * THREE FACTS ALREADY EXIST, and this file only decides what they mean together:
 *
 *   WHO WENT OUT      `camera-scan-log:{businessDay}` — the scan staff already do
 *                     (lib/camera-assign.ts). Camera, session, when.
 *   WHETHER IT IS DUE  the venue's own RaceFinish stamp, a Redis marker written
 *                     seconds after the flag (race-finish.server.ts) — the same
 *                     fast path the welcome-back board reads.
 *   WHETHER IT IS BACK `camera-seen:{camera}` — VT3 registering a clip off that
 *                     camera, which can only happen once it has reached a base
 *                     station, plus a staff re-scan onto the next racer.
 *
 * DERIVED, NEVER REMEMBERED — the same doctrine as phase.ts and room-return.ts.
 * There is no camera-status record to get stuck, nothing to reconcile, and a
 * restart or a redeploy loses nothing. The strip is a view of three facts.
 *
 * FOUR RULES IT MUST NOT BREAK:
 *
 *  1. A CAMERA STILL ON TRACK IS NOT A PROBLEM. Only a FINISHED race puts a
 *     camera on this strip (owner: "those that were just returning and those who
 *     returned earlier but still haven't scanned in"). No finish marker ⇒ absent.
 *  2. THE SIGHTING MUST POST-DATE THE FLAG, not the scan. A camera's PREVIOUS
 *     heat's footage can register minutes after this heat's scan — measuring
 *     against `assignedAt` would let that stale upload mark this heat's camera
 *     as returned. Against `endedAtMs` it cannot.
 *  3. ONE BOX PER CAMERA, AND THE OLDEST DEBT WINS. A camera scanned out again
 *     while still unaccounted for from an earlier heat must keep reporting the
 *     earlier heat — that is exactly the case the owner asked to keep visible,
 *     and a newer scan must not quietly reset it.
 *  4. NOTHING MOVES. Boxes are ordered by when the camera went out and hold that
 *     position through a state change, because the wall does not blink and does
 *     not reflow (owner: never blink). A box that jumped left on turning green
 *     would be the motion we just removed.
 */

/**
 * How long a camera holds its green box after we see it, before dropping off.
 *
 * Green is a CONFIRMATION, not a resting state. Without a hold, a returned
 * camera's box would simply vanish between two 15s polls and "we saw it check
 * in" — the half of the owner's sentence the red state cannot express — would
 * never actually appear on the wall.
 */
export const GREEN_HOLD_MS = 90_000;

/**
 * Tolerance on "the sighting came after the flag".
 *
 * The end stamp is the venue timing server's clock and the registration time is
 * VT3's; a minute of skew between two vendors' clocks must not strand a camera
 * that plainly came back. Sized well under the ~2 minute median return so it
 * cannot swallow a real miss.
 */
export const SEEN_SKEW_MS = 60_000;

/** One scan, as it comes out of `camera-scan-log:{businessDay}`. */
export interface CameraScan {
  /** The scanned camera number, as text — the field is `sys` on the wire for
   *  historical reasons (lib/camera-assign.ts calls it systemNumber). */
  camera: string;
  /** Pandora session id. TEXT: BMI's id space exceeds Number.MAX_SAFE_INTEGER. */
  sessionId: string;
  /** When staff scanned this camera onto a racer, ms. */
  assignedAtMs: number;
}

/** What we know about a session's end — `null` entry means "not finished". */
export interface SessionFinish {
  endedAtMs: number;
  heatNumber: number | null;
}

export interface CameraReturnInput {
  /** Today's scans, any order. */
  scans: CameraScan[];
  /** sessionId → finish, for the sessions that have finished. */
  finishes: Map<string, SessionFinish>;
  /** camera → last sighting ms. */
  seen: Map<string, number>;
  nowMs: number;
}

export type CameraBoxState =
  /** Race finished, no sighting since. Solid red. */
  | "out"
  /** Seen since the flag, inside the green hold. */
  | "back";

export interface CameraBox {
  camera: string;
  state: CameraBoxState;
  /** Heat this camera went out on — what staff would say out loud. */
  heatNumber: number | null;
  /** How long since the flag, ms. What the box prints under the number. */
  sinceFlagMs: number;
  /** Ordering key: when the camera went out. Kept so the caller can prove
   *  position stability in a test rather than trusting the sort. */
  assignedAtMs: number;
}

export interface CameraReturnStrip {
  /** Ordered oldest-out first. Empty when everything is accounted for. */
  boxes: CameraBox[];
  /** How many are genuinely unaccounted for — the number the strip prints.
   *  NOT `boxes.length`, which also counts the green ones still holding. */
  outCount: number;
}

/**
 * Turn the three facts into the strip.
 *
 * ORDER OF BUSINESS matters: resolve the oldest unresolved debt per camera
 * FIRST (rule 3), and only then ask whether that debt has been settled. Doing it
 * the other way round — picking the newest scan and then testing it — is how a
 * camera missing since heat 20 disappears the moment it is scanned onto heat 30.
 */
export function cameraReturnStripAt(input: CameraReturnInput): CameraReturnStrip {
  const { scans, finishes, seen, nowMs } = input;

  /** Per camera, the oldest scan whose race has finished and which is still
   *  unresolved — or, if all are resolved, the newest resolved one (so it can
   *  show its green hold). */
  const oldestOpen = new Map<string, { scan: CameraScan; finish: SessionFinish }>();
  const newestDone = new Map<
    string,
    { scan: CameraScan; finish: SessionFinish; seenAtMs: number }
  >();

  for (const scan of scans) {
    if (!scan.camera || !Number.isFinite(scan.assignedAtMs)) continue;
    const finish = finishes.get(scan.sessionId);
    // Rule 1 — still on track, or the bridge never told us it finished. Either
    // way there is nothing to chase, so the camera is not on the strip.
    if (!finish || !Number.isFinite(finish.endedAtMs)) continue;

    const seenAtMs = seen.get(scan.camera);
    // Rule 2 — the sighting has to post-date THIS race's flag.
    const settled = seenAtMs != null && seenAtMs >= finish.endedAtMs - SEEN_SKEW_MS;

    if (settled) {
      const prev = newestDone.get(scan.camera);
      if (!prev || scan.assignedAtMs > prev.scan.assignedAtMs) {
        newestDone.set(scan.camera, { scan, finish, seenAtMs: seenAtMs! });
      }
      continue;
    }

    const prev = oldestOpen.get(scan.camera);
    if (!prev || scan.assignedAtMs < prev.scan.assignedAtMs) {
      oldestOpen.set(scan.camera, { scan, finish });
    }
  }

  const boxes: CameraBox[] = [];

  for (const [camera, { scan, finish }] of oldestOpen) {
    boxes.push({
      camera,
      state: "out",
      heatNumber: finish.heatNumber,
      sinceFlagMs: Math.max(0, nowMs - finish.endedAtMs),
      assignedAtMs: scan.assignedAtMs,
    });
  }

  for (const [camera, { scan, finish, seenAtMs }] of newestDone) {
    // An open debt on the same camera outranks a settled one — the camera is
    // still missing from an earlier heat even though a later clip registered.
    if (oldestOpen.has(camera)) continue;
    if (nowMs - seenAtMs > GREEN_HOLD_MS) continue;
    boxes.push({
      camera,
      state: "back",
      heatNumber: finish.heatNumber,
      sinceFlagMs: Math.max(0, nowMs - finish.endedAtMs),
      assignedAtMs: scan.assignedAtMs,
    });
  }

  // Rule 4 — position is a function of when the camera went out, never of
  // state, so a box does not move when it turns green. Camera number breaks
  // ties so two cameras scanned in the same millisecond still order stably.
  boxes.sort((a, b) => a.assignedAtMs - b.assignedAtMs || Number(a.camera) - Number(b.camera));

  return { boxes, outCount: boxes.filter((b) => b.state === "out").length };
}

/**
 * "18 min" / "2 min" / "just now" — what a red box prints under its number.
 *
 * With blinking ruled out this figure is the ONLY urgency signal on the strip,
 * so it counts from the chequered flag and not from when anyone last looked.
 * Whole minutes: seconds ticking on a wall board is motion, and nobody chases a
 * camera to the second.
 */
export function formatSinceFlag(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
