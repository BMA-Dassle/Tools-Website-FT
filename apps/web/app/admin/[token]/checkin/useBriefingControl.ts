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
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import type {
  BriefingPhase,
  BriefingRoom,
  BriefingRoomState,
  BriefingTier,
} from "~/features/signage/briefing/types";
import type { GroupOut } from "~/features/signage/briefing/room-return";
import type { BriefingRecord } from "~/features/signage/briefing/briefing-log";

export interface RoomStatus {
  room: BriefingRoom;
  state: BriefingRoomState | null;
  phase: BriefingPhase;
  nextInMs: number | null;
  /** The last group briefed here and whether their race has finished — what stops
   *  an idle room claiming to be FREE while its group is still on track. See
   *  ~/features/signage/briefing/room-return.ts. */
  groupOut: GroupOut | null;
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
  assignments: Assignment[];
  videos: Record<BriefingTier, { url: string; durationMs: number | null } | null>;
  helmetPosterUrl: string | null;
  /** Today's briefing log, folded — when each group went in, which film ran, and
   *  how long they were in the room. The durable insurance record, from Neon. */
  briefings: BriefingRecord[];
}

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
  /** Staff's film override, per ROOM — on a Mega day both rooms read one
   *  session, so choosing Intermediate for Red must not change Blue. */
  tierOverride: Record<string, BriefingTier | null>;
  setTierOverride: (room: BriefingRoom, tier: BriefingTier | null) => void;
  /**
   * Which room's camera is open in the full-screen viewer, if any.
   *
   * UP HERE FOR THE SAME REASON AS EVERYTHING ELSE IN THIS HOOK: a scan lands
   * every few seconds on a busy night and takes the panels down with it, so a
   * viewer whose open/closed state lived in the panel would slam shut in the face
   * of whoever was watching the room fill.
   */
  expandedRoom: BriefingRoom | null;
  setExpandedRoom: (room: BriefingRoom | null) => void;
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
   * A fresh live-stream URL for a room's camera, or null if live is unavailable.
   *
   * HERE RATHER THAN IN THE PANEL because the admin token lives in this hook, and
   * a component that has to be handed the token to fetch anything is a component
   * that can leak it into a log or a prop tree. The panel asks for a URL and gets
   * one; it never sees the credential that bought it.
   *
   * Each call mints a SINGLE-USE Nx ticket, so every <video> load — first play,
   * room switch, retry after a drop — needs its own call.
   */
  liveCameraUrl: (room: BriefingRoom) => Promise<string | null>;
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
export interface WaitTimesBoard {
  byTrack: Record<string, Record<string, { n: number; medianMs: number | null }>>;
  sessions: number;
}

export function useBriefingControl(token: string, enabled: boolean): BriefingControl {
  const [board, setBoard] = useState<BoardStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [tierOverride, setTierOverrideState] = useState<Record<string, BriefingTier | null>>({});
  const [expandedRoom, setExpandedRoom] = useState<BriefingRoom | null>(null);
  const [waitTimes, setWaitTimes] = useState<WaitTimesBoard | null>(null);
  const [waitTimesWeek, setWaitTimesWeek] = useState<WaitTimesBoard | null>(null);

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
          body: JSON.stringify(body),
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
        const photo = json.photoSaved ? " — room photo + timestamp saved for insurance." : "";
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

  const setTierOverride = useCallback((room: BriefingRoom, tier: BriefingTier | null) => {
    setTierOverrideState((prev) => ({ ...prev, [room]: tier }));
  }, []);

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
          tier: tierOverride[args.room] ?? undefined,
        },
        `Session ${args.heatNumber ?? ""} sent to the ${args.room} room`,
        `send:${args.room}`,
      );
    },
    [post, tierOverride],
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

  const liveCameraUrl = useCallback<BriefingControl["liveCameraUrl"]>(
    async (room) => {
      try {
        const res = await fetch(
          `/api/admin/camera-live?token=${encodeURIComponent(token)}&room=${room}`,
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
    tierOverride,
    setTierOverride,
    expandedRoom,
    setExpandedRoom,
    send,
    start,
    clearRoom,
    liveCameraUrl,
    waitTimes,
    waitTimesWeek,
  };
}
