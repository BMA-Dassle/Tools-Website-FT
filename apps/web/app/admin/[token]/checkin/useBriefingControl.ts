"use client";

/**
 * The briefing-room control state, owned ABOVE the scan flash.
 *
 * WHY THIS HOOK EXISTS, and it is not a style preference. The check-in station
 * renders its scan result as an early return — a full-viewport `fixed inset-0`
 * flash — so for the four seconds it is up, everything else in the tree is
 * UNMOUNTED, the briefing panels included. When they came back they came back
 * blank: the staff member's Starter/Intermediate override reset to auto (they
 * could then send the wrong film), the "sent to the red room" confirmation
 * vanished mid-read, and the room panels repainted "Idle / no session" until the
 * next five-second poll landed.
 *
 * On a busy night that is not a corner case — racers scan in bursts, a party of
 * eight is through the desk in twenty seconds, so the panels would spend most of
 * their life remounting and effectively never hold still.
 *
 * CheckInClient's own state survives the flash, because the early return is
 * inside ITS render — the component instance persists, only its children go. So
 * the state and the poller live here, called unconditionally from CheckInClient,
 * and the panels became a pure renderer of it. The flash can take the whole
 * screen (it should) without costing anything underneath.
 */
import { useCallback, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
// The kind list is named ONCE, in desk-alarm.ts. Retyping it here is how `pull`
// came to exist on the board and not in the endpoint's shape check.
import type { AlarmKind } from "~/features/signage/briefing/desk-alarm";
import type {
  BriefingPhase,
  BriefingRoom,
  BriefingRoomState,
  BriefingTier,
} from "~/features/signage/briefing/types";
import type { GroupOut } from "~/features/signage/briefing/room-return";
import type { BriefingRecord } from "~/features/signage/briefing/briefing-log";
import type { LiveResolution, CameraPreviewMode } from "~/features/signage/nx/camera-preview";
import type { PitLanes } from "~/features/signage/pit/pit-board";

export interface RoomStatus {
  room: BriefingRoom;
  state: BriefingRoomState | null;
  phase: BriefingPhase;
  nextInMs: number | null;
  /** The last group briefed here and whether their race has finished — what stops
   *  an idle room claiming to be FREE while its group is still on track. See
   *  ~/features/signage/briefing/room-return.ts. */
  groupOut: GroupOut | null;
  /** Staff member running the group in this room, first name only. Optional so a
   *  station on the previous deploy simply shows no name rather than throwing. */
  host?: string | null;
}

export interface Assignment {
  id: string;
  room: BriefingRoom;
  track: string;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  tier: BriefingTier | null;
  mode: string;
  sentAt: string;
}

export interface BoardStatus {
  now: number;
  businessDay: string;
  enabled: boolean;
  rooms: RoomStatus[];
  /** Minutes a racer has to check in, per track, as configured on the TRACK
   *  BOARDS — the deadline the Called box turns amber and then red against. */
  checkinWindowMins: Record<string, number>;
  /** Deadline push alerts: whether this deployment has VAPID keys, the public
   *  one to register a device with, and how many are registered. */
  push?: { configured: boolean; publicKey: string | null; devices: number };
  assignments: Assignment[];
  /** Which sessions are still considered sent, keyed by sessionId — the
   *  REVERSIBLE fact behind the Called box, so Undo puts a heat back. Optional
   *  so a board talking to an older deploy simply falls back to `assignments`. */
  briefedSessions?: Record<string, { atMs: number; room: BriefingRoom | null }>;
  videos: Record<BriefingTier, { url: string; durationMs: number | null } | null>;
  helmetPosterUrl: string | null;
  /** Today's briefing log, folded — when each group went in, which film ran, and
   *  how long they were in the room. The durable insurance record, from Neon. */
  briefings: BriefingRecord[];
  /** The pit lane per track — what the Holding box reads. Optional so a board
   *  talking to an older deploy simply shows an empty Holding panel rather than
   *  throwing on a missing field. */
  lanes?: PitLanes;
  /**
   * Is the camera sweep armed? Drives the settings-sheet toggle.
   *
   * Optional for the same reason as the two above — a station still running the
   * previous deploy gets `undefined`, which the sheet reads as ON, matching what
   * that older server would actually be doing.
   */
  autoHolding?: { enabled: boolean };
  /** Does the welcome-back greeting start on the room camera's say-so (ON)
   *  or the fixed post+45s timer (OFF)? Optional for the same older-deploy
   *  reason — `undefined` reads as ON, matching the server default. */
  greetingByMotion?: { enabled: boolean };
  /** May staff override a send with no time left for the film? Optional for the
   *  same older-deploy reason — `undefined` reads as ALLOWED, matching the
   *  server default (owner 2026-08-24: "default to allow the override"). */
  sendOverride?: { allowed: boolean };
  /** The greeting's three staff-set numbers. Optional for the same
   *  older-deploy reason — the sheet falls back to the house defaults. */
  greetingTiming?: { fallbackMs: number; maxPlays: number; lingerAfterMs: number };
  /** Is race-event camera bookmarking armed? Optional for the same
   *  older-deploy reason as the fields above it. */
  raceBookmarks?: { enabled: boolean };
  /** Do the room previews play video, or a picture a second? Optional for the
   *  same older-deploy reason — `undefined` reads as "live", which is what a
   *  station on this build does when Redis has never been written. */
  cameraPreview?: { mode: CameraPreviewMode };
  /**
   * IS THE KART TIMING FEED ALIVE? Drives the desk's TIMING chip.
   *
   * Shape mirrored here rather than imported: the server's definition lives in
   * a `.server.ts` that reaches for Redis, and this file is client code.
   *
   * Optional for the same older-deploy reason as the fields above — a station
   * still on the previous build gets `undefined`, which the chip renders as
   * "unknown" rather than inventing a red DOWN for a feed that is fine.
   */
  timing?: TimingFeedStatus;
}

/** Mirrors TimingFeedStatus in ~/features/racing/timing-feed.server.ts. */
export interface TimingFeedStatus {
  state: "live" | "stale" | "down" | "unknown";
  lastEventMs: number | null;
  ageMs: number | null;
}

/**
 * A camera the desk board can open.
 *
 * The two briefing rooms, plus each track's PIT HOLDING AREA — the board's third
 * box (owner 2026-08-13). Holding is keyed by track rather than room because
 * that is how the venue keeps it in Nx ("FT Holding Red" / "FT Holding Blue");
 * the server resolves each name to whatever camera is on that layout, so
 * repointing a view is an Nx edit, not a deploy.
 */
export type CameraTarget = BriefingRoom | "holding-red" | "holding-blue";

export interface BriefingControl {
  board: BoardStatus | null;
  note: string | null;
  busy: boolean;
  /**
   * WHICH action is in flight, e.g. "start:red" — not merely that one is.
   *
   * A single global `busy` flag disabled every button on the board and indicated
   * nothing about which one had been pressed, so a staff member pressing Start got
   * no acknowledgement at all until the poll came back (owner 2026-08-11: "make
   * the buttons actually show input"). With the key, the pressed button can show
   * its own spinner while the others merely go inert.
   */
  pending: string | null;
  /**
   * WHO IS OPERATING THIS TABLET — the punch ID last verified at the staff
   * prompt, sent with every action so the server can resolve it to a name.
   *
   * A SETTER RATHER THAN A PARAMETER on each action, because the prompt holds a
   * closure it did not build (see BriefingRoomClient's `ask`) and threading an
   * argument through would mean changing every action's signature to carry
   * something none of them use themselves.
   *
   * WRITES A REF, NOT STATE, and that is load-bearing: the prompt sets this and
   * runs the held action in the SAME tick, so a state update — which lands next
   * render — would post the previous presser's ID, or none at all on the first
   * press of the night.
   *
   * The desk board never calls it, so its presses carry no ID and record no
   * name, exactly as before.
   */
  setActingPunchId: (punchId: string | null) => void;
  /* THE FILM OVERRIDE IS GONE (owner 2026-08-16). `tierOverride` /
     `setTierOverride` used to live here, per ROOM, so a Mega day's two rooms
     could differ. Nothing picks a film at the desk any more — the session's race
     type decides it, the send carries no `tier` at all, and sendBriefing derives
     the film itself, so there is exactly one answer. See the VIDEO row in
     RaceControlPanels. */
  /**
   * Which camera is open in the full-screen viewer, if any — a briefing room or
   * a holding area.
   *
   * UP HERE FOR THE SAME REASON AS EVERYTHING ELSE IN THIS HOOK: a scan lands
   * every few seconds on a busy night and takes the panels down with it, so a
   * viewer whose open/closed state lived in the panel would slam shut in the face
   * of whoever was watching the room fill.
   */
  expandedCamera: CameraTarget | null;
  setExpandedCamera: (target: CameraTarget | null) => void;
  /**
   * Which reference panel is open over the board — wait times, or today's log.
   *
   * UP HERE FOR THE SAME REASON AS THE CAMERA VIEWER: a scan lands every few
   * seconds on a busy night and unmounts the panels, so a modal whose open state
   * lived in the board would slam shut in the face of whoever opened it. One
   * field rather than two booleans, because only one can be open at a time and
   * two flags could disagree about that.
   */
  openPanel: BoardPanel | null;
  setOpenPanel: (panel: BoardPanel | null) => void;
  send: (args: {
    room: BriefingRoom;
    track: string;
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
  }) => void;
  /** Phase two: roll the film. Also used for "play it again". */
  start: (room: BriefingRoom, opts?: { restart?: boolean }) => void;
  clearRoom: (room: BriefingRoom) => void;
  /**
   * Phase three (owner 2026-08-13): the briefed group leaves the room for the
   * pit seats. Frees the room (a race can only return to an empty one) and
   * flips the pit board's rail to seat them — WITHOUT un-briefing the session,
   * which is what distinguishes it from clearRoom/Undo.
   */
  sendToHolding: (args: {
    room: BriefingRoom;
    track: string;
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
  }) => void;
  /** "Race returned" — the finished race's karts are fully back in the lane.
   *  The ONLY thing that releases the pit board's hold. */
  markPitted: (track: string) => void;
  /**
   * ARM OR DISARM THE CAMERA SWEEP that moves a group to holding by itself when
   * their room goes quiet (owner 2026-08-14).
   *
   * Lives in the settings sheet rather than beside the room controls on purpose:
   * this is not a thing to press during a heat, it is the switch to throw when
   * the automatic path is misbehaving and staff want the night back on manual.
   * It takes effect on the next sweep, within a minute.
   */
  setAutoHolding: (enabled: boolean) => void;
  /**
   * How long a called racer has to reach the desk. Null hands the window back
   * to the signage screen configs (owner 2026-08-23 — the gear setting).
   */
  setCheckinWindow: (minutes: number | null) => void;
  /**
   * The welcome-back greeting's mode: ON = the room TV starts the clip when
   * the room camera first sees the group walk in (measured 15-30s after the
   * first person enters); OFF = a plain 45s timer after the post press, no
   * camera involved. Same sheet as auto-holding because the owner asked for
   * it "where we have the other motion option" (2026-08-23).
   */
  setGreetingByMotion: (enabled: boolean) => void;
  /**
   * May staff override a send that has no time left for the film? ON (the
   * default) keeps the button alive behind a full-screen confirm; OFF restores
   * the hard lock. Same sheet as the greeting mode and auto-holding.
   */
  setSendOverride: (allowed: boolean) => void;
  /**
   * Send a TEST push to every registered device — the gear's proof that the
   * chain works end to end (owner 2026-08-24). Same fan-out as a real alert;
   * only the claim is skipped and the words say TEST.
   */
  testPush: (kind: AlarmKind) => void;
  /**
   * Change one of the greeting's three numbers — the no-camera delay, the
   * repeat cap, or how long a room may keep moving before the reminder
   * (owner 2026-08-23: "add these settings to the check in board gear
   * settings"). One field per press; the server merges and validates.
   */
  setGreetingTiming: (patch: {
    fallbackMs?: number;
    maxPlays?: number;
    lingerAfterMs?: number;
  }) => void;
  /**
   * ARM OR DISARM race-event bookmarks on the track cameras — session start,
   * pause, resume and end, written to every camera on that track.
   *
   * Separate from setAutoHolding because the two do unrelated things: that one
   * moves groups, this one only annotates footage. The likely reason to reach
   * for this is volume — a Mega heat marks ~33 cameras four times.
   */
  setRaceBookmarks: (enabled: boolean) => void;
  /** Live video or a picture a second on the room previews, for every station. */
  setCameraPreview: (mode: CameraPreviewMode) => void;
  /**
   * STAFF OVERRIDE — put a session in a lane slot by hand, or empty it.
   *
   * The escape hatch for a night when the automatic transitions cannot fire:
   * Pandora down, no start marker, no finish marker, the live socket
   * unreachable. Every one of those happened on 2026-08-13/14 and each
   * correction needed somebody with a Redis client (owner: "maybe a button
   * called override that allows us to manually change where each session is").
   *
   * The one-session-per-slot rule is enforced on the SERVER — a rule the modal
   * enforces is a rule a second tab can break — so this surfaces the refusal
   * rather than pre-empting it.
   */
  overrideSlot: (args: {
    track: string;
    slot: "called" | "room" | "holding" | "karts" | "racing" | "pitIn";
    /** Which briefing room, for the `room` slot. */
    room?: BriefingRoom;
    /** Null empties the slot. */
    session: {
      sessionId: string;
      heatNumber: number | null;
      raceType: string | null;
      room: BriefingRoom | null;
    } | null;
    force?: boolean;
  }) => void;
  /**
   * A fresh live-stream URL for a room's camera, or null if live is unavailable.
   *
   * HERE RATHER THAN IN THE PANEL because the admin token lives in this hook, and
   * a component that has to be handed the token to fetch anything is a component
   * that can leak it into a log or a prop tree. The panel asks for a URL and gets
   * one; it never sees the credential that bought it.
   *
   * Each call mints a SINGLE-USE Nx ticket, so every <video> load — first play,
   * camera switch, retry after a drop — needs its own call.
   *
   * `res` picks FRAME RATE, not sharpness — 480p is the 20fps transcode, 720p is
   * the camera's 2fps substream. See the table in /api/admin/camera-live.
   */
  liveCameraUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  /**
   * SESSIONS THIS STATION HAS SEEN GO GREEN — and it must not forget.
   *
   * The Holding box clears when the live clock says its group is racing. That
   * verdict is only true WHILE the clock is running: the moment the race ends
   * the clock stops publishing, the verdict evaporates, and the group reappeared
   * in the seats they had long since left (owner 2026-08-14: "session 64 both
   * tracks when finished went back to holding state").
   *
   * Server-side the lane ends a holding claim on the finish marker — but that
   * marker rides the timing webhook, and tonight has shown it does not always
   * arrive. So the desk remembers what it saw with its own eyes: once a session
   * has been observed counting, it has raced, and no later absence of a clock
   * un-races it.
   *
   * HERE RATHER THAN IN THE PANEL for the same reason as everything else in this
   * hook: the scan flash unmounts the panels every few seconds, and a memory
   * held down there would be wiped by the next racer through the desk.
   */
  hasLaunched: (sessionId: string | null | undefined) => boolean;
  noteLaunched: (sessionId: string | null | undefined) => void;
  /**
   * TODAY'S WAIT TIMES, per track (owner 2026-08-12: "it would be today's times").
   *
   * Null until the first read lands, and null again only if it has never
   * succeeded — a failed poll keeps the last good numbers rather than blanking
   * the strip, exactly like the board poll above it.
   */
  waitTimes: WaitTimesBoard | null;
  /**
   * THE SAME NUMBERS OVER THE LAST SEVEN DAYS — what today is compared against
   * (owner 2026-08-12: "tiles so we can compare day to week").
   *
   * A wait time means nothing on its own: 9:34 is either a good night or a bad
   * one depending on what the week looks like, and staff cannot hold last
   * Tuesday's median in their heads. The tile shows today and says how it
   * differs; this is the baseline behind that.
   */
  waitTimesWeek: WaitTimesBoard | null;
}

/** What the board strip reads. A subset of /api/admin/wait-times' response —
 *  the endpoint returns per-session rows too, which no board needs. */
/** The board's reference overlays. Neither is an action — both are things staff
 *  open, read and dismiss, which is why they are modals and not board furniture. */
export type BoardPanel = "waits" | "log" | "override";

export interface WaitTimesBoard {
  byTrack: Record<string, Record<string, { n: number; medianMs: number | null }>>;
  /** The same shape over the ROLLING LAST HOUR — the board's "are we behind
   *  right now" signal, which a night's median is precisely what hides. */
  lastHourByTrack?: Record<string, Record<string, { n: number; medianMs: number | null }>>;
  sessions: number;
}

export function useBriefingControl(token: string, enabled: boolean): BriefingControl {
  const [board, setBoard] = useState<BoardStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [expandedCamera, setExpandedCamera] = useState<CameraTarget | null>(null);
  const [openPanel, setOpenPanel] = useState<BoardPanel | null>(null);
  const [waitTimes, setWaitTimes] = useState<WaitTimesBoard | null>(null);
  const [waitTimesWeek, setWaitTimesWeek] = useState<WaitTimesBoard | null>(null);
  /** See BriefingControl.setActingPunchId — a ref because the prompt sets it and
   *  fires the action in the same tick. */
  const actingPunchId = useRef<string | null>(null);
  const setActingPunchId = useCallback((punchId: string | null) => {
    actingPunchId.current = punchId;
  }, []);

  const loadBoard = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/admin/briefing?token=${encodeURIComponent(token)}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok || signal?.aborted) return; // keep the last good board
        setBoard((await res.json()) as BoardStatus);
      } catch {
        /* a dropped poll must not blank the controls */
      }
    },
    [token],
  );

  // The house poller: no overlapping cycles when an upstream is slow, plus a
  // per-cycle abort. `enabled` is false without ?board=1, so a plain check-in
  // station makes no briefing requests at all.
  useVisibleInterval(
    async (signal) => {
      await loadBoard(signal);
    },
    5_000,
    enabled,
  );

  const post = useCallback(
    async (body: Record<string, unknown>, successNote: string, key?: string) => {
      setBusy(true);
      setPending(key ?? null);
      setNote(null);
      try {
        const res = await fetch(`/api/admin/briefing?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The punch ID rides along on every action; the SERVER turns it into a
          // name. Undefined when this station has no prompt (the desk board),
          // which posts exactly the body it always did.
          body: JSON.stringify({ ...body, punchId: actingPunchId.current ?? undefined }),
        });
        const json = (await res.json()) as {
          error?: string;
          hasVideo?: boolean;
          tier?: string;
          photoSaved?: boolean;
        };
        if (!res.ok) {
          setNote(`✕ ${json.error ?? `Failed (${res.status})`}`);
          return;
        }
        // Say when a send will NOT show a film, rather than leaving staff to
        // wonder why the room went straight to helmet sizes.
        //
        // And say when the room was PHOTOGRAPHED (owner 2026-08-12), because a
        // record staff do not know is being kept is a record they cannot vouch
        // for. The log strip below carries the durable version with its
        // timestamp; this is the receipt at the moment of the press.
        const photo = json.photoSaved ? " — briefing photo + timestamp saved for insurance." : "";
        setNote(
          json.hasVideo === false
            ? `✓ ${successNote} — but no ${json.tier} video is uploaded, so the room opens on helmet sizes.${photo}`
            : `✓ ${successNote}${photo}`,
        );
        await loadBoard();
      } catch (err) {
        setNote(`✕ Could not reach the server${err instanceof Error ? ` — ${err.message}` : ""}`);
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [token, loadBoard],
  );

  const send = useCallback<BriefingControl["send"]>(
    (args) => {
      void post(
        {
          action: "send",
          room: args.room,
          track: args.track,
          sessionId: args.sessionId,
          heatNumber: args.heatNumber,
          raceType: args.raceType,
          // NO `tier`. The board does not choose films (owner 2026-08-16), so
          // the server derives it from raceType — one answer, one place.
        },
        `Session ${args.heatNumber ?? ""} sent to the ${args.room} room`,
        `send:${args.room}`,
      );
    },
    [post],
  );

  const start = useCallback<BriefingControl["start"]>(
    (room, opts) => {
      void post(
        { action: opts?.restart ? "restart" : "start", room },
        opts?.restart ? `${room} briefing restarted` : `${room} briefing started`,
        opts?.restart ? `restart:${room}` : `start:${room}`,
      );
    },
    [post],
  );

  const clearRoom = useCallback<BriefingControl["clearRoom"]>(
    (room) => {
      void post({ action: "clear", room }, `${room} room cleared`, `clear:${room}`);
    },
    [post],
  );

  const sendToHolding = useCallback<BriefingControl["sendToHolding"]>(
    (args) => {
      void post(
        {
          action: "send-holding",
          room: args.room,
          track: args.track,
          sessionId: args.sessionId,
          heatNumber: args.heatNumber,
          raceType: args.raceType,
        },
        `Session ${args.heatNumber ?? ""} sent to holding — the ${args.room} room is open`,
        `holding:${args.room}`,
      );
    },
    [post],
  );

  const setAutoHolding = useCallback<BriefingControl["setAutoHolding"]>(
    (enabled) => {
      void post(
        { action: "auto-holding", enabled },
        enabled
          ? "Auto-move to holding is ON — a room that goes quiet after the briefing frees itself"
          : "Auto-move to holding is OFF — staff press Send to holding",
        "auto-holding",
      );
    },
    [post],
  );

  const setCheckinWindow = useCallback<BriefingControl["setCheckinWindow"]>(
    (minutes) => {
      void post(
        { action: "checkin-window", minutes },
        minutes == null
          ? "Check-in window follows the track screens again"
          : `Check-in window is ${minutes} minutes from the call — every board and TV`,
        "checkin-window",
      );
    },
    [post],
  );

  const setSendOverride = useCallback<BriefingControl["setSendOverride"]>(
    (allowed) => {
      void post(
        { action: "send-override", enabled: allowed },
        allowed
          ? "Staff may send with no time left — the board asks first"
          : "Sends with no time left are BLOCKED — the button will not press",
        "send-override",
      );
    },
    [post],
  );

  const testPush = useCallback<BriefingControl["testPush"]>(
    (kind) => {
      void post(
        { action: "push-test", kind },
        kind === "call"
          ? "Test CALL alert sent to every registered device"
          : kind === "pull"
            ? "Test PULL TO BRIEFING alert sent to every registered device"
            : "Test SEND alert sent to every registered device",
        `push-test:${kind}`,
      );
    },
    [post],
  );

  const setGreetingByMotion = useCallback<BriefingControl["setGreetingByMotion"]>(
    (enabled) => {
      void post(
        { action: "greeting-by-motion", enabled },
        enabled
          ? "Welcome-back greeting follows the room camera — it plays once the group actually walks in"
          : "Welcome-back greeting is on a 45-second timer after the post call — the camera is not consulted",
        "greeting-by-motion",
      );
    },
    [post],
  );

  const setGreetingTiming = useCallback<BriefingControl["setGreetingTiming"]>(
    (patch) => {
      // Says what it now IS, not what was pressed — the sheet's own buttons
      // already show the press, and the note is what staff read back.
      const what =
        patch.fallbackMs != null
          ? `Greeting delay without a camera answer: ${Math.round(patch.fallbackMs / 1000)} seconds`
          : patch.maxPlays != null
            ? `Greeting plays up to ${patch.maxPlays} time${patch.maxPlays === 1 ? "" : "s"} per return`
            : `Still-in-the-room reminder after ${Math.round(((patch.lingerAfterMs ?? 0) / 60000) * 10) / 10} min`;
      void post({ action: "greeting-timing", ...patch }, what, "greeting-timing");
    },
    [post],
  );

  const setRaceBookmarks = useCallback<BriefingControl["setRaceBookmarks"]>(
    (enabled) => {
      void post(
        { action: "race-bookmarks", enabled },
        enabled
          ? "Race camera bookmarks are ON — start, pause, resume and end are marked on every camera for the track"
          : "Race camera bookmarks are OFF — nothing new is written to the cameras",
        "race-bookmarks",
      );
    },
    [post],
  );

  const setCameraPreview = useCallback<BriefingControl["setCameraPreview"]>(
    (mode) => {
      void post(
        { action: "camera-preview", mode },
        mode === "live"
          ? "Room previews are LIVE — moving video on every check-in station"
          : "Room previews are STILLS — a picture a second, and no load on the camera server",
        "camera-preview",
      );
    },
    [post],
  );

  const overrideSlot = useCallback<BriefingControl["overrideSlot"]>(
    (args) => {
      const where =
        args.slot === "room" ? `${args.room ?? args.track} room` : `${args.track} ${args.slot}`;
      const what = args.session
        ? `Session ${args.session.heatNumber ?? ""} → ${where}`
        : `${where} cleared`;
      void post(
        {
          action: "override",
          track: args.track,
          slot: args.slot,
          sessionId: args.session?.sessionId ?? "",
          heatNumber: args.session?.heatNumber ?? undefined,
          raceType: args.session?.raceType ?? undefined,
          room: args.room ?? args.session?.room ?? undefined,
          force: args.force === true,
        },
        what,
        `override:${args.slot === "room" ? (args.room ?? args.track) : args.track}:${args.slot}`,
      );
    },
    [post],
  );

  const markPitted = useCallback<BriefingControl["markPitted"]>(
    (track) => {
      void post(
        { action: "pitted", track },
        `${track} race returned — the lane is clear to seat`,
        `pitted:${track}`,
      );
    },
    [post],
  );

  /**
   * The wait-time strip's own poll, at a MINUTE rather than the board's five
   * seconds. These are today's averages over the whole night: they move when a
   * heat finishes, not between two blinks, and each read folds the day's events
   * — so polling it at board speed would be twelve times the work for a number
   * that had not changed.
   */
  useVisibleInterval(
    async (signal) => {
      try {
        const res = await fetch(`/api/admin/wait-times?token=${encodeURIComponent(token)}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok || signal?.aborted) return; // keep the last good numbers
        const json = (await res.json()) as WaitTimesBoard;
        setWaitTimes(json);
      } catch {
        /* a dropped poll must not blank the strip */
      }
    },
    60_000,
    enabled,
  );

  /**
   * The seven-day baseline, polled every TEN MINUTES.
   *
   * A week's median moves by seconds over a shift — it is six other nights plus
   * today, so today's newest heat can barely shift it. Reading it at the same
   * cadence as today's number would fold a week of events every minute to watch
   * a figure that does not move.
   */
  useVisibleInterval(
    async (signal) => {
      try {
        // excludeToday=1 — the seven days BEFORE today. A baseline that contains
        // today is today compared with itself, which in the first days of data is
        // EXACTLY itself: every tile reads "about the same" and the comparison
        // silently means nothing.
        const res = await fetch(
          `/api/admin/wait-times?token=${encodeURIComponent(token)}&days=7&excludeToday=1`,
          { cache: "no-store", signal },
        );
        if (!res.ok || signal?.aborted) return;
        setWaitTimesWeek((await res.json()) as WaitTimesBoard);
      } catch {
        /* the tiles simply show no comparison */
      }
    },
    600_000,
    enabled,
  );

  /** A ref, not state: nothing renders from the set itself — it only ever
   *  answers a question the render already asks — so writing to it must not
   *  cost a render on every poll. */
  const launchedRef = useRef<Set<string>>(new Set());
  const hasLaunched = useCallback<BriefingControl["hasLaunched"]>(
    (sessionId) => (sessionId ? launchedRef.current.has(sessionId) : false),
    [],
  );
  const noteLaunched = useCallback<BriefingControl["noteLaunched"]>((sessionId) => {
    if (sessionId) launchedRef.current.add(sessionId);
  }, []);

  const liveCameraUrl = useCallback<BriefingControl["liveCameraUrl"]>(
    async (target, resolution) => {
      try {
        const res = await fetch(
          `/api/admin/camera-live?token=${encodeURIComponent(token)}&room=${target}` +
            (resolution ? `&res=${resolution}` : ""),
          { cache: "no-store" },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { url?: string };
        return json.url ?? null;
      } catch {
        // Live is an upgrade on the still refresh, never a requirement — a failure
        // here leaves the viewer exactly as good as it was before.
        return null;
      }
    },
    [token],
  );

  return {
    board,
    note,
    busy,
    pending,
    setActingPunchId,
    expandedCamera,
    setExpandedCamera,
    openPanel,
    setOpenPanel,
    send,
    start,
    clearRoom,
    sendToHolding,
    markPitted,
    setAutoHolding,
    setCheckinWindow,
    setGreetingByMotion,
    setSendOverride,
    testPush,
    setGreetingTiming,
    setRaceBookmarks,
    setCameraPreview,
    overrideSlot,
    liveCameraUrl,
    hasLaunched,
    noteLaunched,
    waitTimes,
    waitTimesWeek,
  };
}
