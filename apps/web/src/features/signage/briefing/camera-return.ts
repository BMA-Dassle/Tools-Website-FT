/**
 * WHICH POV CAMERAS ARE STILL OUT. PURE — facts in, two sections out.
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
 * ── TWO SECTIONS, AND THE NEXT RACE BEING CALLED IS WHAT MOVES A CAMERA ──
 *
 * The first cut had one row of red and green boxes, and green did not read: the
 * owner watched six of them on a wall and asked what they meant. It also leaned on
 * two invented numbers — a ten-minute "overdue" line and a ninety-second green
 * hold — to decide when a camera stopped being interesting. Both are gone. The
 * owner's model replaced them (2026-08-12):
 *
 *   INCOMING   the group whose race has just finished. Every camera they took out
 *              starts GREY — expected back, nothing seen yet — and turns GREEN the
 *              moment it registers.
 *   STILL OUT  when the NEXT race on that track is called, the incoming section
 *              settles: anything green has been accounted for and simply leaves,
 *              and anything still grey moves left into STILL OUT, in red.
 *
 * That is better than a timer in every way that matters. It is a real venue event
 * rather than a guess at one; it is exactly the moment the answer starts to matter
 * (cameras are about to be handed to the next group); and green now means
 * something a person can say out loud — "came back from the race that just ran" —
 * instead of "was seen at some point in the last ninety seconds".
 *
 * ── THE THREE FACTS, all of which already existed ──
 *
 *   WHO WENT OUT      `camera-scan-log:{businessDay}` — the scan staff already do
 *                     (lib/camera-assign.ts). Camera, session, when.
 *   WHETHER IT IS DUE  the venue's own RaceFinish stamp, a Redis marker written
 *                     seconds after the flag (race-finish.server.ts), with
 *                     Pandora's actualEnd as the backstop when the bridge drops a
 *                     push — which it measurably does.
 *   WHETHER IT IS BACK `camera-seen:{camera}` — VT3 registering a clip off that
 *                     camera, which can only happen once it has reached a base
 *                     station, plus a staff re-scan onto the next racer.
 *
 * Plus one more, purely to decide WHICH SECTION: the last heat CALLED on each
 * track (`fetchTrackWatermarks`).
 *
 * DERIVED, NEVER REMEMBERED — the same doctrine as phase.ts and room-return.ts.
 * There is no camera-status record to get stuck, nothing to reconcile, and a
 * restart or a redeploy loses nothing.
 *
 * FOUR RULES IT MUST NOT BREAK:
 *
 *  1. A CAMERA STILL ON TRACK IS NOT ON THE STRIP AT ALL. Only a FINISHED race
 *     puts a camera here (owner: "those that were just returning and those who
 *     returned earlier but still haven't scanned in"). No finish record ⇒ absent.
 *  2. THE SIGHTING MUST POST-DATE THE FLAG, not the scan. A camera's PREVIOUS
 *     heat's footage can register minutes after this heat's scan — measuring
 *     against `assignedAt` would let that stale upload mark this heat's camera
 *     as returned. Against the end stamp it cannot.
 *  3. ONE BOX PER CAMERA, AND THE OLDEST DEBT WINS. A camera scanned out again
 *     while still unaccounted for from an earlier heat must keep reporting the
 *     earlier heat, and a newer scan must not quietly reset it.
 *  4. NOTHING BLINKS, PULSES OR SLIDES (owner: never blink — no motion on a
 *     guest-facing safety screen). A box changes colour, and it changes section
 *     when the next race is called. That is all the movement there is.
 */

/**
 * How long a camera may sit in INCOMING when we cannot tell whether the next race
 * has been called — an unnumbered heat (a group event, a custom race), or a track
 * we never learned.
 *
 * A last-resort bound only. Without it, one heat with no number would pin cameras
 * in the incoming section for the rest of the night, and the section that means
 * "these are coming back right now" would fill with cameras that are not.
 */
export const INCOMING_FALLBACK_MS = 15 * 60_000;

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

export type CameraTrack = "blue" | "red" | "mega";

/** What we know about a session's end. Absent from the map ⇒ not finished. */
export interface SessionFinish {
  endedAtMs: number;
  heatNumber: number | null;
  /** Which circuit the heat ran on. Null when the record named none — the box
   *  then wears a neutral outline rather than a guessed circuit's colour. */
  track: CameraTrack | null;
}

export interface CameraReturnInput {
  /** Today's scans, any order. */
  scans: CameraScan[];
  /** sessionId → finish, for the sessions that have finished. */
  finishes: Map<string, SessionFinish>;
  /** camera → last sighting ms. */
  seen: Map<string, number>;
  /** track → the last heat CALLED on it. What settles the incoming section. */
  calledHeats: Map<CameraTrack, number>;
  nowMs: number;
}

export type CameraBoxState =
  /** Its race has finished, the next one has been called, and it never came
   *  back. Red, in the left-hand section. */
  | "still-out"
  /** Its race has just finished and we have not seen it yet. Grey, on the right. */
  | "waiting"
  /** Seen since the flag, and the next race has not been called yet. Green, on
   *  the right, where it stays until the next call clears it. */
  | "back";

export interface CameraBox {
  camera: string;
  state: CameraBoxState;
  /** Heat this camera went out on — what staff would say out loud. */
  heatNumber: number | null;
  /** The circuit it went out on, so a box can wear that track's colour and staff
   *  know where to walk (owner 2026-08-12). */
  track: CameraTrack | null;
  /** How long since the flag, ms. What a red box prints under its number. */
  sinceFlagMs: number;
  /** Ordering key: when the camera went out. */
  assignedAtMs: number;
}

