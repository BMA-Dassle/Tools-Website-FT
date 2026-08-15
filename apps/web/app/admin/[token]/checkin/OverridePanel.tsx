"use client";

/**
 * WHERE EVERY SESSION IS, AND HOW TO MOVE ONE BY HAND.
 *
 * THE NIGHT THIS EXISTS FOR (2026-08-13/14). Every automatic transition on the
 * check-in board depends on something outside the building — Pandora naming the
 * called heat, the timing webhook stamping a start or a finish, the live timing
 * socket reaching the desk. All three failed in one evening: races/current
 * returned 500 for hours, start markers never arrived, finishes had to be
 * written in by script. Staff could see exactly where each group was standing
 * and had no way at all to tell the board (owner 2026-08-14: "maybe a button
 * called override that allows us to manually change where each session is").
 *
 * IT IS A LIVE VIEW FIRST AND A CONTROL SECOND (owner: "should show us live of
 * what state each of the sessions are in"). Reading the slots is most of the
 * value: half of that night's incidents were the board and the floor disagreeing
 * about one heat, with nobody able to see which one. This table rides the
 * board's own 5-second poll, so it is never a snapshot anyone has to trust.
 *
 * ONE SESSION PER SLOT. Placing into an occupied slot is REFUSED by the server,
 * with the occupant named, and Clear sits beside every filled slot so the fix is
 * one press away (owner: "if something is already in that state it would need
 * changed first before moving another race to that state"). The rule is not
 * enforced in here — a rule the modal enforces is a rule a second tab can break.
 */
import type { useTrackStatus } from "@/hooks/useTrackStatus";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import type { BriefingRoom } from "~/features/signage/briefing/types";
import type { BriefingControl } from "./useBriefingControl";

const INK = "#e8eef7";
const GREEN = "#4ade80";
const AMBER = "#f0b341";

/** A slot a session was sighted in — enough to empty exactly that slot. */
interface OccupiedSlot {
  track: string;
  slot: "called" | "room" | "holding" | "karts" | "racing";
  room?: BriefingRoom;
}

/** One session the desk can currently name, and everywhere it appears. */
interface KnownSession {
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  room: BriefingRoom | null;
  where: string;
  /** Every slot it currently occupies, in sighting order. */
  at: OccupiedSlot[];
}

