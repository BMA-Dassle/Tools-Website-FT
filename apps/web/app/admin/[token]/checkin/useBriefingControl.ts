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
  BriefingQualifier,
  BriefingRoom,
  BriefingRoomState,
  BriefingTier,
} from "~/features/signage/briefing/types";

export interface QualsBoard {
  heatNumber: number | null;
  raceType: string | null;
  qualifiers: BriefingQualifier[];
}

export interface RoomStatus {
  room: BriefingRoom;
  state: BriefingRoomState | null;
  phase: BriefingPhase;
  nextInMs: number | null;
  quals: QualsBoard | null;
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
  assignments: Assignment[];
  videos: Record<BriefingTier, { url: string; durationMs: number | null } | null>;
  helmetPosterUrl: string | null;
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
  send: (args: {
    room: BriefingRoom;
    track: string;
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
  }) => void;
  /** Phase two: roll the film. Also used for "play it again". */
  start: (room: BriefingRoom, opts?: { restart?: boolean }) => void;
  showQuals: (room: BriefingRoom) => void;
  clearRoom: (room: BriefingRoom) => void;
}

export function useBriefingControl(token: string, enabled: boolean): BriefingControl {
  const [board, setBoard] = useState<BoardStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [tierOverride, setTierOverrideState] = useState<Record<string, BriefingTier | null>>({});

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
        const json = (await res.json()) as { error?: string; hasVideo?: boolean; tier?: string };
        if (!res.ok) {
          setNote(`✕ ${json.error ?? `Failed (${res.status})`}`);
          return;
        }
        // Say when a send will NOT show a film, rather than leaving staff to
        // wonder why the room went straight to helmet sizes.
        setNote(
          json.hasVideo === false
            ? `✓ ${successNote} — but no ${json.tier} video is uploaded, so the room opens on helmet sizes.`
            : `✓ ${successNote}`,
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

  const showQuals = useCallback<BriefingControl["showQuals"]>(
    (room) => {
      void post(
        { action: "show-quals", room },
        `Levelled-up board sent to the ${room} room`,
        `quals:${room}`,
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

  return {
    board,
    note,
    busy,
    pending,
    tierOverride,
    setTierOverride,
    send,
    start,
    showQuals,
    clearRoom,
  };
}