export interface CameraReturnStrip {
  /** RED, left section. Its race is over, the next has been called, never seen. */
  stillOut: CameraBox[];
  /** GREY then GREEN, right section. The group that has just come off track. */
  incoming: CameraBox[];
  /** What the strip prints. `stillOut.length`, named so the caller does not have
   *  to know that — and so it can never accidentally count the incoming ones. */
  outCount: number;
}

/**
 * Has a heat LATER than this one been called on the same track?
 *
 * Heat numbers only go up through a day, which is what makes the comparison safe
 * — the same reasoning room-return.ts uses to tell "ours has not gone green yet"
 * from "ours finished and we missed the stamp".
 *
 * Unknowable (no track, no heat number, or nothing called yet on that track) ⇒
 * fall back to the time bound, so a camera cannot sit in incoming all evening.
 */
function nextRaceCalled(
  box: {
    track: CameraTrack | null;
    heatNumber: number | null;
    sinceFlagMs: number;
  },
  calledHeats: Map<CameraTrack, number>,
): boolean {
  if (box.track === null || box.heatNumber === null) {
    return box.sinceFlagMs > INCOMING_FALLBACK_MS;
  }
  const called = calledHeats.get(box.track);
  if (called === undefined) return box.sinceFlagMs > INCOMING_FALLBACK_MS;
  return called > box.heatNumber;
}

/**
 * Turn the facts into the two sections.
 *
 * ORDER OF BUSINESS matters: resolve the oldest unresolved debt per camera FIRST
 * (rule 3), and only then ask whether that debt has been settled. Doing it the
 * other way round — picking the newest scan and then testing it — is how a camera
 * missing since heat 20 disappears the moment it is scanned onto heat 30.
 */
export function cameraReturnStripAt(input: CameraReturnInput): CameraReturnStrip {
  const { scans, finishes, seen, calledHeats, nowMs } = input;

  /** Per camera: the oldest finished scan that has NOT been settled by a sighting,
   *  and separately the newest that HAS (so it can show its green while the
   *  incoming window is open). */
  const oldestOpen = new Map<string, { scan: CameraScan; finish: SessionFinish }>();
  const newestDone = new Map<string, { scan: CameraScan; finish: SessionFinish }>();

  for (const scan of scans) {
    if (!scan.camera || !Number.isFinite(scan.assignedAtMs)) continue;
    const finish = finishes.get(scan.sessionId);
    // Rule 1 — still on track, or nobody ever told us it finished. Either way
    // there is nothing to chase, so the camera is not on the strip.
    if (!finish || !Number.isFinite(finish.endedAtMs)) continue;

    const seenAtMs = seen.get(scan.camera);
    // Rule 2 — the sighting has to post-date THIS race's flag.
    const settled = seenAtMs != null && seenAtMs >= finish.endedAtMs - SEEN_SKEW_MS;

    const bucket = settled ? newestDone : oldestOpen;
    const prev = bucket.get(scan.camera);
    const better = settled
      ? !prev || scan.assignedAtMs > prev.scan.assignedAtMs
      : !prev || scan.assignedAtMs < prev.scan.assignedAtMs;
    if (better) bucket.set(scan.camera, { scan, finish });
  }

  const stillOut: CameraBox[] = [];
  const incoming: CameraBox[] = [];

  const box = (
    scan: CameraScan,
    finish: SessionFinish,
    state: CameraBoxState,
    sinceFlagMs: number,
  ): CameraBox => ({
    camera: scan.camera,
    state,
    heatNumber: finish.heatNumber,
    track: finish.track,
    sinceFlagMs,
    assignedAtMs: scan.assignedAtMs,
  });

  for (const [, { scan, finish }] of oldestOpen) {
    const sinceFlagMs = Math.max(0, nowMs - finish.endedAtMs);
    const settledByCall = nextRaceCalled(
      { track: finish.track, heatNumber: finish.heatNumber, sinceFlagMs },
      calledHeats,
    );
    if (settledByCall) {
      stillOut.push(box(scan, finish, "still-out", sinceFlagMs));
    } else {
      incoming.push(box(scan, finish, "waiting", sinceFlagMs));
    }
  }

  for (const [camera, { scan, finish }] of newestDone) {
    // An open debt on the same camera outranks a settled one: the camera is still
    // missing from an earlier heat even though a later clip registered.
    if (oldestOpen.has(camera)) continue;
    const sinceFlagMs = Math.max(0, nowMs - finish.endedAtMs);
    // Accounted for AND the next race has been called — nothing left to say, so
    // it leaves the strip entirely rather than sitting there in green.
    if (
      nextRaceCalled(
        { track: finish.track, heatNumber: finish.heatNumber, sinceFlagMs },
        calledHeats,
      )
    ) {
      continue;
    }
    incoming.push(box(scan, finish, "back", sinceFlagMs));
  }

  // Oldest debt leftmost in both sections; camera number breaks an exact tie so
  // two cameras scanned in the same millisecond still order stably.
  const byAge = (a: CameraBox, b: CameraBox) =>
    a.assignedAtMs - b.assignedAtMs || Number(a.camera) - Number(b.camera);
  stillOut.sort(byAge);
  incoming.sort(byAge);

  return { stillOut, incoming, outCount: stillOut.length };
}

/**
 * "18 min" / "2 min" / "just now" — what a red box prints under its number.
 *
 * With blinking ruled out this figure is the only urgency signal on the strip, so
 * it counts from the chequered flag and not from when anyone last looked. Whole
 * minutes: seconds ticking on a wall board is motion, and nobody chases a camera
 * to the second.
 */
export function formatSinceFlag(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