export default function OverridePanel({
  control,
  megaEnabled,
  status,
}: {
  control: BriefingControl;
  megaEnabled: boolean;
  status: ReturnType<typeof useTrackStatus>;
}) {
  const board = control.board;
  const tracks: Array<"blue" | "red" | "mega"> = megaEnabled ? ["mega"] : ["blue", "red"];

  /**
   * Everything the desk can currently name, so a heat can be placed without
   * anybody typing a session id: what is called, what is in a room, and what a
   * lane already holds. A session in two places at once is exactly the condition
   * this panel exists to fix, so `where` accumulates rather than overwrites.
   */
  const known = new Map<string, KnownSession>();
  const remember = (
    sessionId: string | null | undefined,
    heatNumber: number | null,
    raceType: string | null,
    room: BriefingRoom | null,
    where: string,
    /** The slot this sighting came from, so Remove knows what to empty. */
    at: OccupiedSlot,
  ) => {
    if (!sessionId) return;
    const prev = known.get(sessionId);
    known.set(sessionId, {
      sessionId,
      heatNumber: heatNumber ?? prev?.heatNumber ?? null,
      raceType: raceType ?? prev?.raceType ?? null,
      room: room ?? prev?.room ?? null,
      where: prev ? `${prev.where} · ${where}` : where,
      at: prev ? [...prev.at, at] : [at],
    });
  };

  for (const t of tracks) {
    const race = status?.currentRaces?.[t] ?? null;
    if (race?.sessionId != null) {
      remember(
        String(race.sessionId),
        race.heatNumber ?? null,
        race.raceType ?? null,
        null,
        `called on ${t}`,
        { track: t, slot: "called" },
      );
    }
  }
  for (const r of board?.rooms ?? []) {
    if (r.state?.sessionId) {
      remember(
        r.state.sessionId,
        r.state.heatNumber ?? null,
        r.state.raceType ?? null,
        r.room,
        `${r.room} room`,
        { track: r.room, slot: "room", room: r.room },
      );
    }
  }
  for (const t of tracks) {
    const lane = board?.lanes?.[t];
    if (lane?.holding) {
      remember(
        lane.holding.sessionId,
        lane.holding.heatNumber,
        lane.holding.raceType,
        lane.holding.room,
        `${t} holding`,
        { track: t, slot: "holding" },
      );
    }
    if (lane?.karts) {
      remember(
        lane.karts.sessionId,
        lane.karts.heatNumber,
        lane.karts.raceType,
        lane.karts.room,
        `${t} karts`,
        { track: t, slot: "karts" },
      );
    }
    if (lane?.racing) {
      remember(lane.racing.sessionId, lane.racing.heatNumber, null, null, `${t} racing`, {
        track: t,
        slot: "racing",
      });
    }
  }

  const rows = [...known.values()].sort((a, b) => (a.heatNumber ?? 0) - (b.heatNumber ?? 0));

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <Label>Where each stage is — live</Label>
        {/* THE WHOLE FLOW, not just the lane. Check-in and the briefing rooms
            are as capable of getting stuck as holding is — tonight it was
            check-in that froze, for hours — so every stage a heat passes
            through is readable and clearable from one place (owner 2026-08-14:
            "should be able to clear check in and briefing"). */}
        {tracks.map((t) => (
          <div key={`called:${t}`} style={rowStyle(!!status?.currentRaces?.[t])}>
            <span style={slotLabelStyle}>{t} check-in</span>
            <span
              className="rc-num"
              style={{
                minWidth: 150,
                fontSize: 14,
                color: status?.currentRaces?.[t] ? INK : PORTAL_DARK.muted,
              }}
            >
              {status?.currentRaces?.[t]?.heatNumber != null
                ? `Session ${status.currentRaces[t]!.heatNumber}`
                : "empty"}
            </span>
            {status?.currentRaces?.[t] && (
              <button
                type="button"
                className="rcb"
                disabled={control.pending === `override:${t}:called`}
                onClick={() => control.overrideSlot({ track: t, slot: "called", session: null })}
                title={`Clear the called heat on ${t}`}
                style={btnStyle(PORTAL_DARK.border, PORTAL_DARK.fg)}
              >
                Clear
              </button>
            )}
          </div>
        ))}
        {(board?.rooms ?? []).map((r) => (
          <div key={`room:${r.room}`} style={rowStyle(!!r.state?.sessionId)}>
            <span style={slotLabelStyle}>{r.room} room</span>
            <span
              className="rc-num"
              style={{
                minWidth: 150,
                fontSize: 14,
                color: r.state?.sessionId ? INK : PORTAL_DARK.muted,
              }}
            >
              {r.state?.heatNumber != null ? `Session ${r.state.heatNumber}` : "empty"}
            </span>
            {r.state?.sessionId && (
              <button
                type="button"
                className="rcb"
                disabled={control.pending === `override:${r.room}:room`}
                onClick={() =>
                  control.overrideSlot({ track: r.room, slot: "room", session: null, room: r.room })
                }
                title={`Clear the ${r.room} briefing room`}
                style={btnStyle(PORTAL_DARK.border, PORTAL_DARK.fg)}
              >
                Clear
              </button>
            )}
          </div>
        ))}
        {tracks.map((t) =>
          (["holding", "karts", "racing"] as const).map((slot) => {
            const lane = board?.lanes?.[t];
            const occ = lane?.[slot];
            return (
              <div key={`${t}:${slot}`} style={rowStyle(!!occ)}>
                <span style={slotLabelStyle}>
                  {t} {slot}
                </span>
                <span
                  className="rc-num"
                  style={{
                    minWidth: 150,
                    fontSize: 14,
                    color: occ ? INK : PORTAL_DARK.muted,
                  }}
                >
                  {occ ? `Session ${occ.heatNumber ?? "?"}` : "empty"}
                </span>
                {occ && (
                  <button
                    type="button"
                    className="rcb"
                    disabled={control.pending === `override:${t}:${slot}`}
                    onClick={() => control.overrideSlot({ track: t, slot, session: null })}
                    title={`Take session ${occ.heatNumber ?? ""} out of ${t} ${slot}`}
                    style={btnStyle(PORTAL_DARK.border, PORTAL_DARK.fg)}
                  >
                    Clear
                  </button>
                )}
              </div>
            );
          }),
        )}
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <Label>Sessions the desk can see</Label>
        {rows.length === 0 && (
          <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
            Nothing called, briefed or in a lane right now.
          </p>
        )}
        {rows.map((r) => (
          <div key={r.sessionId} style={rowStyle(false)}>
            <span
              className="rc-num"
              style={{ minWidth: 120, fontSize: 15, fontWeight: 800, color: INK }}
            >
              Session {r.heatNumber ?? "?"}
            </span>
            <span style={{ minWidth: 180, fontSize: 11, color: PORTAL_DARK.muted }}>{r.where}</span>
            {/* TAKE IT OFF THE BOARD ENTIRELY (owner 2026-08-14: "should have
                ability to delete session from system so it can be called
                again"). A session is on this list ONLY because it occupies a
                slot, so emptying every slot it holds is what removing it means —
                there is no separate registry to delete it from, and inventing
                one would be a second source of truth for where a heat is.

                Order does not matter here, and that is worth saying: the
                server's one-session-per-slot refusal applies to PLACING a
                session, never to emptying a slot, so these cannot collide with
                each other. Clearing check-in now sticks too, so a removed heat
                stays gone until it is genuinely called again. */}
            <button
              type="button"
              className="rcb"
              disabled={!!control.pending}
              onClick={() => {
                for (const at of r.at) {
                  control.overrideSlot({
                    track: at.track,
                    slot: at.slot,
                    room: at.room,
                    session: null,
                  });
                }
              }}
              title={`Take session ${r.heatNumber ?? ""} out of every stage it is in (${r.where})`}
              style={btnStyle(PORTAL_DARK.border, PORTAL_DARK.fg)}
            >
              Remove
            </button>
            {tracks.map((t) => (
              <button
                key={`called:${t}`}
                type="button"
                className="rcb"
                disabled={control.pending === `override:${t}:called`}
                onClick={() =>
                  control.overrideSlot({
                    track: t,
                    slot: "called",
                    session: {
                      sessionId: r.sessionId,
                      heatNumber: r.heatNumber,
                      raceType: r.raceType,
                      room: r.room,
                    },
                  })
                }
                title={`Put session ${r.heatNumber ?? ""} back on ${t} check-in`}
                style={btnStyle(withAlpha(INK, 0.35), INK)}
              >
                → {t} check-in
              </button>
            ))}
            {(["red", "blue"] as const).map((room) => (
              <button
                key={`room:${room}`}
                type="button"
                className="rcb"
                disabled={control.pending === `override:${room}:room`}
                onClick={() =>
                  control.overrideSlot({
                    track: megaEnabled ? "mega" : room,
                    slot: "room",
                    room,
                    session: {
                      sessionId: r.sessionId,
                      heatNumber: r.heatNumber,
                      raceType: r.raceType,
                      room,
                    },
                  })
                }
                title={`Put session ${r.heatNumber ?? ""} in the ${room} briefing room`}
                style={btnStyle(withAlpha(INK, 0.35), INK)}
              >
                → {room} room
              </button>
            ))}
            {tracks.map((t) =>
              (["holding", "racing"] as const).map((slot) => (
                <button
                  key={`${t}:${slot}`}
                  type="button"
                  className="rcb"
                  disabled={control.pending === `override:${t}:${slot}`}
                  onClick={() =>
                    control.overrideSlot({
                      track: t,
                      slot,
                      session: {
                        sessionId: r.sessionId,
                        heatNumber: r.heatNumber,
                        raceType: r.raceType,
                        room: r.room,
                      },
                    })
                  }
                  title={`Put session ${r.heatNumber ?? ""} in ${t} ${slot}`}
                  style={btnStyle(
                    slot === "holding" ? withAlpha(GREEN, 0.55) : withAlpha(AMBER, 0.55),
                    slot === "holding" ? GREEN : AMBER,
                  )}
                >
                  → {t} {slot}
                </button>
              )),
            )}
          </div>
        ))}
      </div>

      <p style={{ fontSize: 11, color: PORTAL_DARK.muted, margin: 0 }}>
        A slot holds one session. If a move is refused, clear that slot first — the refusal names
        who is in it.
      </p>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: PORTAL_DARK.muted,
      }}
    >
      {children}
    </span>
  );
}

const slotLabelStyle: React.CSSProperties = {
  minWidth: 140,
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: PORTAL_DARK.muted,
};

function rowStyle(filled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    padding: "7px 10px",
    borderRadius: 6,
    border: `1px solid ${PORTAL_DARK.border}`,
    background: filled ? withAlpha(GREEN, 0.06) : "transparent",
  };
}

function btnStyle(borderColor: string, color: string): React.CSSProperties {
  return {
    padding: "5px 11px",
    borderRadius: 6,
    fontSize: 11,
    borderColor,
    background: "transparent",
    color,
  };
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
